// @vitest-environment node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reviewSetupModule = resolve(webDirectory, "src/verified/setup.tsx");
const productionGraphIntegrationTimeoutMs = 15_000;

type OutputChunk = Readonly<{
  code: string;
  moduleIds: readonly string[];
  type: "chunk";
}>;

function hasOutput(value: unknown): value is Readonly<{ output: unknown[] }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "output" in value &&
    Array.isArray(value.output)
  );
}

function isOutputChunk(value: unknown): value is OutputChunk {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "chunk" &&
    "code" in value &&
    typeof value.code === "string" &&
    "moduleIds" in value &&
    Array.isArray(value.moduleIds)
  );
}

async function buildWithProductionEnvironment() {
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    return await build({
      root: webDirectory,
      mode: "production",
      logLevel: "silent",
      build: {
        emptyOutDir: false,
        write: false,
      },
    });
  } finally {
    if (previousNodeEnvironment === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnvironment;
    }
  }
}

describe("production router review-route isolation", () => {
  it(
    "removes the review setup module from the DEV:false/MODE:production router graph",
    async () => {
      const buildResult = await buildWithProductionEnvironment();
      const outputGroups = (
        Array.isArray(buildResult) ? buildResult : [buildResult]
      ).map((output) => {
        if (!hasOutput(output)) {
          throw new Error("Vite did not return a production build output.");
        }
        return output;
      });
      const chunks = outputGroups.flatMap(({ output }) =>
        output.flatMap((output) => {
          const candidate: unknown = output;
          return isOutputChunk(candidate) ? [candidate] : [];
        }),
      );

      expect(chunks.flatMap((chunk) => chunk.moduleIds)).not.toContain(
        reviewSetupModule,
      );
      expect(chunks.map((chunk) => chunk.code).join("\n")).not.toContain(
        "__revelaiReviewSetupModuleEvaluations",
      );
    },
    productionGraphIntegrationTimeoutMs,
  );
});
