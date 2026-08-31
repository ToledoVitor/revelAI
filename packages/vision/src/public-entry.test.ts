import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const forbiddenModule =
  /(?:@revelai\/domain|integrity|competitive-policy|repository|score|rank|leaderboard|route|result|eligib|policy)/i;
const forbiddenPublicName =
  /(?:verdict|eligib|integrity|score|rank|leaderboard|policy|persist|repository|route|result)/i;
const forbiddenProviderField =
  /(?:verdict|eligib|integrity|retry|score|rank|leaderboard|policy|persist|repository|route|result)/i;

describe("vision public boundary", () => {
  it("uses the compiler graph to keep public types and transitive fields free of domain decisions", async () => {
    const program = await productionProgram();
    const entry = program.getSourceFile(resolve(sourceDirectory, "index.ts"));
    expect(entry).toBeDefined();
    if (!entry) throw new Error("vision entry source was not loaded");

    expect(
      collectPublicBoundaryViolations(program, entry, isProductionVisionFile),
    ).toEqual([]);
  });

  it("rejects namespace, default, neutral-barrel, and transitive external aliases", () => {
    const program = adversarialFixtureProgram();
    const entry = program.getSourceFile("/vision-guard/index.ts");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("fixture entry source was not loaded");

    expect(
      collectPublicBoundaryViolations(program, entry, (file) =>
        file.startsWith("/vision-guard/"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("VerifiedResultSchema"),
        expect.stringContaining("score"),
        expect.stringContaining("rank"),
        expect.stringContaining("integrity"),
      ]),
    );
  });
});

async function productionProgram(): Promise<ts.Program> {
  const files = await productionFiles(sourceDirectory);
  return ts.createProgram({ rootNames: files, options: compilerOptions() });
}

function compilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
  };
}

function collectPublicBoundaryViolations(
  program: ts.Program,
  entry: ts.SourceFile,
  isVisionFile: (file: string) => boolean,
): readonly string[] {
  const checker = program.getTypeChecker();
  const violations = new Set<string>();
  for (const source of program.getSourceFiles()) {
    if (!isVisionFile(source.fileName)) continue;
    collectModuleSpecifiers(source, violations);
    collectResolvedImportsAndUses(source, checker, violations);
  }

  const entrySymbol = checker.getSymbolAtLocation(entry);
  if (!entrySymbol) throw new Error("vision entry symbol was not loaded");
  const seenSymbols = new Set<ts.Symbol>();
  const seenTypes = new Set<number>();
  for (const exported of checker.getExportsOfModule(entrySymbol))
    walkPublicSymbol(
      exported,
      checker,
      violations,
      seenSymbols,
      seenTypes,
      false,
    );
  return [...violations].sort();
}

function collectModuleSpecifiers(
  source: ts.SourceFile,
  violations: Set<string>,
): void {
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      forbiddenModule.test(node.moduleSpecifier.text)
    )
      violations.add(`module:${node.moduleSpecifier.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function collectResolvedImportsAndUses(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  violations: Set<string>,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name)
        reportSymbol(clause.name, checker, violations, "default-import");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        reportSymbol(bindings.name, checker, violations, "namespace-import");
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements)
          reportSymbol(binding.name, checker, violations, "import");
    }
    if (ts.isExportSpecifier(node))
      reportSymbol(node.name, checker, violations, "export");
    // A namespace itself is neutral; its resolved property is the public API
    // that matters. This also catches `namespace.default` aliases.
    if (ts.isPropertyAccessExpression(node))
      reportSymbol(node.name, checker, violations, "property-access");
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function reportSymbol(
  node: ts.Node,
  checker: ts.TypeChecker,
  violations: Set<string>,
  source: string,
): void {
  const raw = node.getText();
  const symbol = checker.getSymbolAtLocation(node);
  const resolved = symbol && resolveAlias(symbol, checker);
  const name = resolved?.getName() ?? raw;
  if (forbiddenPublicName.test(raw) || forbiddenPublicName.test(name))
    violations.add(`${source}:${raw}->${name}`);
}

function walkPublicSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  violations: Set<string>,
  seenSymbols: Set<ts.Symbol>,
  seenTypes: Set<number>,
  withinVisionProvider: boolean,
): void {
  const resolved = resolveAlias(symbol, checker);
  if (seenSymbols.has(resolved)) return;
  seenSymbols.add(resolved);
  const providerSurface =
    withinVisionProvider || resolved.getName() === "VisionProvider";
  reportPublicName(resolved.getName(), violations, providerSurface, "symbol");

  // Zod values pull its complete external declaration graph. The paired public
  // type exports are walked below; schemas are independently protected by the
  // import/re-export guard and do not form provider-facing object fields.
  if (resolved.getName().endsWith("Schema")) return;
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (!declaration) return;
  const type = typeForPublicSymbol(resolved, declaration, checker);
  if (type)
    walkPublicType(
      type,
      checker,
      violations,
      seenSymbols,
      seenTypes,
      providerSurface,
    );
}

function typeForPublicSymbol(
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  try {
    if (
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration) ||
      ts.isClassDeclaration(declaration)
    )
      return checker.getDeclaredTypeOfSymbol(symbol);
    return checker.getTypeOfSymbolAtLocation(symbol, declaration);
  } catch {
    // An unresolved declaration is not a permit: import/property uses above
    // are still checked and the production program has no diagnostics.
    return undefined;
  }
}

function walkPublicType(
  type: ts.Type,
  checker: ts.TypeChecker,
  violations: Set<string>,
  seenSymbols: Set<ts.Symbol>,
  seenTypes: Set<number>,
  withinVisionProvider: boolean,
): void {
  const id = (type as ts.Type & { id?: number }).id;
  if (id !== undefined) {
    if (seenTypes.has(id)) return;
    seenTypes.add(id);
  }
  const typeSymbol = type.aliasSymbol ?? type.getSymbol();
  if (typeSymbol) {
    const resolved = resolveAlias(typeSymbol, checker);
    reportPublicName(
      resolved.getName(),
      violations,
      withinVisionProvider,
      "type",
    );
    if (!seenSymbols.has(resolved))
      walkPublicSymbol(
        resolved,
        checker,
        violations,
        seenSymbols,
        seenTypes,
        withinVisionProvider,
      );
  }
  for (const part of type.isUnionOrIntersection() ? type.types : [])
    walkPublicType(
      part,
      checker,
      violations,
      seenSymbols,
      seenTypes,
      withinVisionProvider,
    );
  for (const argument of type.aliasTypeArguments ?? [])
    walkPublicType(
      argument,
      checker,
      violations,
      seenSymbols,
      seenTypes,
      withinVisionProvider,
    );
  for (const property of checker.getPropertiesOfType(type)) {
    const providerSurface =
      withinVisionProvider || typeSymbol?.getName() === "VisionProvider";
    reportPublicName(property.getName(), violations, providerSurface, "field");
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    try {
      walkPublicType(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        checker,
        violations,
        seenSymbols,
        seenTypes,
        providerSurface,
      );
    } catch {
      violations.add(`unresolved-field:${property.getName()}`);
    }
  }
}

function reportPublicName(
  name: string,
  violations: Set<string>,
  withinVisionProvider: boolean,
  source: string,
): void {
  const forbidden = withinVisionProvider
    ? forbiddenProviderField
    : forbiddenPublicName;
  if (forbidden.test(name)) violations.add(`${source}:${name}`);
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function adversarialFixtureProgram(): ts.Program {
  const files = new Map<string, string>([
    [
      "/vision-guard/index.ts",
      [
        'import * as neutral from "./neutral.js";',
        'import neutralDefault from "./external.js";',
        'import type { NeutralAlias } from "./neutral.js";',
        "export const leaked = neutral.VerifiedResultSchema;",
        "export type ProviderSurface = {",
        "  throughNamespace: typeof neutral.VerifiedResultSchema;",
        "  throughDefault: typeof neutralDefault;",
        "  throughAlias: NeutralAlias;",
        "};",
      ].join("\n"),
    ],
    [
      "/vision-guard/neutral.ts",
      [
        "export const VerifiedResultSchema = Object.freeze({});",
        "export type NeutralAlias = { score: number; nested: { integrity: boolean } };",
      ].join("\n"),
    ],
    [
      "/vision-guard/external.ts",
      "declare const payload: { rank: number }; export default payload;",
    ],
  ]);
  const host = ts.createCompilerHost(compilerOptions());
  const nativeGetSourceFile = host.getSourceFile.bind(host);
  const nativeDirectoryExists = host.directoryExists?.bind(host);
  host.fileExists = (file) => files.has(file);
  host.readFile = (file) => files.get(file);
  host.directoryExists = (directory) =>
    directory === "/vision-guard" ||
    nativeDirectoryExists?.(directory) === true;
  host.getSourceFile = (file, languageVersion) => {
    const content = files.get(file);
    return content === undefined
      ? nativeGetSourceFile(file, languageVersion)
      : ts.createSourceFile(file, content, languageVersion, true);
  };
  return ts.createProgram({
    rootNames: [...files.keys()],
    options: compilerOptions(),
    host,
  });
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
