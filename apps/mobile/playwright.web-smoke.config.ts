import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "HomeRoute.web.ts",
  use: {
    baseURL: "http://127.0.0.1:4186",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  },
  webServer: {
    command: "node scripts/serve-export.mjs",
    url: "http://127.0.0.1:4186",
    reuseExistingServer: false,
  },
});
