import { defineConfig } from "@playwright/test";

// This dedicated production-server config is the sole runner for the demo
// boundary tests; the regular W0–W5 visual matrix must not start it.
process.env.REVELAI_DEMO_E2E = "true";

export default defineConfig({
  outputDir: "./coverage/playwright-demo",
  testDir: "./src/visual",
  testMatch: "demo-api.e2e.visual.spec.ts",
  // The verified C10 trace owns one finite 120-second post-upload budget;
  // this outer timeout is only teardown/reporting backstop room.
  timeout: 150_000,
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/start-demo-e2e-server.mjs",
    url: "http://127.0.0.1:4175/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
