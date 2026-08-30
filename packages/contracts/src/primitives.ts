import { z } from "zod";

const utcIsoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const NonEmptyStringSchema = z.string().trim().min(1);

export const UtcIsoTimestampSchema = z
  .string()
  .refine(
    (value) =>
      utcIsoTimestampPattern.test(value) && Number.isFinite(Date.parse(value)),
    "Expected an ISO-8601 UTC timestamp",
  );

export function isExactDurationAfter(
  earlierTimestamp: string,
  laterTimestamp: string,
  durationMs: number,
): boolean {
  return (
    Date.parse(laterTimestamp) - Date.parse(earlierTimestamp) === durationMs
  );
}
