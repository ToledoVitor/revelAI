import { FIDUCIAL_CORNER_IDS, type WallPassFrameObservation } from "./types.js";

export type GroundPoint = Readonly<{ x: number; y: number }>;
export type Homography = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type FrameGeometry = Readonly<{
  frameIndex: number;
  valid: boolean;
  homography: Homography | null;
  inverse: Homography | null;
  inlierCount: number;
  medianReprojectionError: number | null;
  maxReprojectionError: number | null;
  wallEdgeError: number | null;
  /** Private capture-orientation facts consumed by C7, never a verdict. */
  orientationValid: boolean;
  wallSideValid: boolean;
  anchorPoints: Readonly<
    Record<(typeof FIDUCIAL_CORNER_IDS)[number], GroundPoint>
  > | null;
}>;

export const WORLD_CORNERS: Readonly<
  Record<(typeof FIDUCIAL_CORNER_IDS)[number], GroundPoint>
> = Object.freeze({
  "a-top-left": Object.freeze({ x: -1.6, y: 2.9 }),
  "a-top-right": Object.freeze({ x: -1.4, y: 2.9 }),
  "a-bottom-right": Object.freeze({ x: -1.4, y: 3.1 }),
  "a-bottom-left": Object.freeze({ x: -1.6, y: 3.1 }),
  "b-top-left": Object.freeze({ x: 1.4, y: 2.9 }),
  "b-top-right": Object.freeze({ x: 1.6, y: 2.9 }),
  "b-bottom-right": Object.freeze({ x: 1.6, y: 3.1 }),
  "b-bottom-left": Object.freeze({ x: 1.4, y: 3.1 }),
});

export function estimateFrameGeometry(
  frame: WallPassFrameObservation,
): FrameGeometry {
  const observed = new Map(
    frame.fiducialCorners.map((corner) => [corner.id, corner]),
  );
  if (observed.size !== frame.fiducialCorners.length || observed.size < 4)
    return invalidGeometry(frame.frameIndex);
  const ids = FIDUCIAL_CORNER_IDS.filter((id) => observed.has(id));
  const pairs = ids.map((id) => ({
    source: observed.get(id)!,
    world: WORLD_CORNERS[id],
  }));
  const candidate = estimateRansacHomography(pairs);
  if (!candidate) return invalidGeometry(frame.frameIndex);
  const { homography, inverse, inlierIndices } = candidate;
  const errors = inlierIndices.map((index) =>
    distance(project(inverse, pairs[index]!.world), pairs[index]!.source),
  );
  const medianReprojectionError = median(errors);
  const maxReprojectionError = Math.max(...errors);
  const edge = frame.wallFloorEdge;
  const wallEdgeError = edge
    ? mean([
        pointLineDistance(
          { x: edge.x1, y: edge.y1 },
          project(inverse, { x: -5, y: 0 }),
          project(inverse, { x: 5, y: 0 }),
        ),
        pointLineDistance(
          { x: edge.x2, y: edge.y2 },
          project(inverse, { x: -5, y: 0 }),
          project(inverse, { x: 5, y: 0 }),
        ),
      ])
    : Number.POSITIVE_INFINITY;
  const inlierIds = inlierIndices.map((index) => ids[index]!);
  const orientationValid = hasExpectedImageOrientation(inverse);
  const wallSideValid = hasExpectedWallSide(
    observed,
    inlierIds,
    frame.wallFloorEdge,
  );
  const valid =
    inlierIndices.length >= 4 &&
    medianReprojectionError <= 4 &&
    maxReprojectionError <= 8 &&
    wallEdgeError <= 8 &&
    orientationValid &&
    wallSideValid;
  if (!valid)
    return invalidGeometry(frame.frameIndex, {
      medianReprojectionError,
      maxReprojectionError,
      wallEdgeError,
      inlierCount: inlierIndices.length,
      orientationValid,
      wallSideValid,
    });
  return Object.freeze({
    frameIndex: frame.frameIndex,
    valid: true,
    homography,
    inverse,
    inlierCount: inlierIndices.length,
    medianReprojectionError,
    maxReprojectionError,
    wallEdgeError,
    anchorPoints: Object.freeze(
      Object.fromEntries(
        FIDUCIAL_CORNER_IDS.map((id) => [
          id,
          project(inverse, WORLD_CORNERS[id]),
        ]),
      ) as Record<(typeof FIDUCIAL_CORNER_IDS)[number], GroundPoint>,
    ),
    orientationValid,
    wallSideValid,
  });
}

export function selectReferenceGeometry(
  frames: readonly FrameGeometry[],
): Readonly<{
  reference: FrameGeometry;
  distances: Readonly<Record<number, number>>;
}> | null {
  const valid = frames.filter((frame) => frame.valid && frame.inverse);
  if (valid.length === 0) return null;
  const distances = new Map<number, number>();
  for (const candidate of valid) {
    const sum = valid.reduce(
      (total, other) => total + anchorMedianDistance(candidate, other),
      0,
    );
    distances.set(candidate.frameIndex, sum);
  }
  const reference = [...valid].sort(
    (left, right) =>
      distances.get(left.frameIndex)! - distances.get(right.frameIndex)! ||
      left.frameIndex - right.frameIndex,
  )[0]!;
  return Object.freeze({
    reference,
    distances: Object.freeze(Object.fromEntries(distances)),
  });
}

export function anchorMedianDistance(
  left: FrameGeometry,
  right: FrameGeometry,
): number {
  if (!left.anchorPoints || !right.anchorPoints)
    return Number.POSITIVE_INFINITY;
  return median(
    FIDUCIAL_CORNER_IDS.map((id) =>
      distance(left.anchorPoints![id], right.anchorPoints![id]),
    ),
  );
}

export function anchorMaximumDistance(
  left: FrameGeometry,
  right: FrameGeometry,
): number {
  if (!left.anchorPoints || !right.anchorPoints)
    return Number.POSITIVE_INFINITY;
  return Math.max(
    ...FIDUCIAL_CORNER_IDS.map((id) =>
      distance(left.anchorPoints![id], right.anchorPoints![id]),
    ),
  );
}

export function project(
  homography: Homography,
  point: GroundPoint,
): GroundPoint {
  const [a, b, c, d, e, f, g, h, i] = homography;
  const denominator = g * point.x + h * point.y + i;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12)
    throw new Error("degenerate homography projection");
  return Object.freeze({
    x: (a * point.x + b * point.y + c) / denominator,
    y: (d * point.x + e * point.y + f) / denominator,
  });
}

export function invertHomography(matrix: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant =
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    return null;
  const inverse: Homography = [
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ];
  return inverse.every(Number.isFinite) ? Object.freeze(inverse) : null;
}

function estimateRansacHomography(
  pairs: readonly Readonly<{ source: GroundPoint; world: GroundPoint }>[],
): Readonly<{
  homography: Homography;
  inverse: Homography;
  inlierIndices: readonly number[];
}> | null {
  if (pairs.length < 4) return null;
  let selected:
    | Readonly<{
        homography: Homography;
        inverse: Homography;
        inlierIndices: readonly number[];
        medianError: number;
        maxError: number;
        sample: readonly number[];
      }>
    | undefined;
  for (const sample of combinationsOfFour(pairs.length)) {
    const homography = solveNormalizedHomography(
      sample.map((index) => pairs[index]!),
    );
    const inverse = homography && invertHomography(homography);
    if (!homography || !inverse) continue;
    const errors = pairs.map((pair) =>
      distance(project(inverse, pair.world), pair.source),
    );
    const inlierIndices = errors
      .map((error, index) => (error <= 8 ? index : -1))
      .filter((index) => index >= 0);
    if (inlierIndices.length < 4) continue;
    const inlierErrors = inlierIndices.map((index) => errors[index]!);
    const next = {
      homography,
      inverse,
      inlierIndices: Object.freeze(inlierIndices),
      medianError: median(inlierErrors),
      maxError: Math.max(...inlierErrors),
      sample,
    };
    if (!selected || isBetterRansacCandidate(next, selected)) selected = next;
  }
  if (!selected) return null;
  const refinedHomography = solveNormalizedHomography(
    selected.inlierIndices.map((index) => pairs[index]!),
  );
  const refinedInverse =
    refinedHomography && invertHomography(refinedHomography);
  if (!refinedHomography || !refinedInverse) return null;
  const refinedErrors = pairs.map((pair) =>
    distance(project(refinedInverse, pair.world), pair.source),
  );
  const inlierIndices = refinedErrors
    .map((error, index) => (error <= 8 ? index : -1))
    .filter((index) => index >= 0);
  if (inlierIndices.length < 4) return null;
  return Object.freeze({
    homography: refinedHomography,
    inverse: refinedInverse,
    inlierIndices: Object.freeze(inlierIndices),
  });
}

function solveNormalizedHomography(
  pairs: readonly Readonly<{ source: GroundPoint; world: GroundPoint }>[],
): Homography | null {
  if (pairs.length < 4) return null;
  const sourceNormalization = normalizePoints(pairs.map((pair) => pair.source));
  const worldNormalization = normalizePoints(pairs.map((pair) => pair.world));
  if (!sourceNormalization || !worldNormalization) return null;
  const normal = Array.from({ length: 8 }, () => Array<number>(9).fill(0));
  for (const [index] of pairs.entries()) {
    const source = sourceNormalization.points[index]!;
    const world = worldNormalization.points[index]!;
    const x = source.x;
    const y = source.y;
    const X = world.x;
    const Y = world.y;
    for (const row of [
      [x, y, 1, 0, 0, 0, -x * X, -y * X, X],
      [0, 0, 0, x, y, 1, -x * Y, -y * Y, Y],
    ]) {
      for (let left = 0; left < 8; left += 1)
        for (let right = 0; right < 9; right += 1)
          normal[left]![right]! += row[left]! * row[right]!;
    }
  }
  const solution = solveLinearSystem(normal);
  if (!solution) return null;
  const normalized: Homography = [
    solution[0]!,
    solution[1]!,
    solution[2]!,
    solution[3]!,
    solution[4]!,
    solution[5]!,
    solution[6]!,
    solution[7]!,
    1,
  ];
  const inverseWorldNormalization = invertHomography(worldNormalization.matrix);
  if (!inverseWorldNormalization) return null;
  return normalizeHomography(
    multiplyHomography(
      inverseWorldNormalization,
      multiplyHomography(normalized, sourceNormalization.matrix),
    ),
  );
}

function solveLinearSystem(matrix: number[][]): readonly number[] | null {
  for (let pivot = 0; pivot < 8; pivot += 1) {
    let row = pivot;
    for (let candidate = pivot + 1; candidate < 8; candidate += 1)
      if (Math.abs(matrix[candidate]![pivot]!) > Math.abs(matrix[row]![pivot]!))
        row = candidate;
    if (Math.abs(matrix[row]![pivot]!) < 1e-12) return null;
    [matrix[pivot], matrix[row]] = [matrix[row]!, matrix[pivot]!];
    const divisor = matrix[pivot]![pivot]!;
    for (let index = pivot; index <= 8; index += 1)
      matrix[pivot]![index]! /= divisor;
    for (let target = 0; target < 8; target += 1) {
      if (target === pivot) continue;
      const factor = matrix[target]![pivot]!;
      for (let index = pivot; index <= 8; index += 1)
        matrix[target]![index]! -= factor * matrix[pivot]![index]!;
    }
  }
  return Object.freeze(matrix.map((row) => row[8]!));
}

function normalizePoints(
  points: readonly GroundPoint[],
): Readonly<{ matrix: Homography; points: readonly GroundPoint[] }> | null {
  const centre: { x: number; y: number } = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  centre.x /= points.length;
  centre.y /= points.length;
  const meanDistance = mean(points.map((point) => distance(point, centre)));
  if (!Number.isFinite(meanDistance) || meanDistance <= 1e-12) return null;
  const scale = Math.SQRT2 / meanDistance;
  const matrix: Homography = [
    scale,
    0,
    -scale * centre.x,
    0,
    scale,
    -scale * centre.y,
    0,
    0,
    1,
  ];
  return Object.freeze({
    matrix: Object.freeze(matrix),
    points: Object.freeze(points.map((point) => project(matrix, point))),
  });
}

function multiplyHomography(left: Homography, right: Homography): Homography {
  const values = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    return (
      left[row * 3]! * right[column]! +
      left[row * 3 + 1]! * right[column + 3]! +
      left[row * 3 + 2]! * right[column + 6]!
    );
  });
  return Object.freeze([
    values[0]!,
    values[1]!,
    values[2]!,
    values[3]!,
    values[4]!,
    values[5]!,
    values[6]!,
    values[7]!,
    values[8]!,
  ]);
}

function normalizeHomography(matrix: Homography): Homography | null {
  const scale = matrix[8];
  if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) return null;
  const normalized: Homography = [
    matrix[0] / scale,
    matrix[1] / scale,
    matrix[2] / scale,
    matrix[3] / scale,
    matrix[4] / scale,
    matrix[5] / scale,
    matrix[6] / scale,
    matrix[7] / scale,
    1,
  ];
  return normalized.every(Number.isFinite) ? Object.freeze(normalized) : null;
}

function* combinationsOfFour(length: number): Iterable<readonly number[]> {
  for (let first = 0; first < length - 3; first += 1)
    for (let second = first + 1; second < length - 2; second += 1)
      for (let third = second + 1; third < length - 1; third += 1)
        for (let fourth = third + 1; fourth < length; fourth += 1)
          yield Object.freeze([first, second, third, fourth]);
}

function isBetterRansacCandidate(
  left: Readonly<{
    inlierIndices: readonly number[];
    medianError: number;
    maxError: number;
    sample: readonly number[];
  }>,
  right: Readonly<{
    inlierIndices: readonly number[];
    medianError: number;
    maxError: number;
    sample: readonly number[];
  }>,
): boolean {
  if (left.inlierIndices.length !== right.inlierIndices.length)
    return left.inlierIndices.length > right.inlierIndices.length;
  if (left.medianError !== right.medianError)
    return left.medianError < right.medianError;
  if (left.maxError !== right.maxError) return left.maxError < right.maxError;
  return left.sample.some(
    (index, position) =>
      index !== right.sample[position] && index < right.sample[position]!,
  );
}

function hasExpectedImageOrientation(inverse: Homography): boolean {
  try {
    // Source-display coordinates use +X right and +Y away from the wall. A
    // mirrored label projection reverses this known challenge orientation.
    const origin = project(inverse, { x: 0, y: 2 });
    const xAxis = project(inverse, { x: 0.1, y: 2 });
    const yAxis = project(inverse, { x: 0, y: 2.1 });
    const signedArea =
      (xAxis.x - origin.x) * (yAxis.y - origin.y) -
      (xAxis.y - origin.y) * (yAxis.x - origin.x);
    return Number.isFinite(signedArea) && signedArea > 1e-9;
  } catch {
    return false;
  }
}

function hasExpectedWallSide(
  observed: ReadonlyMap<string, Readonly<{ x: number; y: number }>>,
  inlierIds: readonly (typeof FIDUCIAL_CORNER_IDS)[number][],
  edge: WallPassFrameObservation["wallFloorEdge"],
): boolean {
  if (!edge || Math.abs(edge.x2 - edge.x1) < 1e-9) return false;
  const start =
    edge.x1 <= edge.x2
      ? { x: edge.x1, y: edge.y1 }
      : { x: edge.x2, y: edge.y2 };
  const end =
    edge.x1 <= edge.x2
      ? { x: edge.x2, y: edge.y2 }
      : { x: edge.x1, y: edge.y1 };
  // Boards must be on the capture-guide side of the observed wall-floor line:
  // below a left-to-right edge in display-image coordinates. This is distinct
  // from reprojection error and works with any distributed four inliers.
  return inlierIds.every((id) => {
    const point = observed.get(id)!;
    const side =
      (end.x - start.x) * (point.y - start.y) -
      (end.y - start.y) * (point.x - start.x);
    return Number.isFinite(side) && side > 1e-9;
  });
}

function invalidGeometry(
  frameIndex: number,
  values: Partial<
    Omit<
      FrameGeometry,
      "frameIndex" | "valid" | "homography" | "inverse" | "anchorPoints"
    >
  > = {},
): FrameGeometry {
  return Object.freeze({
    frameIndex,
    valid: false,
    homography: null,
    inverse: null,
    inlierCount: values.inlierCount ?? 0,
    medianReprojectionError: values.medianReprojectionError ?? null,
    maxReprojectionError: values.maxReprojectionError ?? null,
    wallEdgeError: values.wallEdgeError ?? null,
    orientationValid: values.orientationValid ?? false,
    wallSideValid: values.wallSideValid ?? false,
    anchorPoints: null,
  });
}

function distance(left: GroundPoint, right: GroundPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pointLineDistance(
  point: GroundPoint,
  start: GroundPoint,
  end: GroundPoint,
): number {
  const length = distance(start, end);
  if (length < 1e-12) return Number.POSITIVE_INFINITY;
  return (
    Math.abs(
      (end.y - start.y) * point.x -
        (end.x - start.x) * point.y +
        end.x * start.y -
        end.y * start.x,
    ) / length
  );
}
