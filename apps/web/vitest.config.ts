import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    exclude: [
      ...configDefaults.exclude,
      "**/*.visual.spec.ts",
      "scripts/**/*.test.mjs",
    ],
    setupFiles: ["./src/test/setup.ts"],
  },
});
