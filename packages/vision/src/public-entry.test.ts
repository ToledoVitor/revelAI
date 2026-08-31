import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("vision boundary", () => {
  it("keeps production vision code away from domain decisions, repositories, and routes", async () => {
    const files = await productionFiles(new URL(".", import.meta.url));
    const sources = await Promise.all(
      files.map((file) => readFile(file, "utf8")),
    );
    const forbidden =
      /from\s+["'][^"']*(?:@revelai\/domain|integrity|repository|score|rank|leaderboard|route)[^"']*["']|import\s*\(\s*["'][^"']*(?:@revelai\/domain|integrity|repository|score|rank|leaderboard|route)[^"']*["']\s*\)/;
    expect(sources.join("\n")).not.toMatch(forbidden);
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
