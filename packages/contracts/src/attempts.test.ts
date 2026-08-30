import { describe, expect, it } from "vitest";
import {
  AttemptListResponseSchema,
  AttemptListQuerySchema,
  AttemptReadResponseSchema,
  AttemptStatusSchema,
  AthleteIdentityHeaderSchema,
  CalibrationSessionCreateInputSchema,
  CalibrationSessionReadyInputSchema,
  CalibrationSessionSchema,
  ChallengeListResponseSchema,
  CreateAttemptInputSchema,
  DeleteAttemptResponseSchema,
  HealthResponseSchema,
  MediaUploadAcceptedSchema,
  ReadinessResponseSchema,
} from "./index.js";

describe("attempt creation transport contracts", () => {
  it("accepts the athlete UUID only in the identity header", () => {
    expect(
      AthleteIdentityHeaderSchema.safeParse({
        "x-revelai-athlete-id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      }).success,
    ).toBe(true);

    expect(
      CreateAttemptInputSchema.safeParse({
        mode: "free",
        athleteId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      }).success,
    ).toBe(false);
  });

  it("accepts only the exact free and verified creation branches", () => {
    expect(CreateAttemptInputSchema.safeParse({ mode: "free" }).success).toBe(
      true,
    );
    expect(
      CreateAttemptInputSchema.safeParse({
        mode: "verified",
        challengeId: "wall-pass",
        challengeVersion: 1,
        calibrationSessionId: "calibration-session-1",
      }).success,
    ).toBe(true);
    expect(
      CreateAttemptInputSchema.safeParse({
        mode: "free",
        challengeId: "wall-pass",
      }).success,
    ).toBe(false);
    expect(
      CreateAttemptInputSchema.safeParse({
        mode: "verified",
        challengeId: "wall-pass",
        challengeVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("exposes the six public statuses without an internal tombstone", () => {
    for (const status of [
      "awaiting-upload",
      "uploaded",
      "processing",
      "valid",
      "invalid",
      "failed",
    ]) {
      expect(AttemptStatusSchema.safeParse(status).success).toBe(true);
    }

    expect(AttemptStatusSchema.safeParse("tombstoned").success).toBe(false);
  });

  it("parses the exact calibration creation, readiness, and expiry shape", () => {
    expect(
      CalibrationSessionCreateInputSchema.safeParse({
        challengeId: "wall-pass",
        challengeVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      CalibrationSessionReadyInputSchema.safeParse({
        requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
      }).success,
    ).toBe(true);
    expect(
      CalibrationSessionReadyInputSchema.safeParse({
        requiredGates: ["space", "device", "athlete", "rehearsal", "record"],
      }).success,
    ).toBe(false);
    expect(
      CalibrationSessionSchema.safeParse({
        id: "calibration-session-1",
        challengeId: "wall-pass",
        challengeVersion: 1,
        state: "issued",
        nonce: "1234567890123456789012345678901234567890123",
        issuedAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:15:00.000Z",
        requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
      }).success,
    ).toBe(true);
    expect(
      CalibrationSessionSchema.safeParse({
        id: "calibration-session-1",
        challengeId: "wall-pass",
        challengeVersion: 1,
        state: "issued",
        nonce: "1234567890123456789012345678901234567890123",
        issuedAt: "2026-08-30T12:00:00.000Z",
        expiresAt: "2026-08-30T12:14:59.000Z",
        requiredGates: ["device", "space", "athlete", "rehearsal", "record"],
      }).success,
    ).toBe(false);
  });

  it("enforces attempt-list cursor bounds and the accepted-upload snapshot", () => {
    expect(AttemptListQuerySchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(AttemptListQuerySchema.safeParse({ limit: 50 }).success).toBe(true);
    expect(AttemptListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(AttemptListQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(
      MediaUploadAcceptedSchema.safeParse({
        kind: "media-upload-accepted",
        attemptId: "attempt-1",
        mode: "free",
        acceptedStatus: "uploaded",
        outcome: {
          state: "pending",
          attemptId: "attempt-1",
          mode: "free",
          status: "uploaded",
        },
      }).success,
    ).toBe(true);
  });

  it("parses challenge, history, read, delete, health, and readiness responses", () => {
    expect(
      ChallengeListResponseSchema.safeParse({
        items: [
          {
            id: "wall-pass",
            version: 1,
            sport: "futsal",
            activeDurationSeconds: 60,
            calibrationPreRollSeconds: 4,
            requiredGates: [
              "device",
              "space",
              "athlete",
              "rehearsal",
              "record",
            ],
          },
        ],
      }).success,
    ).toBe(true);
    const summary = {
      id: "attempt-free-1",
      mode: "free",
      status: "awaiting-upload",
      createdAt: "2026-08-30T12:00:00.000Z",
      outcome: {
        state: "pending",
        attemptId: "attempt-free-1",
        mode: "free",
        status: "awaiting-upload",
      },
    };
    expect(
      AttemptListResponseSchema.safeParse({
        items: [summary],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(AttemptReadResponseSchema.safeParse(summary).success).toBe(true);
    expect(
      AttemptReadResponseSchema.safeParse({
        ...summary,
        mediaPath: "/tmp/media",
      }).success,
    ).toBe(false);
    expect(DeleteAttemptResponseSchema.safeParse(undefined).success).toBe(true);
    expect(HealthResponseSchema.safeParse({ status: "ok" }).success).toBe(true);
    expect(ReadinessResponseSchema.safeParse({ status: "ready" }).success).toBe(
      true,
    );
  });
});
