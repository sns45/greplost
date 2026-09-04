/**
 * TypeScript framework signal truth (build 2, leaf 2.3; spec 2026-09-04 section 3.7).
 *
 * The oracle is the **TypeScript compiler**: a `ts.Program` over the same file list greplost
 * indexed, walked with the type checker available. It reuses `truth/ts.ts`'s program
 * construction — the workspace emulation of ruling 10.3, which stands in for the installed and
 * built state a corpus clone does not have — and **none** of its edge logic. It imports nothing
 * from `packages/core/src/signals`; `bench/test/signals-ts.test.ts` asserts that, because an
 * oracle that shares code with what it scores measures nothing at all.
 *
 * What it produces:
 *   `generateExtra` -> the signal **node set** S6 scores, and the `resource-input` and
 *                      `route-handler` **reference edges** that fold into S5.
 *   `generateTruth` -> the covered file list, with S1 to S4 declared unsupported: this module
 *                      is not an import/export/call oracle and must never be mistaken for one
 *                      (`truth/ts.ts` is, and the harness uses it for the TypeScript family).
 *
 * The four rules, and what makes each of them a *checker* judgement rather than a text match:
 *
 *  - **components**: the checker's return type when it resolves (`JSX.Element`, `ReactNode`,
 *    `ReactElement`), and the callee's resolved symbol for a `React.memo`/`forwardRef` wrapper,
 *    so a locally defined `memo` is not React's. A syntactic JSX return is the fallback for a
 *    program with no React types on disk, which is every corpus clone.
 *  - **Pulumi resources**: `checker.getTypeAtLocation(X)`'s declared class walked up its
 *    base-type chain for `pulumi.CustomResource` / `pulumi.ComponentResource` — the check only a
 *    checker can make. Where the class has no declaration to walk (a provider SDK that is not
 *    installed), the fallback is the *resolved symbol's* import specifier, which is still a
 *    binding question rather than a text one.
 *  - **TanStack routes**: the callee symbol's declaration must live in `@tanstack/react-start`
 *    or `@tanstack/react-router`.
 *  - **Next.js routes**: an independent implementation of the App Router path rules, plus the
 *    checker's module exports for the HTTP-method functions.
 *
 * Determinism: files are walked in sorted order, nodes in source order, and every list comes
 * back sorted. Nothing here reads the clock or the environment.
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { compareStrings, type ReferenceEdge } from "@greplost/core/schema";
import { WorkspaceEntryMapper } from "./ts-workspace.ts";
import type { Truth } from "./ts.ts";

export const NOTES: readonly string[] = ["tsc-checker-oracle", "base-type-chain-for-pulumi", "app-router-path-rules"];

/**
 * S1 to S4 are not this oracle's business. Declaring them unsupported is what stops a caller
 * that reaches for `generateTruth` from scoring greplost's imports against an empty set and
 * publishing four vacuous 1.000s.
 */
const UNSUPPORTED = ["unsupported:S1", "unsupported:S2", "unsupported:S3", "unsupported:S4"] as const;

/** Return types that mean "this returns JSX", when the program has React types to say so. */
const JSX_RETURN_TYPES: ReadonlySet<string> = new Set(["Element", "ReactElement", "ReactNode", "JSX.Element"]);
/** The two wrappers spec 3.2 names. */
const REACT_WRAPPERS: ReadonlySet<string> = new Set(["memo", "forwardRef"]);
/** Packages a TanStack route creator may come from. */
const TANSTACK_PACKAGES = ["@tanstack/react-start", "@tanstack/react-router"] as const;
/** Creator name -> what it creates. */
const TANSTACK_CREATORS: Readonly<Record<string, "file" | "root" | "server">> = {
  createFileRoute: "file",
  createRootRoute: "root",
  createRootRouteWithContext: "root",
  createServerFileRoute: "server",
};
const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** App Router files that name a route, and the `meta.kind` each one carries. */
const APP_ROUTE_FILES: Readonly<Record<string, string>> = { page: "page", layout: "layout", route: "handler" };

const PULUMI_SCOPE = "@pulumi/";
const PULUMI_CORE = "@pulumi/pulumi";
/** Base classes that make a class a Pulumi resource. */
const PULUMI_RESOURCE_BASES: ReadonlySet<string> = new Set([
  "ComponentResource",
  "CustomResource",
  "ProviderResource",
  "Resource",
]);
/** The only concrete resources `@pulumi/pulumi` itself exports (see spec 3.5 and leaf 2.3). */
const PULUMI_CORE_RESOURCES: ReadonlySet<string> = new Set([...PULUMI_RESOURCE_BASES, "StackReference"]);

/** The signal node and reference sets, in greplost's id vocabulary. */
export interface SignalExtra {
  references: ReferenceEdge[];
  nodes: string[];
}

export function generateExtra(root: string, files: string[]): SignalExtra {
  const scan = analyse(root, files);
  return {
    nodes: [...scan.nodes].sort(compareStrings),
    references: scan.references.sort(
      (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.kind, b.kind),
    ),
  };
}

/**
 * The `Truth` shape the registry expects. This oracle covers signals, not imports and calls, so
 * every S1-to-S4 metric is declared unsupported rather than reported as an empty set.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const scan = analyse(root, files);
  const exports: Record<string, string[]> = {};
  for (const file of scan.covered) exports[file] = [];
  return {
    files: [...scan.covered].sort(compareStrings),
    imports: [],
    exports,
    calls: [],
    cycles: [],
    notes: [...NOTES, ...UNSUPPORTED],
  };
}

// ---------------------------------------------------------------------------
// program
// ---------------------------------------------------------------------------

interface Scan {
  covered: string[];
  nodes: Set<string>;
  references: ReferenceEdge[];
  /**
   * `route-handler` records waiting for a target. They cannot be resolved while the files are
   * being walked: the component a route names may live in a file that has not been visited yet.
   */
  pending: PendingHandler[];
}

/** A route that named a handler, before the name was resolved to a node or a declaration. */
interface PendingHandler {
  /** The route node id the reference leaves. */
  from: string;
  /** Repo-relative id of the file that wrote it. */
  file: string;
  sourceFile: ts.SourceFile;
  /** The identifier as written (`component: Home`, `export default Page`). */
  name: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function normalizeId(absRoot: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.join(absRoot, file);
  return toPosix(path.relative(absRoot, absolute));
}

/**
 * Compiler options from `<root>/tsconfig.json`, falling back to bundler resolution.
 *
 * The config's own `files`/`include` are ignored on purpose: the caller decides which files are
 * scored, so the program's root set is exactly the given list. This mirrors `truth/ts.ts`'s
 * reading of the same file; it is program construction, not edge logic.
 */
function readCompilerOptions(absRoot: string): ts.CompilerOptions {
  const configPath = path.join(absRoot, "tsconfig.json");
  const fallback: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
  };
  if (!existsSync(configPath)) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) return fallback;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, absRoot);
  return { ...parsed.options, allowJs: true, noEmit: true, jsx: parsed.options.jsx ?? ts.JsxEmit.Preserve };
}

function analyse(root: string, files: string[]): Scan {
  const absRoot = path.resolve(root);
  const requested = [...new Set(files.map((file) => normalizeId(absRoot, file)))].sort(compareStrings);
  const compilerOptions = readCompilerOptions(absRoot);
  const canonical = ts.sys.useCaseSensitiveFileNames ? (p: string) => p : (p: string) => p.toLowerCase();
  const rootNames = requested.map((id) => path.join(absRoot, id));

  // The workspace emulation (ruling 10.3): a corpus clone has no node_modules and no dist, so
  // the compiler cannot resolve the repo's own packages by name without it.
  const workspace = WorkspaceEntryMapper.load(absRoot);
  const requestedByPath = new Set<string>();
  for (const name of rootNames) {
    requestedByPath.add(canonical(toPosix(name)));
    try {
      requestedByPath.add(canonical(toPosix(realpathSync(name))));
    } catch {
      // Listed but absent; the literal path is enough for the resolver.
    }
  }
  const resolutionCache = ts.createModuleResolutionCache(absRoot, canonical, compilerOptions);
  const resolveModuleFile = (specifier: string, containingFile: string): string | undefined => {
    const standard = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys, resolutionCache);
    const found = standard.resolvedModule?.resolvedFileName;
    if (found !== undefined && requestedByPath.has(canonical(toPosix(found)))) return found;
    if (!workspace.enabled) return found;
    const candidates =
      found !== undefined
        ? [...workspace.candidatesForBuiltFile(found), ...workspace.candidatesForSpecifier(specifier)]
        : workspace.candidatesForSpecifier(specifier);
    for (const candidate of candidates) {
      if (requestedByPath.has(canonical(toPosix(candidate)))) return candidate;
    }
    return found;
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      const resolvedFileName = resolveModuleFile(literal.text, containingFile);
      if (resolvedFileName === undefined) return { resolvedModule: undefined };
      return {
        resolvedModule: {
          resolvedFileName,
          extension: path.extname(resolvedFileName),
          isExternalLibraryImport: resolvedFileName.includes("/node_modules/"),
        },
      };
    });

  const program = ts.createProgram(rootNames, compilerOptions, host);
  const checker = program.getTypeChecker();

  const covered: { id: string; sourceFile: ts.SourceFile }[] = [];
  for (const id of requested) {
    const sourceFile = program.getSourceFile(path.join(absRoot, id));
    if (sourceFile !== undefined) covered.push({ id, sourceFile });
  }

  // An oracle that quietly covered nothing would score every prediction as a false positive,
  // or (worse) score an empty prediction as perfect. Neither is a result; it is a broken run.
  if (covered.length === 0 && requested.length > 0) {
    throw new Error(
      `greplost: the signals-ts oracle loaded none of ${requested.length} file(s) under ${absRoot}; ` +
        `the program could not be built (check tsconfig.json and the file list)`,
    );
  }

  const scan: Scan = { covered: covered.map((entry) => entry.id), nodes: new Set(), references: [], pending: [] };
  for (const { id, sourceFile } of covered) visitFile(id, sourceFile, checker, scan);
  // Every file has contributed its nodes, so a route may now be pointed at one that lives in
  // another file. Doing this inside the walk would make the answer depend on file order.
  resolveRouteHandlers(scan, checker, absRoot);
  return scan;
}

// ---------------------------------------------------------------------------
// per-file rules
// ---------------------------------------------------------------------------

/** Node names stay unique inside one file; a duplicate takes `~<n>` from 2 (schema 2). */
class Names {
  private readonly used = new Map<string, number>();
  take(name: string): string {
    const seen = this.used.get(name);
    if (seen === undefined) {
      this.used.set(name, 1);
      return name;
    }
    const next = seen + 1;
    this.used.set(name, next);
    return `${name}~${next}`;
  }
}

function visitFile(id: string, sourceFile: ts.SourceFile, checker: ts.TypeChecker, scan: Scan): void {
  const text = sourceFile.getFullText();
  reactNodes(id, sourceFile, checker, scan, text);
  tanstackNodes(id, sourceFile, checker, scan);
  nextNodes(id, sourceFile, checker, scan);
  pulumiNodes(id, sourceFile, checker, scan);
}

function nodeIdOf(file: string, kind: string, name: string): string {
  return `${file}#${kind}.${name}`;
}

function reference(
  from: string,
  to: string,
  refKind: ReferenceEdge["refKind"],
  symbols: string[],
): ReferenceEdge {
  return { from, to, kind: "reference", refKind, symbols, confidence: "high" };
}

// ------------------------------------------------------------------- react

function reactApplies(file: string, text: string): boolean {
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) return true;
  return text.includes('from "react"') || text.includes("from 'react'");
}

function reactNodes(
  file: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  scan: Scan,
  text: string,
): void {
  if (!reactApplies(file, text)) return;
  const names = new Names();
  for (const binding of topLevelBindings(sourceFile)) {
    if (!/^[A-Z]/.test(binding.name)) continue;
    if (!isComponent(binding, checker)) continue;
    scan.nodes.add(nodeIdOf(file, "component", names.take(binding.name)));
  }
}

interface Binding {
  name: string;
  /** The declaration itself: a function, a class, or a variable declaration. */
  declaration: ts.Node;
  /** A variable declaration's initialiser, parens and casts looked through. */
  initializer: ts.Expression | undefined;
  exported: boolean;
  isDefault: boolean;
}

function topLevelBindings(sourceFile: ts.SourceFile): Binding[] {
  const out: Binding[] = [];
  for (const statement of sourceFile.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? (isDefault ? "default" : undefined);
      if (name !== undefined) out.push({ name, declaration: statement, initializer: undefined, exported, isDefault });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      out.push({
        name: declaration.name.text,
        declaration,
        initializer: declaration.initializer === undefined ? undefined : unwrap(declaration.initializer),
        exported,
        isDefault,
      });
    }
  }
  return out;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (let guard = 0; guard < 8; guard += 1) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return current;
}

function isComponent(binding: Binding, checker: ts.TypeChecker): boolean {
  if (isReactWrapped(binding.initializer, checker)) return true;
  const fn = functionOf(binding);
  if (fn === undefined) return ts.isClassLike(binding.declaration) ? classReturnsJsx(binding.declaration) : false;
  if (returnTypeIsJsx(fn, checker)) return true;
  return functionReturnsJsx(fn);
}

function functionOf(binding: Binding): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionDeclaration(binding.declaration)) return binding.declaration;
  const value = binding.initializer;
  if (value === undefined) return undefined;
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
  const wrapped = wrappedFunction(value);
  return wrapped;
}

/** `memo(forwardRef(fn))`: the function the wrappers are applied to. */
function wrappedFunction(value: ts.Expression): ts.SignatureDeclaration | undefined {
  let current: ts.Expression | undefined = value;
  for (let guard = 0; guard < 4 && current !== undefined && ts.isCallExpression(current); guard += 1) {
    const first = current.arguments[0];
    if (first === undefined) return undefined;
    const inner = unwrap(first);
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner;
    current = inner;
  }
  return undefined;
}

/** True when the value is `React.memo(...)` / `forwardRef(...)` and the callee is react's. */
function isReactWrapped(value: ts.Expression | undefined, checker: ts.TypeChecker): boolean {
  if (value === undefined || !ts.isCallExpression(value)) return false;
  const callee = value.expression;
  const name = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isIdentifier(callee)
      ? callee.text
      : undefined;
  if (name === undefined || !REACT_WRAPPERS.has(name)) return false;
  const root = rootIdentifier(callee);
  if (root === undefined) return false;
  const specifier = importSpecifierOf(checker.getSymbolAtLocation(root));
  if (specifier === "react") return true;
  // A program with no React on disk still binds `React.memo` to the namespace convention;
  // a bare `memo` with no import is somebody else's function and does not count.
  return ts.isPropertyAccessExpression(callee) && root.text === "React";
}

function returnTypeIsJsx(fn: ts.SignatureDeclaration, checker: ts.TypeChecker): boolean {
  const signature = checker.getSignatureFromDeclaration(fn);
  if (signature === undefined) return false;
  const returned = checker.getReturnTypeOfSignature(signature);
  for (const part of returned.isUnion() ? returned.types : [returned]) {
    const symbol = part.getSymbol() ?? part.aliasSymbol;
    if (symbol !== undefined && JSX_RETURN_TYPES.has(symbol.getName())) return true;
  }
  return false;
}

function functionReturnsJsx(fn: ts.SignatureDeclaration): boolean {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (body === undefined) return false;
  if (!ts.isBlock(body)) return holdsJsx(body);
  return blockReturnsJsx(body);
}

function classReturnsJsx(declaration: ts.ClassLikeDeclaration): boolean {
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) || member.body === undefined) continue;
    if (blockReturnsJsx(member.body)) return true;
  }
  return false;
}

/** A `return` whose expression holds JSX, without descending into a nested function. */
function blockReturnsJsx(block: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isFunctionScope(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression !== undefined && holdsJsx(node.expression)) found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return found;
}

function isFunctionScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node)
  );
}

function holdsJsx(expression: ts.Node): boolean {
  if (isJsx(expression)) return true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isJsx(node)) {
      found = true;
      return;
    }
    if (isFunctionScope(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(expression, visit);
  return found;
}

function isJsx(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

// ---------------------------------------------------------------- tanstack

function tanstackNodes(file: string, sourceFile: ts.SourceFile, checker: ts.TypeChecker, scan: Scan): void {
  const names = new Names();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const route = tanstackRoute(node, checker);
      if (route !== undefined) emitTanstackRoute(file, sourceFile, route, names, scan);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

interface TanstackRoute {
  creator: "file" | "root" | "server";
  routePath: string;
  options: ts.ObjectLiteralExpression | undefined;
}

function tanstackRoute(call: ts.CallExpression, checker: ts.TypeChecker): TanstackRoute | undefined {
  const callee = unwrap(call.expression);

  if (ts.isCallExpression(callee)) {
    const creatorName = identifierName(callee.expression);
    const creator = creatorName === undefined ? undefined : TANSTACK_CREATORS[creatorName];
    if (creator === undefined || !isTanstackCallee(callee.expression, checker)) return undefined;
    if (creator === "root") return { creator, routePath: "/", options: objectArgument(call) };
    const literal = stringArgument(callee);
    if (literal === undefined) return undefined;
    return { creator, routePath: literal, options: objectArgument(call) };
  }

  const creatorName = identifierName(callee);
  const creator = creatorName === undefined ? undefined : TANSTACK_CREATORS[creatorName];
  if (creator !== "root" || !isTanstackCallee(callee, checker)) return undefined;
  // `createRootRouteWithContext<C>()` is the callee of the call that carries the options; the
  // route belongs to the outer call, and counting both would double it.
  if (call.parent !== undefined && ts.isCallExpression(call.parent) && call.parent.expression === call) return undefined;
  return { creator, routePath: "/", options: objectArgument(call) };
}

function isTanstackCallee(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const root = ts.isIdentifier(expression) ? expression : rootIdentifier(expression);
  if (root === undefined) return false;
  const specifier = importSpecifierOf(checker.getSymbolAtLocation(root));
  return specifier !== undefined && (TANSTACK_PACKAGES as readonly string[]).includes(specifier);
}

function emitTanstackRoute(
  file: string,
  sourceFile: ts.SourceFile,
  route: TanstackRoute,
  names: Names,
  scan: Scan,
): void {
  const routeName = names.take(route.routePath);
  scan.nodes.add(nodeIdOf(file, "route", routeName));
  if (route.options === undefined) return;
  for (const property of route.options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyName(property.name);
    if (key === undefined) continue;
    if (key === "loader" || key === "beforeLoad" || (route.creator === "server" && HTTP_METHODS.has(key))) {
      scan.nodes.add(nodeIdOf(file, "handler", names.take(key)));
      continue;
    }
    if (key !== "component") continue;
    const value = unwrap(property.initializer);
    if (!ts.isIdentifier(value)) continue;
    // The target is resolved once every file has been walked: spec 3.4 allows the component
    // node *or* the declaration, and the name may be imported. See `resolveRouteHandlers`.
    scan.pending.push({ from: nodeIdOf(file, "route", routeName), file, sourceFile, name: value.text });
  }
}

// --------------------------------------------------- route-handler targets

/** Kinds a `route-handler` may land on, most specific first (spec 3.4). */
const HANDLER_KINDS = ["component", "handler"] as const;

/** "This name resolves more than one way here", which is never an edge. */
const AMBIGUOUS = Symbol("ambiguous");

type Resolution = string | undefined | typeof AMBIGUOUS;

/**
 * Point every deferred `route-handler` at what the name actually denotes.
 *
 * Spec 3.4 lets the target be the referenced **component node or the declaration**, and the
 * name may be imported: `references/ts.ts` looks in the file first and then through exactly one
 * import record. The oracle used to hard-code a same-file `component.<name>`, which scored a
 * rule greplost never implemented — every route whose component lives in another file was a
 * false positive on one side and a false negative on the other. This resolves the name the same
 * way, from the compiler's own bindings, and drops anything ambiguous rather than guessing.
 */
function resolveRouteHandlers(scan: Scan, checker: ts.TypeChecker, absRoot: string): void {
  const covered = new Set(scan.covered);
  const topLevelNames = new Map<ts.SourceFile, Set<string>>();
  const namesOf = (sourceFile: ts.SourceFile): Set<string> => {
    const cached = topLevelNames.get(sourceFile);
    if (cached !== undefined) return cached;
    const names = new Set(topLevelBindings(sourceFile).map((binding) => binding.name));
    topLevelNames.set(sourceFile, names);
    return names;
  };

  for (const item of scan.pending) {
    const local = resolveHandlerIn(item.file, item.sourceFile, item.name, scan, namesOf);
    if (local === AMBIGUOUS) continue;
    const to =
      local ?? resolveHandlerThroughImport(item.sourceFile, item.name, scan, checker, absRoot, covered, namesOf);
    if (to === undefined) continue;
    scan.references.push(reference(item.from, to, "route-handler", [item.name]));
  }
}

/**
 * The node or declaration `name` denotes inside one file: a `component` or `handler` node
 * first, then the plain declaration.
 *
 * A file holding both `component.X` and `component.X~2` bound the name twice, so nothing may
 * resolve to either — the same rule `references/ts.ts` applies.
 */
function resolveHandlerIn(
  file: string,
  sourceFile: ts.SourceFile,
  name: string,
  scan: Scan,
  namesOf: (sourceFile: ts.SourceFile) => Set<string>,
): Resolution {
  for (const kind of HANDLER_KINDS) {
    const id = nodeIdOf(file, kind, name);
    if (!scan.nodes.has(id)) continue;
    if (scan.nodes.has(nodeIdOf(file, kind, `${name}~2`))) return AMBIGUOUS;
    return id;
  }
  return namesOf(sourceFile).has(name) ? `${file}#${name}` : undefined;
}

/**
 * The target `name` denotes after exactly one import hop, or undefined.
 *
 * Literal, like the linker's: exactly one import clause may bind the name, its module must
 * resolve to a file in the scored set, and that file must declare the name. A namespace import
 * binds a module rather than a declaration and is never a target.
 */
function resolveHandlerThroughImport(
  sourceFile: ts.SourceFile,
  name: string,
  scan: Scan,
  checker: ts.TypeChecker,
  absRoot: string,
  covered: ReadonlySet<string>,
  namesOf: (sourceFile: ts.SourceFile) => Set<string>,
): string | undefined {
  const matches = importBindingsFor(sourceFile, name);
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined || only.exported === "*") return undefined;

  const target = moduleSourceFile(only.declaration, checker);
  if (target === undefined) return undefined;
  const id = normalizeId(absRoot, target.fileName);
  if (!covered.has(id)) return undefined;

  const exported = only.exported === "default" ? defaultExportName(target) : only.exported;
  if (exported === undefined) return undefined;
  const resolved = resolveHandlerIn(id, target, exported, scan, namesOf);
  return resolved === AMBIGUOUS ? undefined : resolved;
}

/** Every import clause of `sourceFile` that binds the local name `name`. */
function importBindingsFor(
  sourceFile: ts.SourceFile,
  name: string,
): Array<{ declaration: ts.ImportDeclaration; exported: string }> {
  const out: Array<{ declaration: ts.ImportDeclaration; exported: string }> = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name?.text === name) out.push({ declaration: statement, exported: "default" });
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (bindings.name.text === name) out.push({ declaration: statement, exported: "*" });
      continue;
    }
    for (const element of bindings.elements) {
      if (element.name.text === name) {
        out.push({ declaration: statement, exported: (element.propertyName ?? element.name).text });
      }
    }
  }
  return out;
}

/** The file an import declaration resolves to, through the program's own module resolution. */
function moduleSourceFile(
  declaration: ts.ImportDeclaration,
  checker: ts.TypeChecker,
): ts.SourceFile | undefined {
  const symbol = checker.getSymbolAtLocation(declaration.moduleSpecifier);
  for (const found of symbol?.declarations ?? []) {
    if (ts.isSourceFile(found)) return found;
  }
  return undefined;
}

// -------------------------------------------------------------------- next

/**
 * The App Router path rules, implemented here from the spec rather than shared with the pass.
 *
 * Segments under the last `app/` directory; `(group)` dropped; `@slot` dropped; `[id]`,
 * `[...rest]` and `[[...opt]]` kept verbatim.
 */
export function appRoutePath(file: string): string | undefined {
  const parts = file.split("/");
  const app = parts.lastIndexOf("app");
  if (app < 0 || app === parts.length - 1) return undefined;
  const kept: string[] = [];
  for (const segment of parts.slice(app + 1, parts.length - 1)) {
    if (segment.startsWith("(") && segment.endsWith(")")) continue;
    if (segment.startsWith("@")) continue;
    kept.push(segment);
  }
  return kept.length === 0 ? "/" : `/${kept.join("/")}`;
}

function appRouteFile(file: string): string | undefined {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = base.slice(dot);
  if (![".ts", ".tsx", ".js", ".jsx"].includes(extension)) return undefined;
  const stem = base.slice(0, dot);
  return APP_ROUTE_FILES[stem];
}

function nextNodes(file: string, sourceFile: ts.SourceFile, checker: ts.TypeChecker, scan: Scan): void {
  const kind = appRouteFile(file);
  const routePath = appRoutePath(file);
  if (kind === undefined || routePath === undefined) return;

  const names = new Names();
  const routeName = names.take(routePath);
  scan.nodes.add(nodeIdOf(file, "route", routeName));

  if (kind === "handler") {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    const exported = moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol);
    const methods = exported
      .filter((symbol) => HTTP_METHODS.has(symbol.getName()))
      .filter((symbol) => (symbol.declarations ?? []).some(declaresFunction))
      .map((symbol) => symbol.getName())
      .sort(compareStrings);
    for (const method of methods) scan.nodes.add(nodeIdOf(file, "handler", names.take(method)));
    return;
  }

  if (kind !== "page") return;
  const component = defaultExportName(sourceFile);
  if (component === undefined) return;
  scan.pending.push({ from: nodeIdOf(file, "route", routeName), file, sourceFile, name: component });
}

function declaresFunction(declaration: ts.Declaration): boolean {
  if (ts.isFunctionDeclaration(declaration)) return true;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false;
  const value = unwrap(declaration.initializer);
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value);
}

function defaultExportName(sourceFile: ts.SourceFile): string | undefined {
  for (const statement of sourceFile.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name?.text;
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals === true) continue;
    const value = unwrap(statement.expression);
    if (ts.isIdentifier(value)) return value.text;
  }
  return undefined;
}

// ------------------------------------------------------------------ pulumi

function pulumiNodes(file: string, sourceFile: ts.SourceFile, checker: ts.TypeChecker, scan: Scan): void {
  if (!sourceFile.getFullText().includes(PULUMI_SCOPE)) return;
  const names = new Names();
  /** Binding name -> node name, so an argument reading `bucket.id` finds the right node. */
  const byBinding = new Map<string, string>();
  const pending: Array<{ name: string; call: ts.NewExpression }> = [];
  let anonymous = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && isPulumiResource(node.expression, checker)) {
      const binding = newBindingName(node);
      const name = names.take(binding ?? `~${anonymous}`);
      if (binding === undefined) anonymous += 1;
      else if (!byBinding.has(binding)) byBinding.set(binding, name);
      scan.nodes.add(nodeIdOf(file, "resource", name));
      pending.push({ name, call: node });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  for (const { name, call } of pending) {
    for (const [address, target] of resourceInputs(call, byBinding, name)) {
      scan.references.push(
        reference(nodeIdOf(file, "resource", name), nodeIdOf(file, "resource", target), "resource-input", [address]),
      );
    }
  }
}

/**
 * The structural resource check.
 *
 * First the checker's declared class and its base-type chain — the judgement only a checker can
 * make. When the class has no declaration in the program (a provider SDK that is not installed,
 * which is every corpus clone), the fallback is the *resolved symbol's* import specifier, with
 * the core SDK narrowed to its resource classes: `new pulumi.Config()` is not a resource.
 */
function isPulumiResource(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const declaration = classDeclarationOf(expression, checker);
  if (declaration !== undefined) return extendsPulumiResource(declaration, checker, new Set());

  const root = rootIdentifier(expression);
  if (root === undefined) return false;
  const specifier = importSpecifierOf(checker.getSymbolAtLocation(root));
  if (specifier === undefined || !specifier.startsWith(PULUMI_SCOPE)) return false;
  const className = expressionTailName(expression);
  if (className === undefined) return false;
  if (specifier === PULUMI_CORE || specifier.startsWith(`${PULUMI_CORE}/`)) {
    if (!PULUMI_CORE_RESOURCES.has(className)) return false;
    // `pulumi.asset.FileAsset` hops through a namespace; a core resource never does.
    return !(ts.isPropertyAccessExpression(expression) && ts.isPropertyAccessExpression(expression.expression));
  }
  return true;
}

function classDeclarationOf(expression: ts.Expression, checker: ts.TypeChecker): ts.ClassLikeDeclaration | undefined {
  const candidates: Array<ts.Symbol | undefined> = [];
  const type = checker.getTypeAtLocation(expression);
  candidates.push(type.getSymbol());
  candidates.push(checker.getSymbolAtLocation(expression));
  for (const candidate of candidates) {
    const symbol = resolveAlias(candidate, checker);
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isClassLike(declaration)) return declaration;
    }
  }
  return undefined;
}

function resolveAlias(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (symbol === undefined) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function extendsPulumiResource(
  declaration: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
): boolean {
  if (seen.has(declaration)) return false;
  seen.add(declaration);
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      const name = expressionTailName(type.expression);
      if (name !== undefined && PULUMI_RESOURCE_BASES.has(name) && fromPulumi(type.expression, checker)) return true;
      const base = classDeclarationOf(type.expression, checker);
      if (base !== undefined && extendsPulumiResource(base, checker, seen)) return true;
    }
  }
  return false;
}

function fromPulumi(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const root = rootIdentifier(expression);
  if (root === undefined) return false;
  const specifier = importSpecifierOf(checker.getSymbolAtLocation(root));
  if (specifier !== undefined) return specifier.startsWith(PULUMI_SCOPE);
  // The class was declared in a file the program loaded from a `@pulumi/*` package.
  const declaration = classDeclarationOf(expression, checker);
  return declaration !== undefined && declaration.getSourceFile().fileName.includes("/@pulumi/");
}

function newBindingName(call: ts.NewExpression): string | undefined {
  const parent = call.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    return parent.left.text;
  }
  return undefined;
}

/** `[address, target node name]` for every `<var>.<prop>` in the arguments naming a resource. */
function resourceInputs(
  call: ts.NewExpression,
  byBinding: ReadonlyMap<string, string>,
  self: string,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const target = byBinding.get(node.expression.text);
      const address = `${node.expression.text}.${node.name.text}`;
      if (target !== undefined && target !== self && !seen.has(address)) {
        seen.add(address);
        out.push([address, target]);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const argument of call.arguments ?? []) visit(argument);
  return out;
}

// ------------------------------------------------------------------ shared

function identifierName(expression: ts.Expression): string | undefined {
  const inner = unwrap(expression);
  return ts.isIdentifier(inner) ? inner.text : undefined;
}

/** The leftmost identifier of an identifier or property-access chain. */
function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current: ts.Expression = unwrap(expression);
  for (let guard = 0; guard < 16; guard += 1) {
    if (ts.isIdentifier(current)) return current;
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** The last name of an identifier or property-access chain: `aws.s3.Bucket` -> `Bucket`. */
function expressionTailName(expression: ts.Expression): string | undefined {
  const inner = unwrap(expression);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  if (ts.isExpressionWithTypeArguments(inner)) return expressionTailName(inner.expression);
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function stringArgument(call: ts.CallExpression): string | undefined {
  const first = call.arguments[0];
  if (first === undefined) return undefined;
  const inner = unwrap(first);
  return ts.isStringLiteralLike(inner) ? inner.text : undefined;
}

function objectArgument(call: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  const first = call.arguments[0];
  if (first === undefined) return undefined;
  const inner = unwrap(first);
  return ts.isObjectLiteralExpression(inner) ? inner : undefined;
}

/** The module a symbol was imported from, when it was imported at all. */
function importSpecifierOf(symbol: ts.Symbol | undefined): string | undefined {
  for (const declaration of symbol?.declarations ?? []) {
    const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);
    if (importDeclaration !== undefined && ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) {
      return importDeclaration.moduleSpecifier.text;
    }
    const equals = ts.findAncestor(declaration, ts.isImportEqualsDeclaration);
    if (
      equals !== undefined &&
      ts.isExternalModuleReference(equals.moduleReference) &&
      ts.isStringLiteralLike(equals.moduleReference.expression)
    ) {
      return equals.moduleReference.expression.text;
    }
  }
  return undefined;
}
