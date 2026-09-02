import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  outputDir: "./coverage/playwright",
  testDir: "./src/visual",
  testMatch: "**/*.visual.spec.ts",
  testIgnore: "**/production-route-isolation.visual.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "node scripts/verify-design-assets.mjs && pnpm exec vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "desktop-home",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1024 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: "mobile-home",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      },
    },
  ],
});
