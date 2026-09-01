import { resolve } from "node:path";
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
        dataDir: resolve(".revelai/data"),
        mediaDir: resolve(".revelai/media"),
        databasePath: resolve(".revelai/data/revelai.sqlite"),
      },
      visionProvider: { kind: "demo" },
      startupWarnings: [],
    });
  });

  it("rejects an unrecognized environment variable before startup can bind", () => {
    expect(() =>
      parseApiEnv({ REVELAI_UNEXPECTED_SETTING: "enabled" }),
    ).toThrow("Unrecognized key");
  });

  it("accepts the real process environment while rejecting unknown app-prefixed settings", () => {
    expect(() => parseApiEnv(process.env)).not.toThrow();
    expect(() =>
      parseApiEnv({
        ...process.env,
        ROBOFLOW_UNEXPECTED_SETTING: "enabled",
      }),
    ).toThrow("Unrecognized key");
  });

  it("normalizes local storage and database locations before composition", () => {
    expect(
      parseApiEnv({
        DATA_DIR: "./var/../demo-data",
        MEDIA_DIR: "./var/../demo-media",
        DATABASE_PATH: "./var/../demo-data/../demo.sqlite",
      }).paths,
    ).toEqual({
      dataDir: resolve("demo-data"),
      mediaDir: resolve("demo-media"),
      databasePath: resolve("demo.sqlite"),
    });
  });

  it("rejects a partial Roboflow configuration", () => {
    expect(() => parseApiEnv({ ROBOFLOW_API_KEY: "test-key" })).toThrow(
      "Incomplete Roboflow configuration",
    );
  });

  it("accepts a keyless loopback Workflow configuration only when both exact model tuples are complete", () => {
    expect(
      parseApiEnv({
        ROBOFLOW_API_URL: "http://127.0.0.1:9001/",
        ROBOFLOW_WORKSPACE_ID: "revelai",
        ROBOFLOW_WORKFLOW_VERSION: "1.0.0",
        ROBOFLOW_WALL_PASS_WORKFLOW_ID: "revelai-wall-pass-geometry-v1",
        ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID: "wall-pass-bundle-v1",
        ROBOFLOW_FREE_WORKFLOW_ID: "revelai-free-training-v1",
        ROBOFLOW_FREE_MODEL_BUNDLE_ID: "free-training-bundle-v1",
      }).visionProvider,
    ).toEqual({
      kind: "roboflow",
      apiUrl: "http://127.0.0.1:9001",
      workspaceId: "revelai",
      workflowVersion: "1.0.0",
      wallPass: {
        workflowId: "revelai-wall-pass-geometry-v1",
        modelBundleId: "wall-pass-bundle-v1",
      },
      freeTraining: {
        workflowId: "revelai-free-training-v1",
        modelBundleId: "free-training-bundle-v1",
      },
    });
  });

  it("rejects an external HTTP provider URL that carries an API key", () => {
    expect(() =>
      parseApiEnv({
        ROBOFLOW_API_KEY: "test-key",
        ROBOFLOW_API_URL: "http://inference.example.test",
        ROBOFLOW_WORKSPACE_ID: "workspace",
        ROBOFLOW_WORKFLOW_VERSION: "1.0.0",
        ROBOFLOW_WALL_PASS_WORKFLOW_ID: "revelai-wall-pass-geometry-v1",
        ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID: "wall-pass-bundle-v1",
        ROBOFLOW_FREE_WORKFLOW_ID: "revelai-free-training-v1",
        ROBOFLOW_FREE_MODEL_BUNDLE_ID: "free-training-bundle-v1",
      }),
    ).toThrow("HTTPS");
  });

  it("rejects a key-bearing loopback HTTP provider URL", () => {
    expect(() =>
      parseApiEnv({
        ROBOFLOW_API_KEY: "test-key",
        ROBOFLOW_API_URL: "http://127.0.0.1:9001",
        ROBOFLOW_WORKSPACE_ID: "workspace",
        ROBOFLOW_WORKFLOW_VERSION: "1.0.0",
        ROBOFLOW_WALL_PASS_WORKFLOW_ID: "revelai-wall-pass-geometry-v1",
        ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID: "wall-pass-bundle-v1",
        ROBOFLOW_FREE_WORKFLOW_ID: "revelai-free-training-v1",
        ROBOFLOW_FREE_MODEL_BUNDLE_ID: "free-training-bundle-v1",
      }),
    ).toThrow("HTTPS");
  });

  it("does not treat a DNS name beginning with 127 as a loopback provider", () => {
    expect(() =>
      parseApiEnv({
        ROBOFLOW_API_KEY: "test-key",
        ROBOFLOW_API_URL: "http://127.attacker.test",
        ROBOFLOW_WORKSPACE_ID: "workspace",
        ROBOFLOW_WORKFLOW_VERSION: "1.0.0",
        ROBOFLOW_WALL_PASS_WORKFLOW_ID: "revelai-wall-pass-geometry-v1",
        ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID: "wall-pass-bundle-v1",
        ROBOFLOW_FREE_WORKFLOW_ID: "revelai-free-training-v1",
        ROBOFLOW_FREE_MODEL_BUNDLE_ID: "free-training-bundle-v1",
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
