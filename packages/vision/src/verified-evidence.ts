import {
  anchorMaximumDistance,
  anchorMedianDistance,
  estimateFrameGeometry,
  project,
  selectReferenceGeometry,
  type FrameGeometry,
  type GroundPoint,
} from "./geometry.js";
import {
  type VerifiedVisionObservationBatch,
  VerifiedVisionObservationBatchSchema,
} from "./types.js";

const CALIBRATION_CONFIDENCE = 0.8;
const TRACKING_CONFIDENCE = 0.7;
const FOOT_CONFIDENCE = 0.65;

type CanonicalScoreEvidence = Readonly<{
  contacts: readonly Readonly<{
    timestampMs: number;
    side: "left" | "right";
    sideConfidence: number;
    outbound:
      | Readonly<{ kind: "not-outbound" }>
      | Readonly<{
          kind: "outbound";
          movementTowardWallMeters: number;
          observedWithinMs: number;
        }>;
  }>[];
  wallImpacts: readonly Readonly<{ timestampMs: number; confidence: number }>[];
}>;

export type VerifiedEvidenceBinding = Readonly<{
  attemptId: string;
  generation: number;
  mediaId: string;
  mediaSha256: string;
  rawPreRollSha256: string;
  calibrationSessionId: string;
  calibrationNonce: string;
  /** C5's immutable identity for the exact decoded extraction. */
  extractionVersion?: "c5-frame-manifest-v1";
  extractionIdentity?: string;
}>;

export type VerifiedObservationEvidence = Readonly<{
  kind: "wall-pass-geometry-evidence-v1";
  binding: VerifiedEvidenceBinding;
  provenance: VerifiedVisionObservationBatch["provenance"];
  selectedReferenceFrameIndex: number | null;
  referenceDistanceSums: Readonly<Record<number, number>>;
  preRoll: readonly Readonly<{
    frameIndex: number;
    confidencePresent: boolean;
    geometry: FrameGeometry;
    inference: VerifiedVisionObservationBatch["frames"][number]["inference"];
  }>[];
  active: readonly Readonly<{
    frameIndex: number;
    stable: boolean;
    geometry: FrameGeometry;
    inference: VerifiedVisionObservationBatch["frames"][number]["inference"];
    anchorMedianDrift: number | null;
    anchorMaximumDrift: number | null;
    mappedBall: GroundPoint | null;
    mappedFeet: readonly Readonly<{
      side: "left" | "right";
      point: GroundPoint;
      confidence: number;
    }>[];
    usableTracks: boolean;
  }>[];
  activeStableCount: number;
  longestUnstableRun: number;
  contacts: readonly Readonly<{
    timestampMs: number;
    side: "left" | "right";
    point: GroundPoint;
  }>[];
  wallImpacts: readonly Readonly<{ timestampMs: number; point: GroundPoint }>[];
  passEvidence: readonly (
    | Readonly<{
        kind: "complete";
        startedAtMs: number;
        wallImpactAtMs: number;
        completedAtMs: number;
        side: "left" | "right";
      }>
    | Readonly<{
        kind: "missed";
        startedAtMs: number;
        deadlineAtMs: number;
        side: "left" | "right";
      }>
  )[];
  /** C6-produced, ordered score input. C7 never accepts caller-authored rows. */
  canonicalEvents: CanonicalScoreEvidence;
  eventGraph: readonly Readonly<{
    kind: "contact" | "wall-impact";
    timestampMs: number;
    frameIndex: number;
    trackId: number;
    homographyFrameIndex: number;
  }>[];
}>;

const assembledEvidence = new WeakSet<object>();

/** Runtime capability check used by the API integrity boundary. */
export function isAssembledVerifiedEvidence(
  value: unknown,
): value is VerifiedObservationEvidence {
  return (
    typeof value === "object" && value !== null && assembledEvidence.has(value)
  );
}

export function assembleVerifiedEvidence(
  input: Readonly<{
    batch: VerifiedVisionObservationBatch;
    binding: VerifiedEvidenceBinding;
  }>,
): VerifiedObservationEvidence {
  const batch = VerifiedVisionObservationBatchSchema.parse(input.batch);
  assertVerifiedBinding(input.binding);
  if (batch.attemptId !== input.binding.attemptId)
    throw new Error("cross-attempt verified evidence");
  // Correlation is meaningful only in the producer-supplied sequence. Sorting
  // would silently repair a mismatched frame/observation batch.
  const ordered = batch.frames;
  assertVerifiedTimeline(ordered);
  const preRollFrames = ordered.slice(0, 40);
  const preRoll = preRollFrames.map((frame) => {
    const geometry = estimateFrameGeometry(frame);
    return Object.freeze({
      frameIndex: frame.frameIndex,
      confidencePresent: hasCalibrationConfidence(frame),
      geometry,
      inference: frame.inference,
    });
  });
  const reference = selectReferenceGeometry(
    preRoll
      .filter((frame) => frame.confidencePresent && frame.geometry.valid)
      .map((frame) => frame.geometry),
  );
  const active = ordered
    .slice(40)
    .map((frame) => activeEvidence(frame, reference?.reference ?? null));
  const activeFrames = ordered.slice(40);
  const ballTracks = collectBallTrackSegments(active, activeFrames);
  const contactCandidates = collectContacts(active, activeFrames, ballTracks);
  const contacts = contactCandidates.map((contact) =>
    Object.freeze({
      timestampMs: contact.timestampMs,
      side: contact.side,
      point: contact.point,
    }),
  );
  const wallImpacts = collectWallImpacts(ballTracks);
  const passEvidence = collectPassEvidence(
    contactCandidates,
    wallImpacts,
    ballTracks,
  );
  const canonicalEvents = Object.freeze({
    contacts: Object.freeze(
      contactCandidates.map((contact) =>
        Object.freeze({
          timestampMs: contact.timestampMs,
          side: contact.side,
          sideConfidence: contact.confidence,
          outbound: outboundMovement(ballTracks, contact),
        }),
      ),
    ),
    wallImpacts: Object.freeze(
      wallImpacts.map((impact) =>
        Object.freeze({ timestampMs: impact.timestampMs, confidence: 0.7 }),
      ),
    ),
  });
  const result: VerifiedObservationEvidence = Object.freeze({
    kind: "wall-pass-geometry-evidence-v1",
    binding: Object.freeze({ ...input.binding }),
    provenance: batch.provenance,
    selectedReferenceFrameIndex: reference?.reference.frameIndex ?? null,
    referenceDistanceSums: reference?.distances ?? Object.freeze({}),
    preRoll: Object.freeze(preRoll),
    active: Object.freeze(active),
    activeStableCount: active.filter((frame) => frame.stable).length,
    longestUnstableRun: longestRun(active.map((frame) => !frame.stable)),
    contacts: Object.freeze(contacts),
    wallImpacts: Object.freeze(wallImpacts),
    passEvidence: Object.freeze(passEvidence),
    canonicalEvents,
    eventGraph: Object.freeze(
      [
        ...contactCandidates.map((contact) => {
          const frameIndex = ordered.find(
            (frame) => frame.timestampMs === contact.timestampMs,
          )!.frameIndex;
          return Object.freeze({
            kind: "contact" as const,
            timestampMs: contact.timestampMs,
            frameIndex,
            trackId: contact.trackId,
            homographyFrameIndex: frameIndex,
          });
        }),
        ...wallImpacts.map((impact) => {
          const frameIndex = ordered.find(
            (frame) => frame.timestampMs === impact.timestampMs,
          )!.frameIndex;
          return Object.freeze({
            kind: "wall-impact" as const,
            timestampMs: impact.timestampMs,
            frameIndex,
            trackId: impact.trackId,
            homographyFrameIndex: frameIndex,
          });
        }),
      ].sort((left, right) => left.timestampMs - right.timestampMs),
    ),
  });
  assembledEvidence.add(result);
  return result;
}

function assertVerifiedBinding(binding: VerifiedEvidenceBinding): void {
  if (
    !isUuid(binding.attemptId) ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1 ||
    !isUuid(binding.mediaId) ||
    !isUuid(binding.calibrationSessionId) ||
    !/^[a-f0-9]{64}$/.test(binding.mediaSha256) ||
    !/^[a-f0-9]{64}$/.test(binding.rawPreRollSha256) ||
    !/^[A-Za-z0-9_-]{43}$/.test(binding.calibrationNonce)
  )
    throw new Error("invalid verified evidence binding");
}

function assertVerifiedTimeline(
  frames: readonly VerifiedVisionObservationBatch["frames"][number][],
): void {
  if (frames.length !== 640)
    throw new Error("verified evidence requires exactly 40+600 frames");
  for (const [index, frame] of frames.entries()) {
    const previous = frames[index - 1];
    if (
      frame.frameIndex !== index ||
      (previous &&
        (frame.timestampMs <= previous.timestampMs ||
          frame.timestampMs - previous.timestampMs > 250)) ||
      (index < 40
        ? frame.timestampMs < 0 || frame.timestampMs >= 4000
        : frame.timestampMs < 4000 || frame.timestampMs >= 64_000)
    )
      throw new Error("invalid verified 40+600 timeline");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function activeEvidence(
  frame: VerifiedVisionObservationBatch["frames"][number],
  reference: FrameGeometry | null,
) {
  const geometry = estimateFrameGeometry(frame);
  const confidencePresent = hasCalibrationConfidence(frame);
  const medianDrift =
    reference && geometry.valid
      ? anchorMedianDistance(reference, geometry)
      : null;
  const maximumDrift =
    reference && geometry.valid
      ? anchorMaximumDistance(reference, geometry)
      : null;
  const stable =
    confidencePresent &&
    geometry.valid &&
    medianDrift !== null &&
    medianDrift <= 6 &&
    maximumDrift !== null &&
    maximumDrift <= 12;
  if (!stable || !geometry.homography)
    return Object.freeze({
      frameIndex: frame.frameIndex,
      stable: false,
      geometry,
      inference: frame.inference,
      anchorMedianDrift: medianDrift,
      anchorMaximumDrift: maximumDrift,
      mappedBall: null,
      mappedFeet: Object.freeze([]),
      usableTracks: false,
    });
  const mappedBall =
    frame.ball && frame.ball.confidence >= TRACKING_CONFIDENCE
      ? project(geometry.homography, {
          x: (frame.ball.xMin + frame.ball.xMax) / 2,
          y: frame.ball.yMax,
        })
      : null;
  const mappedFeet = frame.feet
    .filter((foot) => foot.confidence >= FOOT_CONFIDENCE)
    .map((foot) =>
      Object.freeze({
        side: foot.side,
        point: project(geometry.homography!, foot),
        confidence: foot.confidence,
      }),
    );
  return Object.freeze({
    frameIndex: frame.frameIndex,
    stable: true,
    geometry,
    inference: frame.inference,
    anchorMedianDrift: medianDrift,
    anchorMaximumDrift: maximumDrift,
    mappedBall,
    mappedFeet: Object.freeze(mappedFeet),
    usableTracks:
      mappedBall !== null &&
      frame.athlete !== undefined &&
      frame.athlete.confidence >= TRACKING_CONFIDENCE,
  });
}

function hasCalibrationConfidence(
  frame: VerifiedVisionObservationBatch["frames"][number],
): boolean {
  return (
    frame.athlete !== undefined &&
    frame.athlete.confidence >= CALIBRATION_CONFIDENCE &&
    frame.wallFloorEdge !== undefined &&
    frame.wallFloorEdge.confidence >= CALIBRATION_CONFIDENCE &&
    frame.fiducialCorners.length === 8 &&
    frame.fiducialCorners.every(
      (corner) => corner.confidence >= CALIBRATION_CONFIDENCE,
    )
  );
}

function collectContacts(
  active: readonly ReturnType<typeof activeEvidence>[],
  frames: readonly VerifiedVisionObservationBatch["frames"][number][],
  tracks: readonly BallTrack[],
) {
  const candidates: Array<
    Readonly<{
      timestampMs: number;
      side: "left" | "right";
      point: GroundPoint;
      confidence: number;
      trackId: number;
    }>
  > = [];
  for (let index = 0; index < active.length; index += 1) {
    const evidence = active[index]!;
    const frame = frames[index]!;
    if (!evidence.usableTracks || !evidence.mappedBall) continue;
    const ball = findTrackSample(tracks, frame.timestampMs);
    if (!ball) continue;
    const candidate = evidence.mappedFeet
      .filter((foot) => distance(foot.point, evidence.mappedBall!) <= 0.35)
      .sort(
        (left, right) =>
          right.confidence - left.confidence ||
          left.side.localeCompare(right.side),
      )[0];
    if (candidate)
      candidates.push(
        Object.freeze({
          timestampMs: frame.timestampMs,
          side: candidate.side,
          point: evidence.mappedBall,
          confidence: candidate.confidence,
          trackId: ball.trackId,
        }),
      );
  }
  const clusters: (typeof candidates)[] = [];
  for (const candidate of candidates) {
    const latest = clusters.at(-1);
    const prior = latest?.at(-1);
    if (!latest || !prior || candidate.timestampMs - prior.timestampMs > 300)
      clusters.push([candidate]);
    else latest.push(candidate);
  }
  return clusters
    .filter((cluster) => cluster.length >= 2)
    .map((cluster) => {
      const selected = [...cluster].sort(
        (left, right) =>
          right.confidence - left.confidence ||
          left.timestampMs - right.timestampMs ||
          left.side.localeCompare(right.side),
      )[0]!;
      return Object.freeze(selected);
    });
}

function collectBallTrackSegments(
  active: readonly ReturnType<typeof activeEvidence>[],
  frames: readonly VerifiedVisionObservationBatch["frames"][number][],
): readonly BallTrack[] {
  const segments: Array<Array<BallTrackSample>> = [];
  for (let index = 0; index < active.length; index += 1) {
    const point = active[index]!.mappedBall;
    if (!point) continue;
    const sample: BallTrackSample = Object.freeze({
      timestampMs: frames[index]!.timestampMs,
      point,
    });
    const current = segments.at(-1);
    const previous = current?.at(-1);
    if (
      !current ||
      !previous ||
      sample.timestampMs - previous.timestampMs > 300
    )
      segments.push([sample]);
    else current.push(sample);
  }
  return Object.freeze(
    segments.map((samples, trackId) =>
      Object.freeze({ trackId, samples: Object.freeze(samples) }),
    ),
  );
}

function collectWallImpacts(tracks: readonly BallTrack[]) {
  const impacts: WallImpact[] = [];
  for (const track of tracks)
    for (let index = 1; index + 1 < track.samples.length; index += 1) {
      const previous = track.samples[index - 1]!;
      const current = track.samples[index]!;
      const next = track.samples[index + 1]!;
      const arrivesAtWall =
        previous.point.y > current.point.y && current.point.y <= 0.25;
      const reverses =
        next.point.y > current.point.y &&
        next.timestampMs - current.timestampMs <= 500;
      if (arrivesAtWall && reverses)
        impacts.push(
          Object.freeze({
            timestampMs: current.timestampMs,
            point: current.point,
            trackId: track.trackId,
          }),
        );
    }
  return impacts;
}

function collectPassEvidence(
  contacts: readonly Readonly<{
    timestampMs: number;
    side: "left" | "right";
    point: GroundPoint;
    confidence: number;
    trackId: number;
  }>[],
  wallImpacts: readonly WallImpact[],
  tracks: readonly BallTrack[],
) {
  const evidence: Array<VerifiedObservationEvidence["passEvidence"][number]> =
    [];
  for (const track of tracks) {
    const trackContacts = contacts.filter(
      (contact) => contact.trackId === track.trackId,
    );
    const trackImpacts = wallImpacts.filter(
      (impact) => impact.trackId === track.trackId,
    );
    const events = [
      ...trackContacts.map((contact) =>
        Object.freeze({
          kind: "contact" as const,
          timestampMs: contact.timestampMs,
          contact,
        }),
      ),
      ...trackImpacts.map((impact) =>
        Object.freeze({
          kind: "wall" as const,
          timestampMs: impact.timestampMs,
          impact,
        }),
      ),
    ].sort(
      (left, right) =>
        left.timestampMs - right.timestampMs || (left.kind === "wall" ? -1 : 1),
    );
    let pending:
      | Readonly<{
          contact: (typeof trackContacts)[number];
          wallImpactAtMs?: number;
        }>
      | undefined;
    for (const event of events) {
      if (pending && event.timestampMs > pending.contact.timestampMs + 4000) {
        evidence.push(missedPass(pending.contact));
        pending = undefined;
      }
      if (event.kind === "contact") {
        if (pending) {
          if (pending.wallImpactAtMs !== undefined) {
            const elapsed = event.timestampMs - pending.wallImpactAtMs;
            if (elapsed >= 200 && elapsed <= 4000)
              evidence.push(
                Object.freeze({
                  kind: "complete" as const,
                  startedAtMs: pending.contact.timestampMs,
                  wallImpactAtMs: pending.wallImpactAtMs,
                  completedAtMs: event.timestampMs,
                  side: pending.contact.side,
                }),
              );
            else evidence.push(missedPass(pending.contact));
          } else {
            // A distinct contact before the next qualifying wall closes the
            // first opportunity. It may itself begin the next one below.
            evidence.push(missedPass(pending.contact));
          }
          pending = undefined;
        }
        if (!pending && hasOutboundMotion(track, event.contact))
          pending = Object.freeze({ contact: event.contact });
        continue;
      }
      if (!pending || pending.wallImpactAtMs !== undefined) continue;
      const elapsed = event.timestampMs - pending.contact.timestampMs;
      if (elapsed >= 200 && elapsed <= 2000)
        pending = Object.freeze({
          contact: pending.contact,
          wallImpactAtMs: event.timestampMs,
        });
    }
    if (pending) evidence.push(missedPass(pending.contact));
  }
  return evidence;
}

type BallTrackSample = Readonly<{
  timestampMs: number;
  point: GroundPoint;
}>;

type BallTrack = Readonly<{
  trackId: number;
  samples: readonly BallTrackSample[];
}>;

type WallImpact = Readonly<{
  timestampMs: number;
  point: GroundPoint;
  trackId: number;
}>;

function findTrackSample(
  tracks: readonly BallTrack[],
  timestampMs: number,
): (BallTrackSample & Readonly<{ trackId: number }>) | undefined {
  for (const track of tracks) {
    const sample = track.samples.find(
      (candidate) => candidate.timestampMs === timestampMs,
    );
    if (sample) return Object.freeze({ ...sample, trackId: track.trackId });
  }
  return undefined;
}

function hasOutboundMotion(
  track: BallTrack,
  contact: Readonly<{ timestampMs: number; point: GroundPoint }>,
): boolean {
  return track.samples.some(
    (ball) =>
      ball.timestampMs > contact.timestampMs &&
      ball.timestampMs - contact.timestampMs <= 700 &&
      contact.point.y - ball.point.y >= 0.25,
  );
}

function outboundMovement(
  tracks: readonly BallTrack[],
  contact: Readonly<{
    timestampMs: number;
    point: GroundPoint;
    trackId: number;
  }>,
) {
  const track = tracks.find(
    (candidate) => candidate.trackId === contact.trackId,
  );
  const sample = track?.samples.find(
    (ball) =>
      ball.timestampMs > contact.timestampMs &&
      ball.timestampMs - contact.timestampMs <= 700 &&
      contact.point.y - ball.point.y >= 0.25,
  );
  return sample
    ? Object.freeze({
        kind: "outbound" as const,
        movementTowardWallMeters: contact.point.y - sample.point.y,
        observedWithinMs: sample.timestampMs - contact.timestampMs,
      })
    : Object.freeze({ kind: "not-outbound" as const });
}

function missedPass(
  contact: Readonly<{ timestampMs: number; side: "left" | "right" }>,
): VerifiedObservationEvidence["passEvidence"][number] {
  return Object.freeze({
    kind: "missed" as const,
    startedAtMs: contact.timestampMs,
    deadlineAtMs: contact.timestampMs + 4000,
    side: contact.side,
  });
}

function longestRun(values: readonly boolean[]): number {
  let maximum = 0;
  let current = 0;
  for (const value of values) {
    current = value ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function distance(left: GroundPoint, right: GroundPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
