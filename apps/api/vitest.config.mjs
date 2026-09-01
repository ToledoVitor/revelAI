import { defineConfig } from "vitest/config";

const isCi = process.env.CI !== undefined;

export default defineConfig({
  test: {
    minWorkers: 1,
    maxWorkers: isCi ? 1 : 4,
  },
});
