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
    const program = apiProductionProgram(apiSource);
    const checker = program.getTypeChecker();
    const sourceByPath = new Map(
      modules.map((filename) => [filename, program.getSourceFile(filename)]),
    );
    const integritySource = sourceByPath.get(
      resolve(processingDirectory, "integrity-evaluator.ts"),
    );
    const policySource = sourceByPath.get(
      resolve(processingDirectory, "competitive-policy.ts"),
    );
    if (!integritySource || !policySource)
      throw new Error("C7 score/policy topology sources missing");
    const sources = [...sourceByPath.values()].filter(
      (source): source is ts.SourceFile => source !== undefined,
    );

    expect(
      relativeCallSites(
        apiSource,
        callSitesForSymbol(
          checker,
          sources,
          importedSymbol(checker, integritySource, "evaluateWallPassV1"),
        ),
      ),
    ).toEqual(["processing/integrity-evaluator.ts"]);
    expect(
      relativeCallSites(
        apiSource,
        callSitesForSymbol(
          checker,
          sources,
          declaredSymbol(checker, integritySource, "scoreVerifiedCandidate"),
        ),
      ),
    ).toEqual(["services/verified-training-analysis.ts"]);
    expect(
      relativeCallSites(
        apiSource,
        callSitesForSymbol(
          checker,
          sources,
          declaredSymbol(
            checker,
            policySource,
            "evaluateCompetitiveEligibility",
          ),
        ),
      ),
    ).toEqual(["services/verified-training-analysis.ts"]);
    expect(
      candidateParameterType(
        functionDeclaration(integritySource, "scoreVerifiedCandidate"),
      ),
    ).toBe("VerifiedAttemptCandidate");
    expect(
      candidateParameterType(
        functionDeclaration(policySource, "evaluateCompetitiveEligibility"),
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

  it("resolves constant-computed and local-alias capability, score, and policy calls before accepting a topology proof", () => {
    const program = virtualProgram({
      "/capability.ts": "export function c5BoundEvidenceExecution() {}",
      "/domain.ts": [
        "export function evaluateWallPassV1() {}",
        "export function evaluateCompetitiveEligibility() {}",
      ].join("\n"),
      "/entry.ts": [
        'import { c5BoundEvidenceExecution as capabilityByAlias } from "./capability";',
        'import * as capability from "./capability";',
        'import { evaluateWallPassV1 as scoreByAlias, evaluateCompetitiveEligibility as policyByAlias } from "./domain";',
        'const capabilityKey = "c5BoundEvidenceExecution" as const;',
        "const capabilityByLocalAlias = capabilityByAlias;",
        "const scoreByLocalAlias = scoreByAlias;",
        "const policyByLocalAlias = policyByAlias;",
        "capabilityByAlias();",
        "capability.c5BoundEvidenceExecution();",
        'capability["c5BoundEvidenceExecution"]();',
        "capability[capabilityKey]();",
        "capabilityByLocalAlias();",
        "scoreByAlias();",
        "scoreByLocalAlias();",
        "policyByAlias();",
        "policyByLocalAlias();",
      ].join("\n"),
    });
    const checker = program.getTypeChecker();
    const capability = program.getSourceFile("/capability.ts");
    const domain = program.getSourceFile("/domain.ts");
    const entry = program.getSourceFile("/entry.ts");
    if (!capability || !domain || !entry)
      throw new Error("virtual topology source missing");
    const target = declaredSymbol(
      checker,
      capability,
      "c5BoundEvidenceExecution",
    );

    expect(callSitesForSymbol(checker, [entry], target)).toHaveLength(5);
    expect(
      callSitesForSymbol(
        checker,
        [entry],
        declaredSymbol(checker, domain, "evaluateWallPassV1"),
      ),
    ).toEqual(["/entry.ts", "/entry.ts"]);
    expect(
      callSitesForSymbol(
        checker,
        [entry],
        declaredSymbol(checker, domain, "evaluateCompetitiveEligibility"),
      ),
    ).toEqual(["/entry.ts", "/entry.ts"]);
  });
});

function functionDeclaration(
  source: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | undefined {
  let result: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      result = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

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
      if (!name.startsWith("./")) return undefined;
      const resolvedFileName = resolve(
        containingFile,
        "..",
        `${name.slice(2)}.ts`,
      );
      if (!read(resolvedFileName)) return undefined;
      return {
        resolvedFileName,
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
  return calledExpressionSymbol(checker, call.expression, new Set());
}

function calledExpressionSymbol(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  visited: ReadonlySet<ts.Symbol>,
): ts.Symbol | undefined {
  if (ts.isIdentifier(expression))
    return resolveLocalConstAlias(
      checker,
      checker.getSymbolAtLocation(expression),
      visited,
    );
  if (ts.isPropertyAccessExpression(expression))
    return resolveLocalConstAlias(
      checker,
      checker.getSymbolAtLocation(expression.name),
      visited,
    );
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    const key = ts.isStringLiteral(argument)
      ? argument.text
      : literalStringValue(checker.getTypeAtLocation(argument));
    if (key)
      return resolveLocalConstAlias(
        checker,
        checker.getPropertyOfType(
          checker.getTypeAtLocation(expression.expression),
          key,
        ),
        visited,
      );
  }
  return undefined;
}

function resolveLocalConstAlias(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  visited: ReadonlySet<ts.Symbol>,
): ts.Symbol | undefined {
  if (!symbol) return undefined;
  const resolved =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  if (visited.has(resolved)) return resolved;
  const declaration = resolved.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const) ||
    !declaration.initializer
  )
    return resolved;
  return calledExpressionSymbol(
    checker,
    declaration.initializer,
    new Set([...visited, resolved]),
  );
}

function literalStringValue(type: ts.Type): string | undefined {
  return type.flags & ts.TypeFlags.StringLiteral
    ? (type as ts.StringLiteralType).value
    : undefined;
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
