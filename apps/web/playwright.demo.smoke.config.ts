import { defineConfig } from "@playwright/test";

process.env.REVELAI_DEMO_E2E = "true";

export default defineConfig({
  outputDir: "./coverage/playwright-demo-smoke",
  testDir: "./src/visual",
  testMatch: "demo-api.e2e.visual.spec.ts",
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/start-demo-e2e-server.mjs --serve-check",
    url: "http://127.0.0.1:4175/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
