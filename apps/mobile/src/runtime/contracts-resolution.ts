import { AttemptModeSchema } from "@revelai/contracts";

export function resolveContractsOnce(): readonly ["free", "verified"] {
  const modes = ["free", "verified"] as const;

  if (!modes.every((mode) => AttemptModeSchema.safeParse(mode).success)) {
    throw new Error(
      "The contracts package did not resolve the accepted attempt modes.",
    );
  }

  return modes;
}
