/**
 * TypeScript compiler truth for Eval 1 (tech spec 10.3, bench spec 1.5.1).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2):
 * this module asks `typescript` itself what the imports, exports, calls and cycles
 * of a repo are, in greplost's own id vocabulary (tech spec 5.3), so both sides of
 * every comparison speak the same language.
 *
 * This file owns the program, module resolution, imports, exports and cycles;
 * `truth/ts-calls.ts` owns call resolution and symbol paths, and `truth/ts-workspace.ts`
 * emulates the installed-and-built state of the repo's own workspace packages.
 *
 * The public surface is `generateTsTruth(root, files, options?)` returning `Truth`:
 *   files   -> the subset of `files` the program actually loaded, which every consumer must
 *              intersect its own file set with before scoring (a file the compiler never saw
 *              is not "a file that exports nothing");
 *   imports / exports / calls / cycles -> the truth sets themselves;
 *   notes   -> emulations applied, for `RESULTS.md` to disclose.
 * The optional third argument (`TruthOptions`) currently carries only `diagnostics`, which
 * turns on the expensive semantic check. The two-argument form in the bench spec still
 * type-checks unchanged.
 *
 * Identity, restated for this file:
 *   file   -> repo-relative posix path, no leading "./"
 *   symbol -> `<file>#<Name>` or `<file>#<Class>.<member>`
 *   caller -> the enclosing declaration that owns its calls (see `ts-calls.ts`), or the
 *             file id for top-level code.
 *
 * Conservatism rules (a truth set that over-claims is worse than useless):
 *   - only files the program actually loaded *and* the caller listed are in the scored
 *     universe; lib.d.ts, node_modules and unlisted files are dropped from both ends of
 *     every edge, and a listed file the program could not load is dropped entirely
 *     (`Truth.files` reports what survived);
 *   - module-loading expressions (`import("x")`, `require("x")`) are import edges, never
 *     call edges.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { compareEdges, compareStrings, type Edge } from "@greplost/core/schema";
import { resolveCallEdge } from "./ts-calls.ts";
import type { CallLike } from "./ts-calls.ts";
import { WorkspaceEntryMapper } from "./ts-workspace.ts";

/** Compiler truth for one repo, in greplost ids. */
export interface Truth {
  /**
   * The files this truth actually covers: the caller's list minus anything the program
   * could not load. Consumers must intersect their own file set with this before scoring,
   * otherwise a file the compiler never saw is scored as "exports nothing".
   */
  files: string[];
  /** Import and re-export edges between covered files, sorted with `compareEdges`. */
  imports: Edge[];
  /** file id -> exported names, sorted. Every covered file is a key. */
  exports: Record<string, string[]>;
  /** Call edges between covered files, sorted with `compareEdges`. */
  calls: Edge[];
  /** Tarjan SCCs of size > 1 over the import graph; each cycle sorted, the list sorted. */
  cycles: string[][];
  /**
   * Emulations the truth generator applied, for `RESULTS.md` to disclose. Currently only
   * `workspace-entry-mapping` (see `truth/ts-workspace.ts`), present when at least one edge
   * came from it.
   */
  notes: string[];
}

/** Source extensions the TypeScript truth covers. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
/** Extensions a module specifier may be written with that map back to a source file. */
const CANDIDATE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".greplost"]);

/**
 * Repo-relative posix paths of the TypeScript sources under `root`, sorted.
 * Declaration files are excluded: they describe other files rather than being code.
 */
export function listTypeScriptFiles(root: string): string[] {
  const absRoot = path.resolve(root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.mts") || entry.name.endsWith(".d.cts")) continue;
      if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      out.push(toPosix(path.relative(absRoot, path.join(dir, entry.name))));
    }
  };
  walk(absRoot);
  return out.sort(compareStrings);
}

/** Options for `generateTsTruth`. */
export interface TruthOptions {
  /**
   * Run a full semantic check and report the diagnostic count on stderr.
   *
   * Off by default: `getSemanticDiagnostics()` type-checks the whole program, including
   * every `@types` package the config pulls in, which costs far more than building the
   * truth set itself. Turn it on with `structural --diagnostics` or
   * `GREPLOST_BENCH_DIAGNOSTICS=1` when a truth set looks wrong and you need to know
   * whether the compiler understood the repo at all.
   */
  diagnostics?: boolean;
}

/** Whether semantic diagnostics are on: the explicit option, else the environment. */
function diagnosticsEnabled(options: TruthOptions): boolean {
  if (options.diagnostics !== undefined) return options.diagnostics;
  return process.env["GREPLOST_BENCH_DIAGNOSTICS"] === "1";
}

/**
 * Compiler truth for `files` (repo-relative posix paths) under `root`.
 *
 * Compiler options come from `<root>/tsconfig.json` via `ts.parseJsonConfigFileContent`,
 * falling back to bundler resolution when there is no config. Config errors are always
 * reported on stderr: a truth set built from a program that could not understand the repo
 * is not trustworthy, and silence would hide that. The far more expensive semantic
 * diagnostic count is opt-in (see `TruthOptions.diagnostics`).
 */
export function generateTsTruth(root: string, files: string[], options: TruthOptions = {}): Truth {
  const absRoot = path.resolve(root);
  // Sorted, unique, normalised: the root file order reaches the program, and the program's
  // declaration order reaches the output, so this is part of the determinism contract.
  const requested = [...new Set(files.map((file) => normalizeId(absRoot, file)))].sort(compareStrings);

  const { options: compilerOptions, configErrors } = readCompilerOptions(absRoot);
  const canonical = ts.sys.useCaseSensitiveFileNames ? (p: string) => p : (p: string) => p.toLowerCase();
  const rootNames = requested.map((id) => path.join(absRoot, id));

  // A corpus clone has no node_modules and no dist, so the compiler cannot resolve the repo's
  // own workspace packages by name. The mapping is installed on the *compiler host* rather
  // than applied afterwards, so the checker sees those modules too: otherwise imports would
  // resolve (S1) while every call into a workspace package stayed unresolved (S3).
  // See truth/ts-workspace.ts for why emulating the installed state is the oracle's job.
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
  let workspaceEdges = 0;

  /**
   * Resolve one specifier the way an installed, built workspace would. Falls back to
   * whatever the standard resolver found (including real node_modules packages), so nothing
   * outside the workspace changes.
   */
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
      if (requestedByPath.has(canonical(toPosix(candidate)))) {
        workspaceEdges += 1;
        return candidate;
      }
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
          extension: extensionOf(resolvedFileName),
          isExternalLibraryImport: resolvedFileName.includes("/node_modules/"),
        },
      };
    });

  const program = ts.createProgram(rootNames, compilerOptions, host);
  const checker = program.getTypeChecker();

  // Files the program could not load leave the scored universe entirely: recording them
  // as "exports nothing" would score real exports as false positives.
  const covered: { id: string; absolute: string; sourceFile: ts.SourceFile }[] = [];
  const missing: string[] = [];
  for (const id of requested) {
    const absolute = path.join(absRoot, id);
    const sourceFile = program.getSourceFile(absolute);
    if (sourceFile) covered.push({ id, absolute, sourceFile });
    else missing.push(id);
  }
  reportDiagnostics(program, configErrors, covered.length, missing, diagnosticsEnabled(options));

  const idByPath = new Map<string, string>();
  for (const { id, absolute } of covered) {
    idByPath.set(canonical(toPosix(absolute)), id);
    // TypeScript resolves modules through symlinks by default (`preserveSymlinks: false`),
    // so a workspace package linked into node_modules, or a repo checked out under a
    // symlinked path, comes back as its real path. Index that too; the first id wins.
    try {
      const real = canonical(toPosix(realpathSync(absolute)));
      if (!idByPath.has(real)) idByPath.set(real, id);
    } catch {
      // The file may have vanished since the program read it; the literal path is already
      // indexed, which is all the resolver needs.
    }
  }

  /** Absolute file name -> covered file id, following `.js`/`.d.ts` specifiers back to source. */
  const toId = (fileName: string): string | undefined => {
    const direct = idByPath.get(canonical(toPosix(fileName)));
    if (direct !== undefined) return direct;
    for (const candidate of sourceCandidates(fileName)) {
      const hit = idByPath.get(canonical(toPosix(candidate)));
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const imports = new EdgeSet();
  const calls = new EdgeSet();
  const exports: Record<string, string[]> = {};

  for (const { id: fileId, sourceFile } of covered) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    exports[fileId] = moduleSymbol ? moduleExportNames(checker, moduleSymbol) : [];

    /** Resolve a module specifier to a covered file id, or undefined. */
    const resolveTarget = (specifier: string, specifierNode: ts.Expression): string | undefined => {
      // Same resolution the program was built with, workspace emulation included.
      const resolvedFile = resolveModuleFile(specifier, sourceFile.fileName);
      const byResolver = resolvedFile !== undefined ? toId(resolvedFile) : undefined;
      if (byResolver !== undefined) return byResolver;

      // Fallback: ask the checker which module the specifier bound to. This catches
      // resolutions the standalone resolver misses (path mappings applied by the program,
      // `.js` specifiers redirected to their `.ts` source, package `exports` maps).
      const symbol = checker.getSymbolAtLocation(specifierNode);
      for (const declaration of symbol?.declarations ?? []) {
        const resolvedId = toId(declaration.getSourceFile().fileName);
        if (resolvedId !== undefined) return resolvedId;
      }
      return undefined;
    };

    const addImport = (kind: "import" | "reexport", specifierNode: ts.Expression, symbols: string[]): void => {
      if (!ts.isStringLiteralLike(specifierNode)) return;
      const target = resolveTarget(specifierNode.text, specifierNode);
      if (target === undefined || target === fileId) return;
      imports.add(fileId, target, kind, symbols);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        addImport("import", node.moduleSpecifier, importedNames(node.importClause));
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        addImport("reexport", node.moduleSpecifier, reexportedNames(node.exportClause));
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        addImport("import", node.moduleReference.expression, ["*"]);
      } else if (ts.isImportTypeNode(node)) {
        // `type X = import("./mod").Foo` is a type-only dependency on ./mod; core emits an
        // ImportRecord of kind "type" for it, which is an `import` edge here.
        const argument = node.argument;
        if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
          addImport("import", argument.literal, [importTypeName(node.qualifier)]);
        }
      } else if (ts.isCallExpression(node)) {
        const moduleLoad = moduleLoadSpecifier(node);
        if (moduleLoad) {
          addImport("import", moduleLoad, ["*"]);
          // A module load is an import edge, never a call edge: descend into the arguments
          // only, so `require("./x")` does not also become a call to `require`.
          ts.forEachChild(node, visit);
          return;
        }
        recordCall(node);
      } else if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
        // A tagged template invokes its tag exactly like a call (ruling 2026-09-04).
        recordCall(node);
      }
      ts.forEachChild(node, visit);
    };

    const recordCall = (node: CallLike): void => {
      const edge = resolveCallEdge(node, checker, toId, fileId);
      if (edge) calls.add(edge.from, edge.to, "call", []);
    };

    ts.forEachChild(sourceFile, visit);
  }

  const importEdges = imports.toArray();
  return {
    files: covered.map((entry) => entry.id),
    imports: importEdges,
    exports,
    calls: calls.toArray(),
    cycles: findCycles(
      covered.map((entry) => entry.id),
      importEdges,
    ),
    notes: workspaceEdges > 0 ? ["workspace-entry-mapping"] : [],
  };
}

// ---------------------------------------------------------------------------
// compiler options and diagnostics
// ---------------------------------------------------------------------------

function readCompilerOptions(absRoot: string): { options: ts.CompilerOptions; configErrors: ts.Diagnostic[] } {
  const configPath = path.join(absRoot, "tsconfig.json");
  const fallback: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
  };
  // A repo with no tsconfig.json is the designed bundler-fallback path, not a problem to
  // report: only a config that exists and failed to parse is a real error.
  const configExists = existsSync(configPath);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) {
    return {
      options: { ...fallback, noEmit: true },
      configErrors: read.error && configExists ? [read.error] : [],
    };
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, absRoot);
  // `files`/`include` from the config are ignored on purpose: the caller decides which
  // files are scored, so the program's root set is exactly the given list. `allowJs` is
  // forced for the same reason — greplost extracts `.js`/`.jsx` too, and a program that
  // refused to bind the JavaScript it was handed would report those files as exporting
  // nothing, scoring real exports as false positives.
  return { options: { ...parsed.options, allowJs: true, noEmit: true }, configErrors: parsed.errors };
}

/**
 * Report how well the compiler understood the repo, on stderr.
 *
 * A high semantic diagnostic count usually means unresolved imports, which means missing
 * truth edges, which means greplost gets scored against a truth set that is quietly wrong.
 * It is the best early warning there is, but it is also a full type-check of the program,
 * so it is opt-in; when it is off, the line says so rather than leaving the reader to
 * assume a clean bill of health. Nothing here is written to stdout, so it cannot disturb
 * the suite's last-line output convention.
 */
function reportDiagnostics(
  program: ts.Program,
  configErrors: ts.Diagnostic[],
  coveredCount: number,
  missing: string[],
  diagnostics: boolean,
): void {
  const head = `truth-ts: ${coveredCount} files, ${configErrors.length} tsconfig errors`;
  if (diagnostics) {
    console.error(`${head}, ${program.getSemanticDiagnostics().length} semantic diagnostics`);
  } else {
    console.error(`${head} (semantic diagnostics off: --diagnostics or GREPLOST_BENCH_DIAGNOSTICS=1 to check them)`);
  }
  for (const error of configErrors) {
    console.error(`truth-ts: tsconfig: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
  }
  if (missing.length > 0) {
    console.error(
      `truth-ts: ${missing.length} listed file(s) the program did not load, dropped from scoring: ` +
        `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`,
    );
  }
}

// ---------------------------------------------------------------------------
// exports and imports
// ---------------------------------------------------------------------------

/**
 * The exported names of a module, in greplost's export vocabulary (named / default / star).
 *
 * `export = X` is the one place `checker.getExportsOfModule` cannot be taken literally: it
 * follows the equals into the exported value and lists *its* members, so a CommonJS module
 * exporting a class reports "prototype" rather than anything a consumer can import. greplost
 * has no `export =` kind, and what an importer binds is the whole module, so it is reported
 * as "default" — the same name `import X from "./m"` binds under `esModuleInterop`.
 *
 * `export *` is followed transitively, because that is what the compiler does and what a
 * consumer sees (core's `buildExportIndex` matches this; driver ruling, fix round 1).
 */
function moduleExportNames(checker: ts.TypeChecker, moduleSymbol: ts.Symbol): string[] {
  if (moduleSymbol.exports?.has(ts.InternalSymbolName.ExportEquals)) return ["default"];
  const names = checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName());
  return [...new Set(names)].sort(compareStrings);
}

/** Exported names an import clause pulls in: `*` for a namespace or bare module load. */
function importedNames(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return []; // side-effect import
  const names: string[] = [];
  if (clause.name) names.push("default");
  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) names.push("*");
    else for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
  }
  return names;
}

/** Exported names an `export ... from` re-exports: `*` for `export *` and `export * as ns`. */
function reexportedNames(clause: ts.NamedExportBindings | undefined): string[] {
  if (!clause) return ["*"]; // `export * from "x"`
  if (ts.isNamespaceExport(clause)) return ["*"];
  return clause.elements.map((element) => (element.propertyName ?? element.name).text);
}

/**
 * The exported name an `import("./mod").A.B` type reaches for: the leftmost identifier of
 * the qualifier (`A`), or `*` when the whole module is used (`typeof import("./mod")`).
 */
function importTypeName(qualifier: ts.EntityName | undefined): string {
  if (!qualifier) return "*";
  let current: ts.EntityName = qualifier;
  while (ts.isQualifiedName(current)) current = current.left;
  return current.text;
}

/** The string-literal specifier of `import("x")` / `require("x")`, if this call is a module load. */
function moduleLoadSpecifier(node: ts.CallExpression): ts.Expression | undefined {
  const [first, ...rest] = node.arguments;
  if (!first || rest.length > 0 || !ts.isStringLiteralLike(first)) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return first;
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") return first;
  return undefined;
}

// ---------------------------------------------------------------------------
// cycles (Tarjan, iterative: corpus repos are far deeper than the call stack)
// ---------------------------------------------------------------------------

function findCycles(nodes: string[], edges: Edge[]): string[][] {
  const successors = new Map<string, string[]>();
  for (const node of nodes) successors.set(node, []);
  for (const edge of edges) {
    const list = successors.get(edge.from);
    if (list && !list.includes(edge.to)) list.push(edge.to);
  }
  for (const list of successors.values()) list.sort(compareStrings);

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const frames: { node: string; child: number }[] = [{ node: root, child: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { node: string; child: number };
      const node = frame.node;
      if (frame.child === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }
      const children = successors.get(node) ?? [];
      let descended = false;
      while (frame.child < children.length) {
        const child = children[frame.child] as string;
        frame.child += 1;
        if (!index.has(child)) {
          frames.push({ node: child, child: 0 });
          descended = true;
          break;
        }
        if (onStack.has(child)) low.set(node, Math.min(low.get(node) ?? 0, index.get(child) ?? 0));
      }
      if (descended) continue;

      if ((low.get(node) ?? 0) === (index.get(node) ?? 0)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === node) break;
        }
        if (component.length > 1) cycles.push(component.sort(compareStrings));
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(node) ?? 0));
    }
  }
  return cycles.sort((a, b) => compareStrings(a.join(","), b.join(",")));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Deduplicating edge accumulator keyed on (from, to, kind), merging imported symbols.
 *
 * Nested maps rather than a joined string key: file ids may contain any character a path
 * may contain, so there is no separator that is guaranteed not to collide, and the source
 * of this file stays free of control characters.
 */
class EdgeSet {
  private readonly byKind = new Map<Edge["kind"], Map<string, Map<string, Set<string>>>>();

  add(from: string, to: string, kind: Edge["kind"], symbols: string[]): void {
    let byFrom = this.byKind.get(kind);
    if (!byFrom) {
      byFrom = new Map();
      this.byKind.set(kind, byFrom);
    }
    let byTo = byFrom.get(from);
    if (!byTo) {
      byTo = new Map();
      byFrom.set(from, byTo);
    }
    let merged = byTo.get(to);
    if (!merged) {
      merged = new Set();
      byTo.set(to, merged);
    }
    for (const symbol of symbols) merged.add(symbol);
  }

  toArray(): Edge[] {
    const out: Edge[] = [];
    for (const [kind, byFrom] of this.byKind) {
      for (const [from, byTo] of byFrom) {
        for (const [to, symbols] of byTo) {
          out.push({ from, to, kind, symbols: [...symbols].sort(compareStrings), confidence: "high" });
        }
      }
    }
    return out.sort(compareEdges);
  }
}

/** The `ts.Extension` a resolved file name carries, for a hand-built ResolvedModuleFull. */
function extensionOf(file: string): ts.Extension {
  if (file.endsWith(".d.ts")) return ts.Extension.Dts;
  if (file.endsWith(".d.mts")) return ts.Extension.Dmts;
  if (file.endsWith(".d.cts")) return ts.Extension.Dcts;
  if (file.endsWith(".tsx")) return ts.Extension.Tsx;
  if (file.endsWith(".mts")) return ts.Extension.Mts;
  if (file.endsWith(".cts")) return ts.Extension.Cts;
  if (file.endsWith(".ts")) return ts.Extension.Ts;
  if (file.endsWith(".jsx")) return ts.Extension.Jsx;
  if (file.endsWith(".mjs")) return ts.Extension.Mjs;
  if (file.endsWith(".cjs")) return ts.Extension.Cjs;
  if (file.endsWith(".json")) return ts.Extension.Json;
  return ts.Extension.Js;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Accept absolute paths, "./"-prefixed paths and native separators; emit a greplost file id. */
function normalizeId(absRoot: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(absRoot, file) : file;
  return toPosix(relative).replace(/^\.\//, "");
}

/**
 * Source files a resolved module path could correspond to. `ts.resolveModuleName` happily
 * lands on `foo.d.ts` or (with `allowJs`) `foo.js` when the repo file is `foo.ts`, and a
 * NodeNext specifier is written `./foo.js` for `./foo.ts`.
 */
function sourceCandidates(fileName: string): string[] {
  const posix = toPosix(fileName);
  const bases: string[] = [];
  const declaration = posix.match(/^(.*)\.d\.(?:ts|mts|cts)$/);
  if (declaration) bases.push(declaration[1] as string);
  const trimmed = posix.replace(/\.[^./]+$/, "");
  if (trimmed !== posix) bases.push(trimmed);
  const out: string[] = [];
  for (const base of bases) for (const ext of CANDIDATE_EXTENSIONS) out.push(base + ext);
  return out;
}
