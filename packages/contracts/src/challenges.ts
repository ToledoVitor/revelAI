import { z } from "zod";

export const RequiredGatesSchema = z.tuple([
  z.literal("device"),
  z.literal("space"),
  z.literal("athlete"),
  z.literal("rehearsal"),
  z.literal("record"),
]);

export const CaptureGateSchema = z.enum([
  "device",
  "space",
  "athlete",
  "rehearsal",
  "record",
]);

export const ChallengeSchema = z
  .object({
    id: z.literal("wall-pass"),
    version: z.literal(1),
    sport: z.literal("futsal"),
    activeDurationSeconds: z.literal(60),
    calibrationPreRollSeconds: z.literal(4),
    requiredGates: RequiredGatesSchema,
  })
  .strict();

export const ChallengeListResponseSchema = z
  .object({
    items: z.array(ChallengeSchema),
  })
  .strict();

export type CaptureGate = z.infer<typeof CaptureGateSchema>;
export type RequiredGates = z.infer<typeof RequiredGatesSchema>;
export type Challenge = z.infer<typeof ChallengeSchema>;
export type ChallengeListResponse = z.infer<typeof ChallengeListResponseSchema>;
