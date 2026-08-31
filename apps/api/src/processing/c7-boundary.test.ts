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

  it("allows exactly one C5-to-C6 compositor and no exported structural rebind", async () => {
    const apiSource = resolve(processingDirectory, "..");
    const modules = await productionModules(apiSource);
    const program = apiProductionProgram(apiSource);
    const checker = program.getTypeChecker();
    const sourceByPath = new Map(
      modules.map((filename) => [filename, program.getSourceFile(filename)]),
    );
    const assemblySource = sourceByPath.get(
      resolve(processingDirectory, "observation-assembler.ts"),
    );
    const integritySource = sourceByPath.get(
      resolve(processingDirectory, "integrity-evaluator.ts"),
    );
    if (!assemblySource || !integritySource)
      throw new Error("C7 topology sources missing");
    const sources = [...sourceByPath.values()].filter(
      (source): source is ts.SourceFile => source !== undefined,
    );
    const ownedBatchCalls = relativeCallSites(
      apiSource,
      callSitesForSymbol(
        checker,
        sources,
        importedSymbol(checker, assemblySource, "analyzeOwnedVerifiedBatch"),
      ),
    );
    const ownedBatchCapabilityConsumes = relativeCallSites(
      apiSource,
      callSitesForSymbol(
        checker,
        sources,
        importedSymbol(
          checker,
          assemblySource,
          "assertOwnedVerifiedVisionBatchForRequests",
        ),
      ),
    );
    const verifiedC5Readers = relativeCallSites(
      apiSource,
      callSitesForSymbol(
        checker,
        sources,
        importedSymbol(
          checker,
          assemblySource,
          "extractionManifestToVisionRequests",
        ),
        (call) => enclosingFunctionName(call) === "assembleVerifiedObservation",
      ),
    );
    const c6Assemblies = relativeCallSites(
      apiSource,
      callSitesForSymbol(
        checker,
        sources,
        importedSymbol(checker, assemblySource, "assembleVerifiedEvidence"),
      ),
    );
    const c7ExecutionReads = relativeCallSites(
      apiSource,
      callSitesForSymbol(
        checker,
        sources,
        importedSymbol(checker, integritySource, "c5BoundEvidenceExecution"),
      ),
    );
    const evidenceRegistrations: string[] = [];
    const legacyRebindIdentifiers: string[] = [];

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
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "set" &&
          node.expression.expression.getText() === "c5BoundEvidence"
        )
          evidenceRegistrations.push(relative(apiSource, filename));
        if (
          ts.isIdentifier(node) &&
          [
            "bindVerifiedVisionRequestExecution",
            "registerC5BoundVerifiedEvidence",
            "verifiedVisionRequestExecution",
          ].includes(node.text)
        )
          legacyRebindIdentifiers.push(relative(apiSource, filename));
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(ownedBatchCalls).toEqual(["processing/observation-assembler.ts"]);
    expect(ownedBatchCapabilityConsumes).toEqual([
      "processing/observation-assembler.ts",
    ]);
    expect(verifiedC5Readers).toEqual(["processing/observation-assembler.ts"]);
    expect(c6Assemblies).toEqual(["processing/observation-assembler.ts"]);
    expect(evidenceRegistrations).toEqual([
      "processing/observation-assembler.ts",
    ]);
    expect(c7ExecutionReads).toEqual(["processing/integrity-evaluator.ts"]);
    expect(legacyRebindIdentifiers).toEqual([]);
  });

  it("resolves imported aliases, namespaces, and computed access before accepting a topology proof", () => {
    const program = virtualProgram({
      "/vision.ts": "export function ownedRunner() {}",
      "/entry.ts": [
        'import { ownedRunner as alias } from "./vision";',
        'import * as vision from "./vision";',
        "alias();",
        "vision.ownedRunner();",
        'vision["ownedRunner"]();',
      ].join("\n"),
    });
    const checker = program.getTypeChecker();
    const vision = program.getSourceFile("/vision.ts");
    const entry = program.getSourceFile("/entry.ts");
    if (!vision || !entry) throw new Error("virtual topology source missing");
    const target = declaredSymbol(checker, vision, "ownedRunner");

    expect(callSitesForSymbol(checker, [entry], target)).toEqual([
      "/entry.ts",
      "/entry.ts",
      "/entry.ts",
    ]);
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

function enclosingFunctionName(node: ts.Node): string | undefined {
  let parent = node.parent;
  while (parent) {
    if (
      (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) &&
      parent.name
    )
      return parent.name.text;
    parent = parent.parent;
  }
  return undefined;
}

function virtualProgram(files: Readonly<Record<string, string>>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  };
  const host = ts.createCompilerHost(options);
  const read = (filename: string): string | undefined => files[filename];
  host.fileExists = (filename) => read(filename) !== undefined;
  host.readFile = read;
  host.getSourceFile = (filename, languageVersion) => {
    const source = read(filename);
    return source === undefined
      ? undefined
      : ts.createSourceFile(filename, source, languageVersion, true);
  };
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      if (name !== "./vision") return undefined;
      return {
        resolvedFileName: resolve(containingFile, "..", "vision.ts"),
        extension: ts.Extension.Ts,
        isExternalLibraryImport: false,
      };
    });
  return ts.createProgram(Object.keys(files), options, host);
}

function apiProductionProgram(apiSource: string): ts.Program {
  const configPath = resolve(apiSource, "..", "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error("API TypeScript config unreadable");
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(apiSource, ".."),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0)
    throw new Error("API TypeScript config invalid");
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function importedSymbol(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  exportedName: string,
): ts.Symbol {
  let result: ts.Symbol | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName?.text ?? node.name.text) === exportedName
    )
      result = checker.getSymbolAtLocation(node.name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!result) throw new Error(`missing imported symbol ${exportedName}`);
  return result;
}

function relativeCallSites(
  root: string,
  sites: readonly string[],
): readonly string[] {
  return sites.map((site) => relative(root, site));
}

function declaredSymbol(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  name: string,
): ts.Symbol {
  let result: ts.Symbol | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      result = checker.getSymbolAtLocation(node.name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!result) throw new Error(`missing symbol ${name}`);
  return result;
}

function callSitesForSymbol(
  checker: ts.TypeChecker,
  sources: readonly ts.SourceFile[],
  target: ts.Symbol,
  accept: (call: ts.CallExpression) => boolean = () => true,
): readonly string[] {
  const sites: string[] = [];
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        accept(node) &&
        sameSymbol(checker, callSymbol(checker, node), target)
      )
        sites.push(source.fileName);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

function callSymbol(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): ts.Symbol | undefined {
  const expression = call.expression;
  if (ts.isIdentifier(expression))
    return checker.getSymbolAtLocation(expression);
  if (ts.isPropertyAccessExpression(expression))
    return checker.getSymbolAtLocation(expression.name);
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteral(expression.argumentExpression)
  )
    return checker.getPropertyOfType(
      checker.getTypeAtLocation(expression.expression),
      expression.argumentExpression.text,
    );
  return undefined;
}

function sameSymbol(
  checker: ts.TypeChecker,
  left: ts.Symbol | undefined,
  right: ts.Symbol,
): boolean {
  if (!left) return false;
  const resolveAlias = (symbol: ts.Symbol) =>
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  return resolveAlias(left) === resolveAlias(right);
}
