import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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

  it("keeps every API score and competitive-policy consumer behind the valid-only candidate seam", async () => {
    const apiSource = resolve(processingDirectory, "..");
    const modules = await productionModules(apiSource);
    const calls = new Map<string, string[]>();
    const declarations = new Map<string, ts.FunctionDeclaration>();

    for (const filename of modules) {
      const source = ts.createSourceFile(
        filename,
        await readFile(filename, "utf8"),
        ts.ScriptTarget.ES2023,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          [
            "evaluateWallPassV1",
            "scoreVerifiedCandidate",
            "evaluateCompetitiveEligibility",
          ].includes(node.expression.text)
        ) {
          const entries = calls.get(node.expression.text) ?? [];
          entries.push(relative(apiSource, filename));
          calls.set(node.expression.text, entries);
        }
        if (ts.isFunctionDeclaration(node) && node.name)
          declarations.set(node.name.text, node);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(calls.get("evaluateWallPassV1")).toEqual([
      "processing/integrity-evaluator.ts",
    ]);
    expect(calls.get("scoreVerifiedCandidate") ?? []).toEqual([]);
    expect(calls.get("evaluateCompetitiveEligibility") ?? []).toEqual([]);
    expect(
      candidateParameterType(declarations.get("scoreVerifiedCandidate")),
    ).toBe("VerifiedAttemptCandidate");
    expect(
      candidateParameterType(
        declarations.get("evaluateCompetitiveEligibility"),
      ),
    ).toBe("VerifiedAttemptCandidate");
  });
});

async function productionModules(
  directory: string,
): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return productionModules(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
    }),
  );
  return children.flat();
}

function candidateParameterType(
  declaration: ts.FunctionDeclaration | undefined,
): string | undefined {
  if (!declaration) return undefined;
  const candidate = declaration.parameters.find(
    (parameter) => parameter.name.getText() === "candidate",
  );
  if (candidate) return candidate.type?.getText();
  const input = declaration.parameters.find(
    (parameter) => parameter.name.getText() === "input",
  );
  if (!input?.type || !ts.isTypeReferenceNode(input.type)) return undefined;
  // `evaluateCompetitiveEligibility` deliberately accepts an object input;
  // inspect the declared candidate property instead of relying on call sites.
  const typeName = input.type.typeName.getText();
  if (typeName !== "Readonly" || input.type.typeArguments?.length !== 1)
    return undefined;
  const object = input.type.typeArguments[0];
  if (!ts.isTypeLiteralNode(object)) return undefined;
  const property = object.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && member.name.getText() === "candidate",
  );
  return property?.type?.getText();
}
