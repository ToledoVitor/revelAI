import { defineConfig } from "@playwright/test";

export default defineConfig({
  outputDir: "./coverage/playwright-production",
  testDir: "./src/visual",
  testMatch: "production-route-isolation.visual.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:4175",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "pnpm run build:production-router && pnpm exec vite preview --host 127.0.0.1 --port 4175 --outDir coverage/production-router-dist",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "production-router",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1024 },
        deviceScaleFactor: 1,
      },
    },
  ],
});
