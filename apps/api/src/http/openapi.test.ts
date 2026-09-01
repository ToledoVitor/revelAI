import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  apiRouteRegistry,
  generateOpenApiDocument,
  renderOpenApiDocument,
} from "./openapi.js";

describe("generated OpenAPI", () => {
  it("documents every shared C2 route exactly once", () => {
    const document = generateOpenApiDocument();
    const contractKeys = apiRouteRegistry.map(
      (route) => `${route.method} ${route.path}`,
    );
    const documentKeys = Object.entries(document.paths).flatMap(
      ([path, pathItem]) =>
        Object.keys(pathItem).map((method) => `${method} ${path}`),
    );

    expect(new Set(contractKeys).size).toBe(contractKeys.length);
    expect(documentKeys.sort()).toEqual(contractKeys.sort());
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

  it("documents C2 query inputs with their literal wire types, optionality, and defaults", () => {
    const document = generateOpenApiDocument();
    const attempts = document.paths["/v1/attempts"]?.get as {
      parameters: Array<Record<string, unknown>>;
    };
    const leaderboard = document.paths["/v1/leaderboards/wall-pass"]?.get as {
      parameters: Array<Record<string, unknown>>;
    };
    const parameter = (
      operation: { parameters: Array<Record<string, unknown>> },
      name: string,
    ) => operation.parameters.find((value) => value.name === name);

    expect(parameter(attempts, "limit")).toEqual({
      name: "limit",
      in: "query",
      required: false,
      schema: { default: 20, type: "integer", minimum: 1, maximum: 50 },
    });
    expect(parameter(leaderboard, "version")).toEqual({
      name: "version",
      in: "query",
      required: true,
      schema: { type: "string", const: "1" },
    });
    expect(parameter(leaderboard, "limit")).toEqual({
      name: "limit",
      in: "query",
      required: false,
      schema: {
        type: "string",
        pattern: "^(?:[1-9]|[1-4][0-9]|50)$",
        default: "20",
      },
    });
  });
});
