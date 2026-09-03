import assert from "node:assert/strict";
import test from "node:test";
import { createDemoApiEnvironment } from "./demo-e2e-environment.mjs";

test("keeps the Playwright-only marker out of the strict API environment", () => {
  const environment = createDemoApiEnvironment({
    environment: {
      CI: "true",
      REVELAI_DEMO_E2E: "true",
      NORMAL_RUNNER_SETTING: "preserved",
    },
    port: 4174,
    dataDirectory: "/tmp/revelai-data",
    mediaDirectory: "/tmp/revelai-media",
  });

  assert.equal(environment.REVELAI_DEMO_E2E, undefined);
  assert.equal(environment.CI, "true");
  assert.equal(environment.NORMAL_RUNNER_SETTING, "preserved");
  assert.equal(environment.HOST, "127.0.0.1");
  assert.equal(environment.PORT, "4174");
  assert.equal(environment.DATA_DIR, "/tmp/revelai-data");
  assert.equal(environment.MEDIA_DIR, "/tmp/revelai-media");
});
