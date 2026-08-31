import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const forbiddenModule =
  /(?:@revelai\/domain|integrity|competitive-policy|repository|score|rank|leaderboard|route|result)/i;
const forbiddenPublicName =
  /(?:verdict|eligib|score|rank|leaderboard|policy|persist|repository|route|result)/i;
const forbiddenProviderField =
  /(?:verdict|eligib|retry|score|rank|leaderboard|policy|persist|repository|route|result)/i;

describe("vision public boundary", () => {
  it("uses the compiler graph to keep public types and transitive fields free of domain decisions", async () => {
    const program = await productionProgram();
    const checker = program.getTypeChecker();
    const entry = program.getSourceFile(resolve(sourceDirectory, "index.ts"));
    expect(entry).toBeDefined();
    if (!entry) throw new Error("vision entry source was not loaded");

    for (const source of program.getSourceFiles()) {
      if (!isProductionVisionFile(source.fileName)) continue;
      assertModuleSpecifiers(source);
      assertImportAliases(source, checker);
    }

    const entrySymbol = checker.getSymbolAtLocation(entry);
    expect(entrySymbol).toBeDefined();
    if (!entrySymbol) throw new Error("vision entry symbol was not loaded");
    const violations: string[] = [];
    for (const symbol of checker.getExportsOfModule(entrySymbol))
      walkPublicSymbol(symbol, checker, violations, new Set<string>(), false);
    expect(violations).toEqual([]);
  });
});

async function productionProgram(): Promise<ts.Program> {
  const files = await productionFiles(sourceDirectory);
  return ts.createProgram({
    rootNames: files,
    options: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
    },
  });
}

function assertModuleSpecifiers(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      expect(node.moduleSpecifier.text).not.toMatch(forbiddenModule);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function assertImportAliases(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      const imported = checker.getSymbolAtLocation(node.name);
      const resolved = imported && resolveAlias(imported, checker);
      expect(resolved?.getName() ?? node.name.text).not.toMatch(
        forbiddenPublicName,
      );
      expect(node.name.text).not.toMatch(forbiddenPublicName);
    }
    if (ts.isExportSpecifier(node)) {
      const exported = checker.getSymbolAtLocation(node.name);
      const resolved = exported && resolveAlias(exported, checker);
      expect(resolved?.getName() ?? node.name.text).not.toMatch(
        forbiddenPublicName,
      );
      expect(node.name.text).not.toMatch(forbiddenPublicName);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function walkPublicSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  violations: string[],
  seen: Set<string>,
  withinVisionProvider: boolean,
): void {
  const resolved = resolveAlias(symbol, checker);
  const key = `${resolved.getName()}:${resolved.declarations?.[0]?.getSourceFile().fileName ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  const forbidden = withinVisionProvider
    ? forbiddenProviderField
    : forbiddenPublicName;
  if (forbidden.test(resolved.getName())) violations.push(resolved.getName());
  for (const declaration of resolved.declarations ?? [])
    walkPublicNode(
      declaration,
      checker,
      violations,
      seen,
      withinVisionProvider || resolved.getName() === "VisionProvider",
    );
}

function walkPublicNode(
  node: ts.Node,
  checker: ts.TypeChecker,
  violations: string[],
  seen: Set<string>,
  withinVisionProvider: boolean,
): void {
  const key = `${node.getSourceFile().fileName}:${node.pos}:${node.end}`;
  if (seen.has(key)) return;
  seen.add(key);
  const forbidden = withinVisionProvider
    ? forbiddenProviderField
    : forbiddenPublicName;
  if (
    (ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isMethodDeclaration(node) ||
      (withinVisionProvider && ts.isParameter(node))) &&
    ts.isIdentifier(node.name) &&
    forbidden.test(node.name.text)
  )
    violations.push(node.name.text);
  if (ts.isTypeReferenceNode(node)) {
    const referenced = checker.getSymbolAtLocation(node.typeName);
    if (referenced) {
      const resolved = resolveAlias(referenced, checker);
      const generic = resolved.declarations?.some(
        ts.isTypeParameterDeclaration,
      );
      if (!generic && forbidden.test(resolved.getName()))
        violations.push(resolved.getName());
      for (const declaration of resolved.declarations ?? [])
        if (isProductionVisionFile(declaration.getSourceFile().fileName))
          walkPublicNode(
            declaration,
            checker,
            violations,
            seen,
            withinVisionProvider,
          );
    }
  }
  ts.forEachChild(node, (child) =>
    walkPublicNode(child, checker, violations, seen, withinVisionProvider),
  );
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

async function productionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = resolve(directory, entry.name);
      if (entry.isDirectory()) return productionFiles(target);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [target]
        : [];
    }),
  );
  return nested.flat();
}

function isProductionVisionFile(file: string): boolean {
  return file.startsWith(sourceDirectory) && file.endsWith(".ts");
}
