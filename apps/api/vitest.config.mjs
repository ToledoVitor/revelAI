import { defineConfig } from "vitest/config";

// Only case-insensitive, surrounding-whitespace-normalized true/1 mean hosted CI.
const ciSignal = process.env.CI?.trim().toLowerCase();
const isHostedCi = ciSignal === "true" || ciSignal === "1";

export default defineConfig({
  test: {
    minWorkers: 1,
    maxWorkers: isHostedCi ? 1 : 4,
  },
});
