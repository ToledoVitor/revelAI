import { describe, expect, it } from "vitest";
import { parseApiEnv } from "./index.js";

describe("parseApiEnv", () => {
  it("defaults to a loopback demo configuration without secrets", () => {
    expect(parseApiEnv({})).toStrictEqual({
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 3000,
      publicBaseUrl: "http://127.0.0.1:3000",
      paths: {
        dataDir: ".revelai/data",
        mediaDir: ".revelai/media",
        databasePath: ".revelai/data/revelai.sqlite",
      },
      visionProvider: { kind: "demo" },
      startupWarnings: [],
    });
  });

  it("rejects a partial Roboflow configuration", () => {
    expect(() => parseApiEnv({ ROBOFLOW_API_KEY: "test-key" })).toThrow(
      "Incomplete Roboflow configuration",
    );
  });

  it("rejects an external HTTP provider URL that carries an API key", () => {
    expect(() =>
      parseApiEnv({
        ROBOFLOW_API_KEY: "test-key",
        ROBOFLOW_BASE_URL: "http://inference.example.test",
        ROBOFLOW_WORKSPACE_ID: "workspace",
        ROBOFLOW_WORKFLOW_ID: "workflow",
        ROBOFLOW_WORKFLOW_VERSION: "1",
      }),
    ).toThrow("HTTPS");
  });

  it("does not treat a DNS name beginning with 127 as a loopback provider", () => {
    expect(() =>
      parseApiEnv({
        ROBOFLOW_API_KEY: "test-key",
        ROBOFLOW_BASE_URL: "http://127.attacker.test",
        ROBOFLOW_WORKSPACE_ID: "workspace",
        ROBOFLOW_WORKFLOW_ID: "workflow",
        ROBOFLOW_WORKFLOW_VERSION: "1",
      }),
    ).toThrow("HTTPS");
  });

  it("rejects an HTTP public base URL in production", () => {
    expect(() =>
      parseApiEnv({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "http://revelai.example.test",
      }),
    ).toThrow("PUBLIC_BASE_URL must use HTTPS in production");
  });

  it("rejects a non-loopback unauthenticated bind without the exact opt-in", () => {
    expect(() => parseApiEnv({ HOST: "0.0.0.0" })).toThrow(
      "ALLOW_UNAUTHENTICATED_PUBLIC=true",
    );
  });

  it("does not treat a DNS name beginning with 127 as a loopback bind", () => {
    expect(() => parseApiEnv({ HOST: "127.attacker.test" })).toThrow(
      "ALLOW_UNAUTHENTICATED_PUBLIC=true",
    );
  });

  it("creates a valid public URL for an unbracketed IPv6 loopback bind", () => {
    expect(parseApiEnv({ HOST: "::1" })).toMatchObject({
      host: "::1",
      publicBaseUrl: "http://[::1]:3000",
      startupWarnings: [],
    });
  });

  it("exposes a redacted warning for an explicitly opted-in public bind", () => {
    const parsed = parseApiEnv({
      HOST: "0.0.0.0",
      ALLOW_UNAUTHENTICATED_PUBLIC: "true",
    });

    expect(parsed.startupWarnings).toStrictEqual([
      {
        id: "unauthenticated_mvp_public_bind",
        message:
          "Unauthenticated MVP mode is enabled for a non-loopback bind; do not use this configuration as a production security boundary.",
      },
    ]);
    expect(JSON.stringify(parsed.startupWarnings)).not.toContain("0.0.0.0");
  });
});
