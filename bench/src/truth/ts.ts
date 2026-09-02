/**
 * TypeScript compiler truth for Eval 1 (tech spec 10.3, bench spec 1.5.1).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2):
 * this module asks `typescript` itself what the imports, exports, calls and cycles
 * of a repo are, in greplost's own id vocabulary (tech spec 5.3), so both sides of
 * every comparison speak the same language.
 *
 * Identity, restated for this file:
 *   file   -> repo-relative posix path, no leading "./"
 *   symbol -> `<file>#<Name>` or `<file>#<Class>.<member>`
 *   caller -> the enclosing function / method / variable-initializer symbol, or the
 *             file id for top-level code.
 *
 * Conservatism rules (a truth set that over-claims is worse than useless):
 *   - only declarations inside the given file list are ever named; lib.d.ts,
 *     node_modules and files the program pulled in but the caller did not list are
 *     dropped on both sides of every edge;
 *   - only module-scope declarations and class/interface/enum members are addressable,
 *     so locals, parameters, loop bindings and import specifiers are never call targets;
 *   - module-loading expressions (`import("x")`, `require("x")`) are import edges, never
 *     call edges.
 */
import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { compareEdges, compareStrings, symbolId, type Edge } from "@greplost/core/schema";

/** Compiler truth for one repo, in greplost ids. */
export interface Truth {
  /** Import and re-export edges between listed files, sorted with `compareEdges`. */
  imports: Edge[];
  /** file id -> exported names (`checker.getExportsOfModule`), sorted. Every listed file is a key. */
  exports: Record<string, string[]>;
  /** Call edges between listed files, sorted with `compareEdges`. */
  calls: Edge[];
  /** Tarjan SCCs of size > 1 over the import graph; each cycle sorted, the list sorted. */
  cycles: string[][];
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

/**
 * Compiler truth for `files` (repo-relative posix paths) under `root`.
 *
 * Compiler options come from `<root>/tsconfig.json` via `ts.parseJsonConfigFileContent`,
 * falling back to bundler resolution when there is no config.
 */
export function generateTsTruth(root: string, files: string[]): Truth {
  const absRoot = path.resolve(root);
  // Sorted, unique, normalised: the root file order reaches the program, and the program's
  // declaration order reaches the output, so this is part of the determinism contract.
  const ids = [...new Set(files.map((f) => normalizeId(absRoot, f)))].sort(compareStrings);
  const absFiles = ids.map((id) => path.join(absRoot, id));

  const canonical = ts.sys.useCaseSensitiveFileNames ? (p: string) => p : (p: string) => p.toLowerCase();
  const idByPath = new Map<string, string>();
  for (let i = 0; i < ids.length; i++) {
    const absolute = absFiles[i] as string;
    const id = ids[i] as string;
    idByPath.set(canonical(toPosix(absolute)), id);
    // TypeScript resolves modules through symlinks by default (`preserveSymlinks: false`),
    // so a workspace package linked into node_modules, or a repo checked out under a
    // symlinked path, comes back as its real path. Index that too, first id wins.
    try {
      const real = canonical(toPosix(realpathSync(absolute)));
      if (!idByPath.has(real)) idByPath.set(real, id);
    } catch {
      // The file may not exist on disk (a caller-supplied list can be stale); the
      // literal path is already indexed, which is all the resolver needs.
    }
  }

  const options = readCompilerOptions(absRoot);
  const program = ts.createProgram(absFiles, options);
  const checker = program.getTypeChecker();
  const resolutionCache = ts.createModuleResolutionCache(absRoot, canonical, options);

  /** Absolute file name -> listed file id, following `.js`/`.d.ts` specifiers back to source. */
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

  for (let i = 0; i < ids.length; i++) {
    const fileId = ids[i] as string;
    exports[fileId] = [];
    const sourceFile = program.getSourceFile(absFiles[i] as string);
    if (!sourceFile) continue;

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol) exports[fileId] = moduleExportNames(checker, moduleSymbol);

    /** Resolve a module specifier to a listed file id, or undefined. */
    const resolveTarget = (specifier: string, specifierNode: ts.Expression): string | undefined => {
      const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, options, ts.sys, resolutionCache);
      const byResolver = resolved.resolvedModule ? toId(resolved.resolvedModule.resolvedFileName) : undefined;
      if (byResolver !== undefined) return byResolver;
      // Fallback: ask the checker which module the specifier bound to. This catches
      // resolutions the standalone resolver misses (path mappings applied by the program,
      // `.js` specifiers redirected to their `.ts` source, package `exports` maps).
      const symbol = checker.getSymbolAtLocation(specifierNode);
      for (const declaration of symbol?.declarations ?? []) {
        const id = toId(declaration.getSourceFile().fileName);
        if (id !== undefined) return id;
      }
      return undefined;
    };

    const addImport = (
      kind: "import" | "reexport",
      specifierNode: ts.Expression,
      symbols: string[],
    ): void => {
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
      } else if (ts.isCallExpression(node)) {
        const moduleLoad = moduleLoadSpecifier(node);
        if (moduleLoad) {
          addImport("import", moduleLoad, ["*"]);
          // A module load is an import edge, never a call edge: fall through to the
          // arguments only, so `require("./x")` does not also become a call to `require`.
          ts.forEachChild(node, visit);
          return;
        }
        recordCall(node);
      } else if (ts.isNewExpression(node)) {
        recordCall(node);
      }
      ts.forEachChild(node, visit);
    };

    const recordCall = (node: ts.CallExpression | ts.NewExpression): void => {
      const callee = calleeIdentifier(node);
      if (!callee) return;
      const symbol = unalias(checker, checker.getSymbolAtLocation(callee));
      if (!symbol) return;
      for (const declaration of symbol.declarations ?? []) {
        const targetFile = toId(declaration.getSourceFile().fileName);
        if (targetFile === undefined) continue;
        const targetPath = declarationSymbolPath(declaration);
        if (targetPath === undefined) continue;
        calls.add(enclosingCaller(node, fileId), symbolId(targetFile, targetPath), "call", []);
        return;
      }
    };

    ts.forEachChild(sourceFile, visit);
  }

  const importEdges = imports.toArray();
  return {
    imports: importEdges,
    exports,
    calls: calls.toArray(),
    cycles: findCycles(ids, importEdges),
  };
}

// ---------------------------------------------------------------------------
// compiler options
// ---------------------------------------------------------------------------

function readCompilerOptions(absRoot: string): ts.CompilerOptions {
  const configPath = path.join(absRoot, "tsconfig.json");
  const fallback: ts.CompilerOptions = {
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  };
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) return { ...fallback, noEmit: true };
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, absRoot);
  // `files`/`include` from the config are ignored on purpose: the caller decides which
  // files are scored, so the program's root set is exactly the given list. `allowJs` is
  // forced for the same reason — greplost extracts `.js`/`.jsx` too, and a program that
  // refused to bind the JavaScript it was handed would report those files as exporting
  // nothing, scoring real exports as false positives.
  return { ...parsed.options, allowJs: true, noEmit: true };
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

/**
 * The exported names of a module, in greplost's export vocabulary (named / default / star).
 *
 * `export = X` is the one place `checker.getExportsOfModule` cannot be taken literally: it
 * follows the equals into the exported value and lists *its* members, so a CommonJS module
 * exporting a class reports "prototype" rather than anything a consumer can import. greplost
 * has no `export =` kind, and what an importer binds is the whole module, so it is reported
 * as "default" — the same name `import X from "./m"` binds under `esModuleInterop`.
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

/** The string-literal specifier of `import("x")` / `require("x")`, if this call is a module load. */
function moduleLoadSpecifier(node: ts.CallExpression): ts.Expression | undefined {
  const [first, ...rest] = node.arguments;
  if (!first || rest.length > 0 || !ts.isStringLiteralLike(first)) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return first;
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") return first;
  return undefined;
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

/** The identifier naming the callee: `foo`, the `.name` of `a.foo`, else nothing. */
function calleeIdentifier(node: ts.CallExpression | ts.NewExpression): ts.Node | undefined {
  let expr: ts.Expression = node.expression;
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
    else if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression;
    else break;
  }
  if (ts.isIdentifier(expr)) return expr;
  if (ts.isPropertyAccessExpression(expr)) return expr.name;
  // Element access, `super()`, `import()`, calls on call results: never guessed.
  return undefined;
}

/** Follow import/export aliases to the declaration that actually defines the symbol. */
function unalias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  let current = symbol;
  for (let depth = 0; current && (current.flags & ts.SymbolFlags.Alias) !== 0 && depth < 32; depth++) {
    let next: ts.Symbol | undefined;
    try {
      next = checker.getAliasedSymbol(current);
    } catch {
      return current; // unresolvable alias (e.g. an import of a package that is not installed)
    }
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/** The `<file>#…` symbol path fragment of a declaration, or undefined when it is not addressable. */
function declarationSymbolPath(declaration: ts.Declaration): string | undefined {
  if (ts.isConstructorDeclaration(declaration)) {
    const owner = moduleScopePath(declaration.parent);
    return owner === undefined ? undefined : `${owner}.constructor`;
  }
  if (
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration) ||
    ts.isEnumMember(declaration)
  ) {
    const parent = declaration.parent;
    const ownerIsNamedType =
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isEnumDeclaration(parent);
    if (!ownerIsNamedType) return undefined; // object literal / type literal member
    const owner = moduleScopePath(parent);
    const member = nameText(declaration.name);
    if (owner === undefined || member === undefined) return undefined;
    return `${owner}.${member}`;
  }
  return moduleScopePath(declaration);
}

/**
 * Dotted path of a declaration that lives at module scope (optionally inside namespaces).
 * Anything nested in a function, block, class body or import clause is a local binding
 * with no stable id, and yields undefined.
 */
function moduleScopePath(node: ts.Node): string | undefined {
  const name = nameText((node as { name?: ts.Node }).name);
  if (name === undefined) return undefined;
  const owner = moduleScopeOwner(node);
  if (!owner) return undefined;
  if (ts.isSourceFile(owner)) return name;
  const outer = moduleScopePath(owner);
  return outer === undefined ? undefined : `${outer}.${name}`;
}

/** The source file or namespace a declaration sits directly in, or undefined when it is local. */
function moduleScopeOwner(node: ts.Node): ts.SourceFile | ts.ModuleDeclaration | undefined {
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isSourceFile(parent)) return parent;
    if (ts.isModuleDeclaration(parent)) return parent;
    // Wrappers that do not introduce a scope of their own.
    if (ts.isModuleBlock(parent) || ts.isVariableDeclarationList(parent) || ts.isVariableStatement(parent)) {
      parent = parent.parent;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function nameText(name: ts.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined; // computed member name
}

/** Declaration kinds that own the calls written inside them. */
function isCallerDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isVariableDeclaration(node)
  );
}

/**
 * The symbol that owns a call site: the nearest enclosing addressable declaration.
 * Anonymous functions and local declarations are walked through (a call inside
 * `retry(() => this.client.send(cmd))` belongs to the method around it), and a call in
 * a class property initializer belongs to the class, which is the enclosing declaration
 * greplost's extractor records. Top-level code belongs to the file.
 */
function enclosingCaller(node: ts.Node, fileId: string): string {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (isCallerDeclaration(current)) {
      const symbolPath = declarationSymbolPath(current as ts.Declaration);
      if (symbolPath !== undefined) return symbolId(fileId, symbolPath);
    }
    current = current.parent;
  }
  return fileId;
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

/** Deduplicating edge accumulator keyed on (from, to, kind), merging imported symbols. */
class EdgeSet {
  private readonly byKey = new Map<string, { from: string; to: string; kind: Edge["kind"]; symbols: Set<string> }>();

  add(from: string, to: string, kind: Edge["kind"], symbols: string[]): void {
    const key = `${from} ${to} ${kind}`;
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = { from, to, kind, symbols: new Set<string>() };
      this.byKey.set(key, entry);
    }
    for (const symbol of symbols) entry.symbols.add(symbol);
  }

  toArray(): Edge[] {
    const out: Edge[] = [];
    for (const entry of this.byKey.values()) {
      out.push({
        from: entry.from,
        to: entry.to,
        kind: entry.kind,
        symbols: [...entry.symbols].sort(compareStrings),
        confidence: "high",
      });
    }
    return out.sort(compareEdges);
  }
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
