import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("vision boundary", () => {
  it("keeps production vision code away from domain decisions, repositories, and routes", async () => {
    const files = await productionFiles(new URL(".", import.meta.url));
    const entries = await Promise.all(
      files.map(async (file) =>
        Object.freeze({ file, source: await readFile(file, "utf8") }),
      ),
    );
    const forbiddenImport =
      /(?:from|import\s*\()\s*["'][^"']*(?:@revelai\/domain|integrity|competitive-policy|repository|score|rank|leaderboard|route|result)[^"']*["']/;
    expect(entries.map((entry) => entry.source).join("\n")).not.toMatch(
      forbiddenImport,
    );

    const provider = entries.find((entry) =>
      entry.file.endsWith("providers.ts"),
    )?.source;
    expect(provider).toBeDefined();
    const exportedSymbols = [
      ...(provider?.matchAll(
        /export\s+(?:type|class|function|const)\s+(\w+)/g,
      ) ?? []),
    ].map((match) => match[1]!);
    expect(exportedSymbols.join(" ")).not.toMatch(
      /(?:verdict|eligib|score|result|policy|rank|persist)/i,
    );
    const providerShape = provider?.match(
      /export\s+type\s+VisionProvider\s*=\s*Readonly<\{([\s\S]*?)\}>;/,
    )?.[1];
    expect(providerShape).toBeDefined();
    expect(providerShape).not.toMatch(
      /(?:verdict|eligib|retry|score|result|policy|rank|persist)/i,
    );
  });
});

async function productionFiles(directory: URL): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = new URL(entry.name, directory);
      if (entry.isDirectory())
        return productionFiles(new URL(`${entry.name}/`, directory));
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [target.pathname]
        : [];
    }),
  );
  return nested.flat();
}
