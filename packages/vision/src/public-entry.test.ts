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

  it("rejects signatures, computed namespaces, bindings, diagnostics, and transitive aliases", () => {
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
        expect.stringContaining("retry"),
        expect.stringContaining("score"),
        expect.stringContaining("rank"),
        expect.stringContaining("integrity"),
        expect.stringContaining("compiler-diagnostic"),
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
  for (const diagnostic of ts.getPreEmitDiagnostics(program))
    violations.add(
      `compiler-diagnostic:${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        " ",
      )}`,
    );
  for (const source of program.getSourceFiles()) {
    if (!isVisionFile(source.fileName)) continue;
    collectModuleSpecifiers(source, violations);
    collectResolvedImportsAndUses(source, checker, violations);
  }

  const entrySymbol = checker.getSymbolAtLocation(entry);
  if (!entrySymbol) throw new Error("vision entry symbol was not loaded");
  const seenSymbols = new Map<ts.Symbol, Set<boolean>>();
  const seenTypes = new Map<ts.Type, Set<boolean>>();
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
    if (ts.isElementAccessExpression(node))
      reportElementAccess(node, checker, violations);
    if (ts.isBindingElement(node))
      reportSymbol(
        node.propertyName ?? node.name,
        checker,
        violations,
        "binding",
      );
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function reportElementAccess(
  node: ts.ElementAccessExpression,
  checker: ts.TypeChecker,
  violations: Set<string>,
): void {
  const argument = node.argumentExpression;
  if (!ts.isStringLiteral(argument)) return;
  const propertyName = argument.text;
  const namespaceSymbol = checker.getSymbolAtLocation(node.expression);
  const namespace = namespaceSymbol && resolveAlias(namespaceSymbol, checker);
  const property = namespace
    ? checker
        .getExportsOfModule(namespace)
        .find((candidate) => candidate.getName() === propertyName)
    : undefined;
  if (property)
    reportResolvedSymbol(property, checker, violations, "element-access");
  else if (forbiddenPublicName.test(propertyName))
    violations.add(`element-access:${propertyName}`);
}

function reportSymbol(
  node: ts.Node,
  checker: ts.TypeChecker,
  violations: Set<string>,
  source: string,
): void {
  const raw = node.getText();
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol) reportResolvedSymbol(symbol, checker, violations, source, raw);
  else if (forbiddenPublicName.test(raw)) violations.add(`${source}:${raw}`);
}

function reportResolvedSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  violations: Set<string>,
  source: string,
  fallback = symbol.getName(),
): void {
  const resolved = resolveAlias(symbol, checker);
  const name = resolved.getName();
  if (forbiddenPublicName.test(fallback) || forbiddenPublicName.test(name))
    violations.add(`${source}:${fallback}->${name}`);
}

function walkPublicSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  violations: Set<string>,
  seenSymbols: Map<ts.Symbol, Set<boolean>>,
  seenTypes: Map<ts.Type, Set<boolean>>,
  withinVisionProvider: boolean,
): void {
  const resolved = resolveAlias(symbol, checker);
  if (!markUnseen(seenSymbols, resolved, withinVisionProvider)) return;
  if (isStandardLibrarySymbol(resolved)) return;
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
  seenSymbols: Map<ts.Symbol, Set<boolean>>,
  seenTypes: Map<ts.Type, Set<boolean>>,
  withinVisionProvider: boolean,
): void {
  if (!markUnseen(seenTypes, type, withinVisionProvider)) return;
  if (type.flags & ts.TypeFlags.TypeParameter) return;
  const typeSymbol = type.aliasSymbol ?? type.getSymbol();
  const standardLibraryType =
    typeSymbol !== undefined && isStandardLibrarySymbol(typeSymbol);
  if (typeSymbol && !standardLibraryType) {
    const resolved = resolveAlias(typeSymbol, checker);
    reportPublicName(
      resolved.getName(),
      violations,
      withinVisionProvider,
      "type",
    );
    if (!seenSymbols.get(resolved)?.has(withinVisionProvider))
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
  for (const argument of typeReferenceArguments(type, checker))
    walkPublicType(
      argument,
      checker,
      violations,
      seenSymbols,
      seenTypes,
      withinVisionProvider,
    );
  if (standardLibraryType) return;
  for (const signature of [
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Call),
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Construct),
  ])
    walkPublicSignature(
      signature,
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

function typeReferenceArguments(
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly ts.Type[] {
  if (!(type.flags & ts.TypeFlags.Object)) return [];
  const objectType = type as ts.ObjectType;
  if (!(objectType.objectFlags & ts.ObjectFlags.Reference)) return [];
  return checker.getTypeArguments(objectType as ts.TypeReference);
}

function walkPublicSignature(
  signature: ts.Signature,
  checker: ts.TypeChecker,
  violations: Set<string>,
  seenSymbols: Map<ts.Symbol, Set<boolean>>,
  seenTypes: Map<ts.Type, Set<boolean>>,
  withinVisionProvider: boolean,
): void {
  for (const parameter of signature.getParameters()) {
    reportPublicName(
      parameter.getName(),
      violations,
      withinVisionProvider,
      "parameter",
    );
    const declaration =
      parameter.valueDeclaration ?? parameter.declarations?.[0];
    if (!declaration) continue;
    try {
      walkPublicType(
        checker.getTypeOfSymbolAtLocation(parameter, declaration),
        checker,
        violations,
        seenSymbols,
        seenTypes,
        withinVisionProvider,
      );
    } catch {
      // Program diagnostics above make a missing synthetic declaration fail closed.
    }
  }
  walkPublicType(
    checker.getReturnTypeOfSignature(signature),
    checker,
    violations,
    seenSymbols,
    seenTypes,
    withinVisionProvider,
  );
}

function markUnseen<T>(
  seen: Map<T, Set<boolean>>,
  value: T,
  withinVisionProvider: boolean,
): boolean {
  const contexts = seen.get(value);
  if (contexts?.has(withinVisionProvider)) return false;
  if (contexts) contexts.add(withinVisionProvider);
  else seen.set(value, new Set([withinVisionProvider]));
  return true;
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

function isStandardLibrarySymbol(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations;
  return (
    declarations !== undefined &&
    declarations.length > 0 &&
    declarations.every((declaration) =>
      /\/typescript\/lib\/lib\..*\.d\.ts$/.test(
        declaration.getSourceFile().fileName,
      ),
    )
  );
}

function adversarialFixtureProgram(): ts.Program {
  const files = new Map<string, string>([
    [
      "/vision-guard/index.ts",
      [
        'import * as neutral from "./neutral.js";',
        'import neutralDefault from "./external.js";',
        'import type { NeutralAlias } from "./neutral.js";',
        'export const leaked = neutral["VerifiedResultSchema"];',
        "const { VerifiedResultSchema: destructuredSchema, default: destructuredDefault } = neutral;",
        "export { destructuredSchema, destructuredDefault };",
        "export type ProviderSurface = {",
        "  throughNamespace: typeof neutral.VerifiedResultSchema;",
        "  throughDefault: typeof neutralDefault;",
        "  throughAlias: NeutralAlias;",
        "};",
        "export type SharedProviderReturn = { retry: string };",
        "export type PublicFirst = SharedProviderReturn;",
        "export interface VisionProvider {",
        "  shared(): SharedProviderReturn;",
        "  analyze(): Promise<Readonly<{ retry: string }>>;",
        "}",
        'export const compilerFailure: number = "not-a-number";',
      ].join("\n"),
    ],
    [
      "/vision-guard/neutral.ts",
      [
        "export const VerifiedResultSchema = Object.freeze({});",
        "export type NeutralAlias = { score: number; nested: { integrity: boolean } };",
        "const defaultPayload: { nested: { policy: boolean } } = { nested: { policy: true } };",
        "export default defaultPayload;",
      ].join("\n"),
    ],
    [
      "/vision-guard/external.ts",
      "declare const payload: { rank: number }; export default payload;",
    ],
  ]);
  const host = ts.createCompilerHost(compilerOptions());
  const nativeGetSourceFile = host.getSourceFile.bind(host);
  const nativeFileExists = host.fileExists.bind(host);
  const nativeReadFile = host.readFile.bind(host);
  const nativeDirectoryExists = host.directoryExists?.bind(host);
  host.fileExists = (file) => files.has(file) || nativeFileExists(file);
  host.readFile = (file) => files.get(file) ?? nativeReadFile(file);
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
