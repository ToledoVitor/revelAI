/**
 * Builds the environment passed across the Playwright-runner to API boundary.
 * The marker is meaningful to the browser suite only; the API deliberately
 * rejects unknown REVELAI_* settings to keep its runtime configuration strict.
 */
export function createDemoApiEnvironment({
  environment,
  port,
  dataDirectory,
  mediaDirectory,
}) {
  const apiEnvironment = { ...environment };
  delete apiEnvironment.REVELAI_DEMO_E2E;

  return {
    ...apiEnvironment,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDirectory,
    MEDIA_DIR: mediaDirectory,
  };
}
