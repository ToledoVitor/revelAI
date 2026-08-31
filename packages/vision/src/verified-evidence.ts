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

export type VerifiedEvidenceBinding = Readonly<{
  attemptId: string;
  generation: number;
  mediaId: string;
  mediaSha256: string;
  rawPreRollSha256: string;
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
  }>[];
  active: readonly Readonly<{
    frameIndex: number;
    stable: boolean;
    geometry: FrameGeometry;
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
}>;

export function assembleVerifiedEvidence(
  input: Readonly<{
    batch: VerifiedVisionObservationBatch;
    binding: VerifiedEvidenceBinding;
  }>,
): VerifiedObservationEvidence {
  const batch = VerifiedVisionObservationBatchSchema.parse(input.batch);
  if (batch.attemptId !== input.binding.attemptId)
    throw new Error("cross-attempt verified evidence");
  const ordered = [...batch.frames].sort(
    (left, right) => left.frameIndex - right.frameIndex,
  );
  const preRollFrames = ordered.slice(0, 40);
  const preRoll = preRollFrames.map((frame) => {
    const geometry = estimateFrameGeometry(frame);
    return Object.freeze({
      frameIndex: frame.frameIndex,
      confidencePresent: hasCalibrationConfidence(frame),
      geometry,
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
  const contactCandidates = collectContacts(active, activeFrames);
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
    ballTracks.flat(),
  );
  return Object.freeze({
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
  });
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
) {
  const candidates: Array<
    Readonly<{
      timestampMs: number;
      side: "left" | "right";
      point: GroundPoint;
      confidence: number;
    }>
  > = [];
  for (let index = 0; index < active.length; index += 1) {
    const evidence = active[index]!;
    const frame = frames[index]!;
    if (!evidence.usableTracks || !evidence.mappedBall) continue;
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
) {
  const segments: Array<
    Array<Readonly<{ timestampMs: number; point: GroundPoint }>>
  > = [];
  for (let index = 0; index < active.length; index += 1) {
    const point = active[index]!.mappedBall;
    if (!point) continue;
    const sample = Object.freeze({
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
  return segments.map((segment) => Object.freeze(segment));
}

function collectWallImpacts(
  tracks: readonly (readonly Readonly<{
    timestampMs: number;
    point: GroundPoint;
  }>[])[],
) {
  const impacts: Array<Readonly<{ timestampMs: number; point: GroundPoint }>> =
    [];
  for (const track of tracks)
    for (let index = 1; index + 1 < track.length; index += 1) {
      const previous = track[index - 1]!;
      const current = track[index]!;
      const next = track[index + 1]!;
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
  }>[],
  wallImpacts: readonly Readonly<{ timestampMs: number; point: GroundPoint }>[],
  trackedBalls: readonly Readonly<{
    timestampMs: number;
    point: GroundPoint;
  }>[],
) {
  const evidence: Array<VerifiedObservationEvidence["passEvidence"][number]> =
    [];
  for (const contact of contacts) {
    const outbound = trackedBalls.some(
      (ball) =>
        ball.timestampMs > contact.timestampMs &&
        ball.timestampMs - contact.timestampMs <= 700 &&
        contact.point.y - ball.point.y >= 0.25,
    );
    if (!outbound) continue;
    const wall = wallImpacts.find(
      (impact) =>
        impact.timestampMs - contact.timestampMs >= 200 &&
        impact.timestampMs - contact.timestampMs <= 2000,
    );
    const completed = wall
      ? contacts.find(
          (next) =>
            next.timestampMs > contact.timestampMs &&
            next.timestampMs - wall.timestampMs >= 200 &&
            next.timestampMs - wall.timestampMs <= 4000,
        )
      : undefined;
    evidence.push(
      completed && wall
        ? Object.freeze({
            kind: "complete" as const,
            startedAtMs: contact.timestampMs,
            wallImpactAtMs: wall.timestampMs,
            completedAtMs: completed.timestampMs,
            side: contact.side,
          })
        : Object.freeze({
            kind: "missed" as const,
            startedAtMs: contact.timestampMs,
            deadlineAtMs: contact.timestampMs + 4000,
            side: contact.side,
          }),
    );
  }
  return evidence;
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
