import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  apiRouteRegistry,
  generateOpenApiDocument,
  renderOpenApiDocument,
} from "./openapi.js";

const c8Routes = [
  ["/health", "get"],
  ["/ready", "get"],
  ["/v1/challenges", "get"],
  ["/v1/calibration-sessions", "post"],
  ["/v1/calibration-sessions/{id}/ready", "post"],
  ["/v1/attempts", "get"],
  ["/v1/attempts", "post"],
  ["/v1/attempts/{id}", "get"],
  ["/v1/attempts/{id}", "delete"],
  ["/v1/attempts/{id}/result", "get"],
  ["/v1/attempts/{id}/media", "post"],
  ["/v1/leaderboards/wall-pass", "get"],
] as const;

describe("generated OpenAPI", () => {
  it("documents every implemented C8 route exactly once from the shared registry", () => {
    const document = generateOpenApiDocument();

    expect(apiRouteRegistry).toHaveLength(c8Routes.length);
    for (const [path, method] of c8Routes) {
      expect(document.paths[path]?.[method]).toBeDefined();
      expect(
        apiRouteRegistry.filter(
          (route) => route.path === path && route.method === method,
        ),
      ).toHaveLength(1);
    }
  });

  it("keeps the committed artifact synchronized with the shared-schema generator", async () => {
    await expect(
      readFile(new URL("../../openapi.json", import.meta.url), "utf8"),
    ).resolves.toBe(renderOpenApiDocument());
  });

  it("preserves identity-header and multipart contracts without exposing internals", () => {
    const document = generateOpenApiDocument();
    const createAttempt = document.paths["/v1/attempts"]?.post as {
      parameters?: Array<Record<string, unknown>>;
    };
    const upload = document.paths["/v1/attempts/{id}/media"]?.post as {
      requestBody?: {
        content?: {
          "multipart/form-data"?: {
            schema?: Record<string, unknown>;
          };
        };
      };
    };

    expect(createAttempt.parameters).toContainEqual(
      expect.objectContaining({
        name: "X-RevelAI-Athlete-Id",
        in: "header",
        required: true,
      }),
    );
    expect(
      upload.requestBody?.content?.["multipart/form-data"]?.schema,
    ).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["media"],
      properties: { media: { type: "string", format: "binary" } },
    });
    expect(JSON.stringify(document)).not.toMatch(
      /repository|receipt|evidence|media[_-]?key|provider[_-]?payload/i,
    );
  });
});
