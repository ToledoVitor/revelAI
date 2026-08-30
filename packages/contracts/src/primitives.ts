import { z } from "zod";

const utcIsoTimestampPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/;

export const NonEmptyStringSchema = z.string().trim().min(1);

export const UtcIsoTimestampSchema = z.string().refine((value) => {
  const match = utcIsoTimestampPattern.exec(value);

  if (match === null) {
    return false;
  }

  const canonicalValue = `${match[1]}.${match[2] ?? "000"}Z`;
  const date = new Date(canonicalValue);

  return (
    Number.isFinite(date.getTime()) && date.toISOString() === canonicalValue
  );
}, "Expected an ISO-8601 UTC timestamp");

export type UtcIsoTimestamp = z.infer<typeof UtcIsoTimestampSchema>;

export function isExactDurationAfter(
  earlierTimestamp: string,
  laterTimestamp: string,
  durationMs: number,
): boolean {
  return (
    Date.parse(laterTimestamp) - Date.parse(earlierTimestamp) === durationMs
  );
}
