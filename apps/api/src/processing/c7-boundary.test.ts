import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const processingDirectory = resolve(import.meta.dirname);
const ownedModules = ["integrity-evaluator.ts", "competitive-policy.ts"];
const forbiddenImport =
  /(?:providers|scheduler|storage|local-media|route|leaderboard|sqlite|scoring|ranking)/i;
const forbiddenIdentifier =
  /(?:VisionProvider|fetch|http|finalizeTerminalResult|leaderboard|scoreWallPass)/;

describe("C7 decision-layer boundary", () => {
  it("has no network, storage, route, or leaderboard dependency and scores only through the opaque seam", async () => {
    for (const filename of ownedModules) {
      const source = ts.createSourceFile(
        filename,
        await readFile(resolve(processingDirectory, filename), "utf8"),
        ts.ScriptTarget.ES2023,
        true,
      );
      const imports: string[] = [];
      const identifiers: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          imports.push(node.moduleSpecifier.text);
        if (ts.isIdentifier(node)) identifiers.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);

      expect(imports).not.toEqual(
        expect.arrayContaining([expect.stringMatching(forbiddenImport)]),
      );
      expect(identifiers).not.toEqual(
        expect.arrayContaining([expect.stringMatching(forbiddenIdentifier)]),
      );
      if (filename === "integrity-evaluator.ts") {
        expect(identifiers).toEqual(
          expect.arrayContaining([
            "VerifiedAttemptCandidate",
            "evaluateWallPassV1",
          ]),
        );
      }
      if (filename === "competitive-policy.ts")
        expect(identifiers).toEqual(
          expect.arrayContaining(["VerifiedAttemptCandidate"]),
        );
    }
  });
});
