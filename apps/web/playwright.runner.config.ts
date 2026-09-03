import { defineConfig } from "@playwright/test";

export default defineConfig({
  outputDir: "./coverage/playwright-runner",
  testDir: "./src/visual",
  testMatch: "playwright-runner-smoke.visual.spec.ts",
  use: {
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/playwright-runner-server.mjs",
    url: "http://127.0.0.1:4176",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "runner-smoke",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1024 },
        deviceScaleFactor: 1,
      },
    },
  ],
});
