import {
  FreeDemoAnalysisProvenanceSchema,
  FreeRoboflowAnalysisProvenanceSchema,
  VerifiedDemoAnalysisProvenanceSchema,
  VerifiedRoboflowAnalysisProvenanceSchema,
} from "@revelai/contracts";
import { z } from "zod";

const finite = z.number().finite();
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const confidence = finite.min(0).max(1);
const nonEmpty = z.string().min(1);

export const FIDUCIAL_CORNER_IDS = [
  "a-top-left",
  "a-top-right",
  "a-bottom-right",
  "a-bottom-left",
  "b-top-left",
  "b-top-right",
  "b-bottom-right",
  "b-bottom-left",
] as const;

export const FiducialCornerIdSchema = z.enum(FIDUCIAL_CORNER_IDS);

export const SourceFrameSchema = z
  .object({
    index: nonNegativeInteger,
    timestampMs: nonNegativeInteger,
    sourceWidth: positiveInteger,
    sourceHeight: positiveInteger,
    jpeg: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0),
  })
  .strict();

const ChallengeSchema = z
  .object({ id: z.literal("wall-pass"), version: z.literal(1) })
  .strict();

export const VerifiedVisionFrameRequestSchema = z
  .object({
    kind: z.literal("verified-wall-pass"),
    attemptId: z.string().uuid(),
    challenge: ChallengeSchema,
    frame: SourceFrameSchema,
  })
  .strict();

export const FreeVisionFrameRequestSchema = z
  .object({
    kind: z.literal("free-training"),
    attemptId: z.string().uuid(),
    frame: SourceFrameSchema,
  })
  .strict();

export const VisionFrameRequestSchema = z.discriminatedUnion("kind", [
  VerifiedVisionFrameRequestSchema,
  FreeVisionFrameRequestSchema,
]);

export const BoxSchema = z
  .object({
    xMin: finite,
    yMin: finite,
    xMax: finite,
    yMax: finite,
    confidence,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.xMin >= value.xMax)
      context.addIssue({ code: "custom", message: "xMin must precede xMax" });
    if (value.yMin >= value.yMax)
      context.addIssue({ code: "custom", message: "yMin must precede yMax" });
    if (
      value.xMin < 0 ||
      value.yMin < 0 ||
      value.xMax > 1280 ||
      value.yMax > 720
    )
      context.addIssue({
        code: "custom",
        message: "box outside inference image",
      });
  });

const PointSchema = z
  .object({ x: finite.min(0).max(1280), y: finite.min(0).max(720), confidence })
  .strict();

const InferenceImageSchema = z
  .object({
    width: z.literal(1280),
    height: z.literal(720),
    coordinateSystem: z.literal("inference_pixels"),
  })
  .strict();

const WorkflowSchema = z
  .object({
    id: z.enum(["revelai-free-training-v1", "revelai-wall-pass-geometry-v1"]),
    version: z.literal("1.0.0"),
    modelBundleId: nonEmpty,
    providerVersion: nonEmpty,
  })
  .strict();

const DetectionSchema = z
  .object({ class: z.enum(["athlete", "ball"]), ...BoxSchema.shape })
  .strict();

const FreeWorkflowOutputSchema = z
  .object({
    kind: z.literal("free-training-v1"),
    image: InferenceImageSchema,
    workflow: WorkflowSchema.extend({
      id: z.literal("revelai-free-training-v1"),
    }).strict(),
    detections: z.array(DetectionSchema),
  })
  .strict();

const WallPassWorkflowOutputSchema = z
  .object({
    kind: z.literal("wall-pass-geometry-v1"),
    image: InferenceImageSchema,
    workflow: WorkflowSchema.extend({
      id: z.literal("revelai-wall-pass-geometry-v1"),
    }).strict(),
    detections: z.array(DetectionSchema),
    keypoints: z.array(
      PointSchema.extend({
        class: z.enum(["left_foot", "right_foot"]),
      }).strict(),
    ),
    fiducials: z.array(
      PointSchema.extend({ class: FiducialCornerIdSchema }).strict(),
    ),
    geometry: z
      .object({
        wallFloorEdge: z
          .object({
            x1: finite.min(0).max(1280),
            y1: finite.min(0).max(720),
            x2: finite.min(0).max(1280),
            y2: finite.min(0).max(720),
            confidence,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const WorkflowEnvelopeSchema = z
  .object({
    outputs: z.tuple([
      z.discriminatedUnion("kind", [
        FreeWorkflowOutputSchema,
        WallPassWorkflowOutputSchema,
      ]),
    ]),
  })
  .strict();

const SourceBoxSchema = z
  .object({
    xMin: finite,
    yMin: finite,
    xMax: finite,
    yMax: finite,
    confidence,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.xMin >= value.xMax || value.yMin >= value.yMax)
      context.addIssue({ code: "custom", message: "source box has no area" });
  });

const SourcePointSchema = z
  .object({ x: finite, y: finite, confidence })
  .strict();

/** Private binding between an observation and its owned inference pixels. */
export const InferenceFrameBindingSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    transform: z
      .object({
        sourceWidth: positiveInteger,
        sourceHeight: positiveInteger,
        inferenceWidth: z.literal(1280),
        inferenceHeight: z.literal(720),
        scale: finite.positive(),
        scaledWidth: positiveInteger.max(1280),
        scaledHeight: positiveInteger.max(720),
        padLeft: nonNegativeInteger,
        padTop: nonNegativeInteger,
      })
      .strict()
      .superRefine((value, context) => {
        const scale = Math.min(
          1280 / value.sourceWidth,
          720 / value.sourceHeight,
        );
        const scaledWidth = Math.floor(value.sourceWidth * scale + 0.5);
        const scaledHeight = Math.floor(value.sourceHeight * scale + 0.5);
        const padLeft = Math.floor((1280 - scaledWidth) / 2);
        const padTop = Math.floor((720 - scaledHeight) / 2);
        if (
          value.scale !== scale ||
          value.scaledWidth !== scaledWidth ||
          value.scaledHeight !== scaledHeight ||
          value.padLeft !== padLeft ||
          value.padTop !== padTop
        )
          context.addIssue({
            code: "custom",
            message: "inference transform does not match source dimensions",
          });
        if (value.padLeft * 2 + value.scaledWidth > 1280)
          context.addIssue({
            code: "custom",
            message: "invalid inference horizontal padding",
          });
        if (value.padTop * 2 + value.scaledHeight > 720)
          context.addIssue({
            code: "custom",
            message: "invalid inference vertical padding",
          });
      }),
  })
  .strict();

const FreeFrameObservationBaseSchema = z.object({
  kind: z.literal("free-training"),
  frameIndex: nonNegativeInteger,
  timestampMs: nonNegativeInteger,
  sourceWidth: positiveInteger,
  sourceHeight: positiveInteger,
  athlete: SourceBoxSchema.optional(),
  ball: SourceBoxSchema.optional(),
});

const WallPassFrameObservationBaseSchema = z.object({
  kind: z.literal("verified-wall-pass"),
  frameIndex: nonNegativeInteger,
  timestampMs: nonNegativeInteger,
  sourceWidth: positiveInteger,
  sourceHeight: positiveInteger,
  athlete: SourceBoxSchema.optional(),
  ball: SourceBoxSchema.optional(),
  feet: z.array(
    SourcePointSchema.extend({ side: z.enum(["left", "right"]) }).strict(),
  ),
  fiducialCorners: z.array(
    SourcePointSchema.extend({ id: FiducialCornerIdSchema }).strict(),
  ),
  wallFloorEdge: z
    .object({ x1: finite, y1: finite, x2: finite, y2: finite, confidence })
    .strict()
    .optional(),
});

export const FreeFrameObservationSchema = refineFreeFrame(
  FreeFrameObservationBaseSchema.extend({
    inference: InferenceFrameBindingSchema.optional(),
  }).strict(),
);

const DemoFreeFrameObservationSchema = refineFreeFrame(
  FreeFrameObservationBaseSchema.extend({
    inference: z.never().optional(),
  }).strict(),
);

const RoboflowFreeFrameObservationSchema = refineFreeFrame(
  FreeFrameObservationBaseSchema.extend({
    inference: InferenceFrameBindingSchema,
  }).strict(),
);

export const WallPassFrameObservationSchema = refineWallPassFrame(
  WallPassFrameObservationBaseSchema.extend({
    inference: InferenceFrameBindingSchema.optional(),
  }).strict(),
);

const DemoWallPassFrameObservationSchema = refineWallPassFrame(
  WallPassFrameObservationBaseSchema.extend({
    inference: z.never().optional(),
  }).strict(),
);

const RoboflowWallPassFrameObservationSchema = refineWallPassFrame(
  WallPassFrameObservationBaseSchema.extend({
    inference: InferenceFrameBindingSchema,
  }).strict(),
);

const FreeDemoVisionObservationBatchSchema = z
  .object({
    attemptId: z.string().uuid(),
    kind: z.literal("free-training"),
    frames: z.array(DemoFreeFrameObservationSchema),
    provenance: FreeDemoAnalysisProvenanceSchema,
  })
  .strict();

const FreeRoboflowVisionObservationBatchSchema = z
  .object({
    attemptId: z.string().uuid(),
    kind: z.literal("free-training"),
    frames: z.array(RoboflowFreeFrameObservationSchema),
    provenance: FreeRoboflowAnalysisProvenanceSchema,
  })
  .strict();

export const FreeVisionObservationBatchSchema = z.union([
  FreeDemoVisionObservationBatchSchema,
  FreeRoboflowVisionObservationBatchSchema,
]);

const VerifiedDemoVisionObservationBatchSchema = z
  .object({
    attemptId: z.string().uuid(),
    kind: z.literal("verified-wall-pass"),
    frames: z.array(DemoWallPassFrameObservationSchema),
    provenance: VerifiedDemoAnalysisProvenanceSchema,
  })
  .strict();

const VerifiedRoboflowVisionObservationBatchSchema = z
  .object({
    attemptId: z.string().uuid(),
    kind: z.literal("verified-wall-pass"),
    frames: z.array(RoboflowWallPassFrameObservationSchema),
    provenance: VerifiedRoboflowAnalysisProvenanceSchema,
  })
  .strict();

export const VerifiedVisionObservationBatchSchema = z.union([
  VerifiedDemoVisionObservationBatchSchema,
  VerifiedRoboflowVisionObservationBatchSchema,
]);

export const VisionObservationBatchSchema = z.union([
  FreeVisionObservationBatchSchema,
  VerifiedVisionObservationBatchSchema,
]);

export type SourceFrame = z.infer<typeof SourceFrameSchema>;
export type VerifiedVisionFrameRequest = z.infer<
  typeof VerifiedVisionFrameRequestSchema
>;
export type FreeVisionFrameRequest = z.infer<
  typeof FreeVisionFrameRequestSchema
>;
export type VisionFrameRequest = z.infer<typeof VisionFrameRequestSchema>;
export type WorkflowEnvelope = z.infer<typeof WorkflowEnvelopeSchema>;
export type FreeFrameObservation = z.infer<typeof FreeFrameObservationSchema>;
export type WallPassFrameObservation = z.infer<
  typeof WallPassFrameObservationSchema
>;
export type InferenceFrameBinding = z.infer<typeof InferenceFrameBindingSchema>;
export type FreeVisionObservationBatch = z.infer<
  typeof FreeVisionObservationBatchSchema
>;
export type VerifiedVisionObservationBatch = z.infer<
  typeof VerifiedVisionObservationBatchSchema
>;
export type VisionObservationBatch = z.infer<
  typeof VisionObservationBatchSchema
>;

function refineFreeFrame<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((value, context) => {
    const frame = value as never as InferenceBoundFrame;
    assertSourceGeometry(frame, context);
    assertInferenceMatchesFrame(frame, context);
  }) as T;
}

function refineWallPassFrame<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((value, context) => {
    const frame = value as never as InferenceBoundFrame &
      Readonly<{
        sourceWidth: number;
        sourceHeight: number;
        athlete?: z.infer<typeof SourceBoxSchema>;
        ball?: z.infer<typeof SourceBoxSchema>;
        feet: readonly Record<string, unknown>[];
        fiducialCorners: readonly Record<string, unknown>[];
        wallFloorEdge?: Record<string, unknown>;
      }>;
    assertSourceGeometry(frame, context);
    assertInferenceMatchesFrame(frame, context);
    for (const [index, foot] of frame.feet.entries())
      assertSourcePoint(foot, frame, context, ["feet", index]);
    for (const [index, corner] of frame.fiducialCorners.entries())
      assertSourcePoint(corner, frame, context, ["fiducialCorners", index]);
    if (frame.wallFloorEdge) {
      assertSourcePoint(
        frame.wallFloorEdge,
        frame,
        context,
        ["wallFloorEdge"],
        "x1",
        "y1",
      );
      assertSourcePoint(
        frame.wallFloorEdge,
        frame,
        context,
        ["wallFloorEdge"],
        "x2",
        "y2",
      );
    }
  }) as T;
}

type InferenceBoundFrame = Readonly<{
  sourceWidth: number;
  sourceHeight: number;
  inference?: Readonly<{
    transform: Readonly<{ sourceWidth: number; sourceHeight: number }>;
  }>;
}>;

function assertInferenceMatchesFrame(
  frame: InferenceBoundFrame,
  context: z.RefinementCtx,
): void {
  if (
    frame.inference &&
    (frame.inference.transform.sourceWidth !== frame.sourceWidth ||
      frame.inference.transform.sourceHeight !== frame.sourceHeight)
  )
    context.addIssue({
      code: "custom",
      path: ["inference", "transform"],
      message: "inference transform source dimensions do not match frame",
    });
}

function assertSourceGeometry(
  frame: Readonly<{
    sourceWidth: number;
    sourceHeight: number;
    athlete?: z.infer<typeof SourceBoxSchema>;
    ball?: z.infer<typeof SourceBoxSchema>;
  }>,
  context: z.RefinementCtx,
): void {
  for (const key of ["athlete", "ball"] as const) {
    const box = frame[key];
    if (
      box &&
      (box.xMin < 0 ||
        box.yMin < 0 ||
        box.xMax > frame.sourceWidth ||
        box.yMax > frame.sourceHeight)
    )
      context.addIssue({
        code: "custom",
        path: [key],
        message: "source box outside frame dimensions",
      });
  }
}

function assertSourcePoint(
  point: Record<string, unknown>,
  frame: Readonly<{ sourceWidth: number; sourceHeight: number }>,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  xKey = "x",
  yKey = "y",
): void {
  const x = point[xKey];
  const y = point[yKey];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    x < 0 ||
    x > frame.sourceWidth ||
    y < 0 ||
    y > frame.sourceHeight
  )
    context.addIssue({
      code: "custom",
      path: [...path],
      message: "source point outside frame dimensions",
    });
}
