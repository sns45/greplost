/**
 * TypeScript / TSX / JavaScript / JSX extraction (tech spec 5.1).
 *
 * Two passes over one tree:
 *  A. the program's own children -> declarations, static imports, exports.
 *     Tracked declarations are the top level, class members, and namespace members
 *     at any depth; nothing inside a function body becomes a symbol.
 *  B. the whole tree -> call sites, dynamic `import()` and `require()` records,
 *     with the caller attributed to the nearest enclosing tracked declaration.
 *
 * Pass A registers each declaration's *node* (by `node.id`), not its name, so a
 * local binding that shadows a top-level name cannot hijack caller attribution.
 *
 * When the grammar cannot parse a construct (hono's `src/types.ts` is 2779 lines of
 * conditional types that tree-sitter-typescript 0.23 shreds into ERROR nodes), pass
 * A runs a recovery step over the broken regions instead of losing every declaration
 * after the first failure. Recovery re-reads verbatim source with the same grammar;
 * it never guesses.
 *
 * Nothing here is inferred: a construct either matches a rule or is dropped.
 * Import and export records live in `ts-imports.ts`, call sites in `ts-calls.ts`,
 * and signature text in `ts-signature.ts`.
 */

import type { Node, Tree } from "web-tree-sitter";
import type {
  CallSite,
  DeclKind,
  Declaration,
  ExportRecord,
  FileRecord,
  ImportRecord,
  Lang,
} from "../schema.ts";
import { symbolId } from "../schema.ts";
import { reparse } from "../parser.ts";
import {
  collectCommonJsExport,
  collectExportStatement,
  collectImportStatement,
  recordModuleCall,
} from "./ts-imports.ts";
import { recordCall } from "./ts-calls.ts";
import {
  field,
  functionValue,
  initialiserSignature,
  nameOf,
  signatureText,
  variableSignature,
} from "./ts-signature.ts";

/**
 * What the import/export and call modules need from the extraction in progress.
 * Declaring is a callback rather than an import so the modules stay acyclic, and
 * `line`/`span` are methods because a recovered node's rows are relative to the
 * region it was re-parsed from.
 */
export interface TsContext {
  /** Repo-relative path of the file being extracted. */
  readonly path: string;
  /** Text the current nodes belong to: the whole file, or one recovered region. */
  source: string;
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly calls: CallSite[];
  /** 1-based line of `node` in the file. */
  line(node: Node): number;
  /** 1-based inclusive line span of `node` in the file. */
  span(node: Node): [number, number];
  /** Declare `node` (wrapped by `outer`); returns the names it declared. */
  declare(node: Node, outer: Node, exported: boolean): string[];
  /** Declare an `export default` function/class value; returns its written name, or null. */
  declareDefault(value: Node, outer: Node): string | null;
  /** Record an `import()` / `require()` call as an import rather than a call site. */
  recordModuleCall(call: Node, form: "dynamic" | "require"): void;
}

/** A declaration plus the bookkeeping needed to collapse overload signatures. */
interface Entry {
  decl: Declaration;
  /** True for a bodiless signature (an overload, an ambient or an abstract member). */
  overload: boolean;
}

/** Enclosing declaration context while walking for call sites. */
interface Ctx {
  /** Symbol path of the nearest enclosing tracked declaration, "" at top level. */
  caller: string;
  /** Symbol path of the enclosing tracked class, "" outside one. */
  className: string;
  /**
   * Every name bound anywhere inside the enclosing function, or null at file scope.
   * Flattened over the whole function (like the Go extractor) so a call is dropped
   * whenever a binding of that name is in scope somewhere around it.
   */
  locals: ReadonlySet<string> | null;
}

const EMPTY_CTX: Ctx = { caller: "", className: "", locals: null };

/** Nodes that open a function scope for the purpose of local-name shadowing. */
const FUNCTION_SCOPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
  "class_static_block",
]);

/** Statement-level nodes that recovery may lift out of a broken region. */
const STATEMENT_TYPES: ReadonlySet<string> = new Set([
  "export_statement",
  "import_statement",
  "type_alias_declaration",
  "interface_declaration",
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
  "class_declaration",
  "abstract_class_declaration",
  "enum_declaration",
  "lexical_declaration",
  "variable_declaration",
  "internal_module",
  "ambient_declaration",
]);

/** Top-level nodes that need no recovery: real statements, comments, the shebang. */
const SOUND_EXTRA: ReadonlySet<string> = new Set(["comment", "hash_bang_line", "function_signature", "internal_module"]);

/**
 * Recovery limits: a broken file must never cost unbounded work or memory. A file
 * that is broken everywhere (hono's `src/types.ts` shreds into 670 regions) would
 * otherwise re-parse itself hundreds of times over.
 */
const RECOVERY_MAX_DEPTH = 6;
const RECOVERY_MIN_CHARS = 8;
const RECOVERY_MAX_RESUMES = 32;
const RECOVERY_MAX_PARSES = 512;

/**
 * Region trees that yielded a declaration are held until extraction ends, so their
 * cost is bounded against the file itself rather than against the number of parses:
 * nested regions overlap, and depth is capped at 6, so 4x the source is the most any
 * honest recovery needs. Recovery stops rather than growing past it.
 */
const RECOVERY_MAX_RETAINED_RATIO = 4;

/** A region with none of these cannot hold a declaration, so it is not worth a parse. */
const DECLARATION_KEYWORDS = [
  "export",
  "import",
  "type ",
  "interface ",
  "class ",
  "function",
  "const ",
  "let ",
  "var ",
  "enum ",
  "namespace ",
  "declare ",
];

function mayDeclare(text: string): boolean {
  for (const keyword of DECLARATION_KEYWORDS) if (text.includes(keyword)) return true;
  return false;
}

function isSound(node: Node): boolean {
  const type = node.type;
  return type.endsWith("_statement") || type.endsWith("_declaration") || SOUND_EXTRA.has(type);
}

export function extractTs(
  path: string,
  lang: Lang,
  source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls"> {
  // `lang` only selects the grammar (done by the caller); the TS and TSX grammars
  // accept every JS dialect, so extraction itself is dialect-independent.
  void lang;

  const entries: Entry[] = [];
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  const calls: CallSite[] = [];
  /** Scope node id -> symbol path of the declaration it defines. */
  const trackedById = new Map<number, string>();
  /** Text and row offset of the region the current nodes were parsed from. */
  let rowOffset = 0;
  /** Statements lifted out of broken regions, walked for calls after the main tree. */
  const recoveredStatements: Array<{ node: Node; source: string; rowOffset: number }> = [];
  /** Re-parsed regions that yielded a statement, kept alive so node ids stay distinct. */
  const regionTrees: Tree[] = [];
  /** Re-parses spent on this file. */
  let parseBudget = RECOVERY_MAX_PARSES;
  /** Bytes of region text held alive by `regionTrees`. */
  let retainedBytes = 0;
  const retainedLimit = source.length * RECOVERY_MAX_RETAINED_RATIO;
  /** Absolute source ranges already extracted, so recovery never emits a node twice. */
  const consumed = new Set<string>();

  const ctx: TsContext = {
    path,
    source,
    imports,
    exports,
    calls,
    line: (node) => node.startPosition.row + 1 + rowOffset,
    span: (node) => [node.startPosition.row + 1 + rowOffset, node.endPosition.row + 1 + rowOffset],
    declare: (node, outer, exported) => collectDeclaration(node, outer, exported, ""),
    declareDefault,
    recordModuleCall: (call, form) => recordModuleCall(ctx, call, form),
  };

  // ------------------------------------------------------------ declaring

  function addEntry(
    name: string,
    kind: DeclKind,
    signature: string,
    span: [number, number],
    exported: boolean,
    parent?: string,
    overload = false,
  ): void {
    entries.push({
      decl: {
        id: symbolId(path, name),
        file: path,
        name,
        kind,
        signature,
        exported,
        span,
        ...(parent === undefined ? {} : { parent }),
      },
      overload,
    });
  }

  /** Remember that calls inside `node` belong to `symbolPath`. */
  function register(node: Node, symbolPath: string): void {
    trackedById.set(node.id, symbolPath);
  }

  /** `""` -> undefined, `"N."` -> `"N"`, `"A.B."` -> `"A.B"`. */
  function parentOf(prefix: string): string | undefined {
    return prefix === "" ? undefined : prefix.slice(0, -1);
  }

  // ------------------------------------------------------- pass A: top level

  function collectTop(node: Node): void {
    switch (node.type) {
      case "import_statement":
        collectImportStatement(ctx, node);
        return;
      case "export_statement":
        collectExportStatement(ctx, node);
        return;
      case "ambient_declaration":
        for (const inner of node.namedChildren) collectDeclaration(inner, node, false, "");
        return;
      case "expression_statement": {
        const inner = node.namedChildren.find((child) => child.type !== "comment");
        if (inner === undefined) return;
        // `namespace X {}` at the top level is wrapped in an expression statement.
        if (inner.type === "internal_module") collectDeclaration(inner, node, false, "");
        else if (inner.type === "assignment_expression") collectCommonJsExport(ctx, inner);
        return;
      }
      default:
        collectDeclaration(node, node, false, "");
    }
  }

  /**
   * Adds the declarations of `node` and returns the names it declared. `prefix` is
   * the enclosing namespace path with a trailing dot ("" at the top level); the
   * returned names are always bare, since they name the binding in its own scope.
   */
  function collectDeclaration(node: Node, outer: Node, exported: boolean, prefix: string): string[] {
    const parent = parentOf(prefix);
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature": {
        const name = nameOf(node);
        if (name === null) return [];
        const overload = node.type === "function_signature";
        addEntry(
          prefix + name,
          "function",
          signatureText(ctx.source, node, outer),
          ctx.span(outer),
          exported,
          parent,
          overload,
        );
        if (!overload) register(node, prefix + name);
        return [name];
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = nameOf(node);
        if (name === null) return [];
        const symbolPath = prefix + name;
        addEntry(symbolPath, "class", signatureText(ctx.source, node, outer), ctx.span(outer), exported, parent);
        register(node, symbolPath);
        collectMembers(node, symbolPath, exported);
        return [name];
      }
      case "interface_declaration":
        return simpleDeclaration(node, outer, exported, "interface", prefix);
      case "type_alias_declaration":
        return simpleDeclaration(node, outer, exported, "type", prefix);
      case "enum_declaration":
        return simpleDeclaration(node, outer, exported, "enum", prefix);
      case "internal_module": {
        const name = nameOf(node);
        if (name === null) return [];
        const symbolPath = prefix + name;
        addEntry(symbolPath, "namespace", signatureText(ctx.source, node, outer), ctx.span(outer), exported, parent);
        // Members are tracked at any depth; a call in the namespace body itself is
        // top-level code and keeps the enclosing caller.
        collectNamespaceMembers(node, symbolPath, exported);
        return [name];
      }
      case "lexical_declaration":
      case "variable_declaration": {
        const kind = variableKind(node);
        const names: string[] = [];
        for (const declarator of node.children) {
          if (declarator.type !== "variable_declarator") continue;
          const name = field(declarator, "name");
          // Destructuring patterns bind names the map cannot attribute; they are skipped.
          if (name === null || name.type !== "identifier") continue;
          addEntry(
            prefix + name.text,
            kind,
            variableSignature(ctx.source, outer, node, declarator),
            ctx.span(outer),
            exported,
            parent,
          );
          // `export const f = <T>(x: T) => x` hides its arrow inside a type assertion.
          if (functionValue(declarator) !== null) register(declarator, prefix + name.text);
          names.push(name.text);
        }
        return names;
      }
      default:
        return [];
    }
  }

  function simpleDeclaration(node: Node, outer: Node, exported: boolean, kind: DeclKind, prefix: string): string[] {
    const name = nameOf(node);
    if (name === null) return [];
    addEntry(prefix + name, kind, signatureText(ctx.source, node, outer), ctx.span(outer), exported, parentOf(prefix));
    return [name];
  }

  function variableKind(node: Node): DeclKind {
    const keyword = node.children[0]?.text ?? "";
    if (keyword === "let") return "let";
    if (keyword === "var") return "var";
    return "const";
  }

  /** `export default class {}` / `function () {}`: an anonymous value declared as `default`. */
  function declareDefault(value: Node, outer: Node): string | null {
    const written = nameOf(value);
    const name = written ?? "default";
    const isClass = value.type === "class";
    addEntry(name, isClass ? "class" : "function", signatureText(ctx.source, value, outer), ctx.span(outer), true);
    register(value, name);
    if (isClass) collectMembers(value, name, true);
    return written;
  }

  // --------------------------------------------------------- class members

  /**
   * Class members that are addressable as `Class.member`: methods, accessors,
   * overload and abstract signatures, and fields holding a function. Plain data
   * fields are not declarations; computed and literal names have no symbol path.
   */
  function collectMembers(classNode: Node, classPath: string, exported: boolean): void {
    const body = field(classNode, "body");
    if (body === null) return;
    for (const member of body.namedChildren) {
      const name = field(member, "name");
      if (name === null) continue;
      if (name.type !== "property_identifier" && name.type !== "private_property_identifier") continue;
      const symbolPath = `${classPath}.${name.text}`;
      switch (member.type) {
        case "method_definition":
          addEntry(symbolPath, "method", signatureText(ctx.source, member, member), ctx.span(member), exported, classPath);
          register(member, symbolPath);
          break;
        case "method_signature":
        case "abstract_method_signature":
          addEntry(
            symbolPath,
            "method",
            signatureText(ctx.source, member, member),
            ctx.span(member),
            exported,
            classPath,
            true,
          );
          break;
        case "public_field_definition": {
          if (functionValue(member) === null) break;
          addEntry(
            symbolPath,
            "method",
            initialiserSignature(ctx.source, member, ""),
            ctx.span(member),
            exported,
            classPath,
          );
          register(member, symbolPath);
          break;
        }
        default:
          break;
      }
    }
  }

  // ------------------------------------------------------ namespace members

  /**
   * A member declared directly in a namespace body, at any depth. It is exported
   * only when it carries `export` inside the namespace *and* every enclosing
   * namespace is exported, so `exported` really means "reachable from outside".
   */
  function collectNamespaceMembers(namespaceNode: Node, namespacePath: string, namespaceExported: boolean): void {
    const body = field(namespaceNode, "body");
    if (body === null) return;
    const prefix = `${namespacePath}.`;
    for (const member of body.namedChildren) {
      switch (member.type) {
        case "export_statement": {
          const declaration = field(member, "declaration");
          if (declaration === null) break;
          const inner = declaration.type === "ambient_declaration" ? declaration.namedChildren : [declaration];
          for (const node of inner) collectDeclaration(node, member, namespaceExported, prefix);
          break;
        }
        case "ambient_declaration":
          for (const node of member.namedChildren) collectDeclaration(node, member, false, prefix);
          break;
        case "expression_statement": {
          const inner = member.namedChildren.find((child) => child.type !== "comment");
          if (inner?.type === "internal_module") collectDeclaration(inner, member, false, prefix);
          break;
        }
        default:
          collectDeclaration(member, member, false, prefix);
      }
    }
  }

  // ------------------------------------------------------- error recovery

  /** Absolute range key of a node inside the region starting at `base`. */
  function rangeKey(node: Node, base: number): string {
    return `${base + node.startIndex}:${base + node.endIndex}`;
  }

  /**
   * Runs of consecutive top-level children the grammar could not make a statement of.
   * A run is widened to the start of its first line: when a mis-parse swallows the
   * head of the next declaration, the only place it can be read from is the line it
   * was written on.
   */
  function brokenRuns(program: Node, base: number): Array<[number, number]> {
    const runs: Array<[number, number]> = [];
    let start: number | null = null;
    let end = 0;
    for (const child of program.namedChildren) {
      if (isSound(child)) {
        if (start !== null) runs.push([Math.max(lineStart(start), base), end]);
        start = null;
        continue;
      }
      if (start === null) start = base + child.startIndex;
      end = base + child.endIndex;
    }
    if (start !== null) runs.push([Math.max(lineStart(start), base), end]);
    return runs;
  }

  function lineStart(index: number): number {
    return source.lastIndexOf("\n", Math.max(index - 1, 0)) + 1;
  }

  /** Extract one statement as if it were a program child, once. */
  function harvest(node: Node, base: number, regionSource: string, regionRow: number): boolean {
    const key = rangeKey(node, base);
    if (consumed.has(key)) return false;
    consumed.add(key);
    const previousSource = ctx.source;
    const previousRow = rowOffset;
    ctx.source = regionSource;
    rowOffset = regionRow;
    collectTop(node);
    recoveredStatements.push({ node, source: regionSource, rowOffset: regionRow });
    ctx.source = previousSource;
    rowOffset = previousRow;
    return true;
  }

  /**
   * The literal rule: a statement tree-sitter kept *inside* an ERROR node is still a
   * statement, at any depth.
   */
  function harvestErrorNode(error: Node): number {
    let found = 0;
    const stack: Node[] = [error];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      for (const child of node.namedChildren) {
        if (STATEMENT_TYPES.has(child.type)) {
          if (harvest(child, 0, source, 0)) found += 1;
        } else if (child.type === "ERROR") {
          stack.push(child);
        }
      }
    }
    return found;
  }

  /**
   * Re-read a region the parser shredded. The text is verbatim source, so parsing it
   * on its own — free of the state the earlier failure left behind — usually yields
   * the declarations that were lost. Regions that still fail are retried after each
   * child of their leading ERROR, which walks past the construct the grammar cannot
   * read (a call signature with defaulted type parameters, in hono's case).
   */
  function salvageRegion(start: number, end: number, depth: number): number {
    if (depth > RECOVERY_MAX_DEPTH || end - start < RECOVERY_MIN_CHARS) return 0;
    if (parseBudget <= 0 || retainedBytes >= retainedLimit) return 0;
    const text = source.slice(start, end);
    if (!mayDeclare(text)) return 0;
    parseBudget -= 1;
    const regionTree = reparse(tree.language, text);
    if (regionTree === null) return 0;
    const regionRow = rowsBefore(start);

    let found = 0;
    for (const child of regionTree.rootNode.namedChildren) {
      if (!STATEMENT_TYPES.has(child.type)) continue;
      if (harvest(child, start, text, regionRow)) found += 1;
    }
    const runs = brokenRuns(regionTree.rootNode, start);
    const resumes =
      found === 0 && regionTree.rootNode.namedChildren[0]?.type === "ERROR"
        ? regionTree.rootNode.namedChildren[0].namedChildren.map((child) => start + child.endIndex)
        : [];
    // Nodes of a region that gave nothing are referenced by no record, so the tree
    // can go now; keeping only the useful ones bounds memory on a shredded file.
    if (found > 0) {
      regionTrees.push(regionTree);
      retainedBytes += text.length;
    } else {
      regionTree.delete();
    }

    for (const [runStart, runEnd] of runs) {
      if (runEnd - runStart >= end - start) continue;
      found += salvageRegion(runStart, runEnd, depth + 1);
    }
    if (found > 0) return found;

    // The region begins with the construct the parser choked on and re-parsing it
    // whole changes nothing: resume after each child of that error instead.
    const limit = Math.min(resumes.length, RECOVERY_MAX_RESUMES);
    for (let i = 0; i < limit; i += 1) {
      const resume = resumes[i] ?? 0;
      if (resume <= start || resume >= end) continue;
      const recovered = salvageRegion(resume, end, depth + 1);
      if (recovered > 0) return recovered;
    }
    return 0;
  }

  function rowsBefore(index: number): number {
    let rows = 0;
    for (let i = source.indexOf("\n"); i !== -1 && i < index; i = source.indexOf("\n", i + 1)) rows += 1;
    return rows;
  }

  function recoverBrokenRegions(): void {
    for (const child of tree.rootNode.namedChildren) {
      if (child.type === "ERROR") harvestErrorNode(child);
    }
    for (const [start, end] of brokenRuns(tree.rootNode, 0)) salvageRegion(start, end, 1);
  }

  // ------------------------------------------- pass B: calls and call imports

  /**
   * Pre-order walk with an explicit stack: generated and minified sources nest deeply
   * enough to blow a recursive walk's call stack, and the map must never crash on a file.
   */
  function walk(root: Node, start: Ctx): void {
    const stack: Array<{ node: Node; ctx: Ctx }> = [{ node: root, ctx: start }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const node = current.node;
      if (node.type === "call_expression" || node.type === "new_expression") {
        recordCall(ctx, node, current.ctx.caller, current.ctx.locals);
      }
      const inner = descend(node, current.ctx);
      const children = node.namedChildren;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) stack.push({ node: child, ctx: inner });
      }
    }
  }

  /**
   * The context children see. Only a node registered in pass A pushes a caller, so a
   * nested helper keeps its enclosing declaration instead of inventing a symbol —
   * `function f() { const helper = () => g(); }` attributes `g` to `f`, whether or
   * not a top-level `helper` also exists.
   */
  function descend(node: Node, current: Ctx): Ctx {
    const symbolPath = trackedById.get(node.id);
    let next = current;
    switch (node.type) {
      case "class_declaration":
      case "abstract_class_declaration":
      case "class":
        next = { ...current, className: symbolPath ?? "" };
        break;
      case "function_declaration":
      case "generator_function_declaration":
      case "method_definition":
      case "variable_declarator":
        if (symbolPath !== undefined) next = { ...current, caller: symbolPath, className: "" };
        break;
      case "public_field_definition":
        // A field holding a function is its own symbol; a data field's initialiser
        // runs as part of constructing the class.
        if (symbolPath !== undefined) next = { ...current, caller: symbolPath, className: "" };
        else if (current.className !== "") next = { ...current, caller: current.className };
        break;
      case "class_static_block":
        if (current.className !== "") next = { ...current, caller: current.className };
        break;
      default:
        break;
    }
    // The outermost function decides the local names; nested functions add nothing,
    // because the set is already flattened over everything inside it.
    if (current.locals === null && FUNCTION_SCOPES.has(node.type)) {
      next = { ...next, locals: boundNames(node) };
    }
    return next;
  }

  // ------------------------------------------------------------------ run

  try {
    ctx.source = source;
    for (const child of tree.rootNode.namedChildren) collectTop(child);
    if (tree.rootNode.hasError) recoverBrokenRegions();

    ctx.source = source;
    rowOffset = 0;
    walk(tree.rootNode, EMPTY_CTX);
    for (const statement of recoveredStatements) {
      ctx.source = statement.source;
      rowOffset = statement.rowOffset;
      walk(statement.node, EMPTY_CTX);
    }
  } finally {
    // Region trees are wasm allocations the finalizer would only reclaim later, and
    // a throw anywhere above must not strand them.
    for (const regionTree of regionTrees) regionTree.delete();
    regionTrees.length = 0;
    retainedBytes = 0;
    ctx.source = source;
    rowOffset = 0;
  }

  // Static imports are collected in document order by pass A and dynamic ones by
  // pass B, so the two streams interleave only after sorting. Line order is the
  // order a reader sees, and it is stable: same-line records keep pass order.
  // Recovery can re-read a byte range the shredded tree also yielded something for,
  // so identical records collapse.
  return {
    decls: collapseOverloads(entries),
    imports: dedupe(sortByLine(imports), importKey),
    exports: dedupe(exports, exportKey),
    calls: dedupe(sortByLine(calls), callKey),
  };
}

function importKey(record: ImportRecord): string {
  const symbols = record.symbols.map((symbol) => `${symbol.name}=${symbol.local}`).join(",");
  return [record.line, record.specifier, record.kind, String(record.reexport), symbols].join("|");
}

function exportKey(record: ExportRecord): string {
  return [record.name, record.kind, record.local ?? "", record.from ?? ""].join("|");
}

function callKey(record: CallSite): string {
  return [record.line, record.caller, record.callee].join("|");
}

/**
 * Names a function or class *expression* binds to itself: `const run = function g() {…}`
 * makes `g` the expression inside its own body, never the top-level `g`.
 */
const SELF_BINDING: ReadonlySet<string> = new Set(["function_expression", "generator_function", "class"]);

/** Every name bound anywhere inside a function: parameters, declarations, catches, loops. */
function boundNames(root: Node): ReadonlySet<string> {
  const names = new Set<string>();
  // The scope's own name counts only for the expression forms: a `function f()`
  // *declaration* binds `f` in the scope around it, so its recursive self-calls stay.
  if (SELF_BINDING.has(root.type)) addName(root, names);
  const stack: Node[] = [...root.namedChildren];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    switch (node.type) {
      case "variable_declarator":
        addPattern(node.childForFieldName("name"), names);
        break;
      case "required_parameter":
      case "optional_parameter":
        addPattern(node.childForFieldName("pattern"), names);
        break;
      case "function_declaration":
      case "generator_function_declaration":
      case "class_declaration":
      case "abstract_class_declaration":
      // Expression forms bind their name too, for anything nested inside them.
      case "function_expression":
      case "generator_function":
      case "class":
      case "enum_declaration":
      case "internal_module":
        addName(node, names);
        break;
      case "catch_clause":
        addPattern(node.childForFieldName("parameter"), names);
        break;
      case "for_in_statement":
        addPattern(node.childForFieldName("left"), names);
        break;
      case "arrow_function":
        addPattern(node.childForFieldName("parameter"), names);
        break;
      case "formal_parameters":
        // JavaScript sources have bare identifiers where TypeScript has parameters.
        for (const child of node.namedChildren) if (child.type === "identifier") names.add(child.text);
        break;
      default:
        break;
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return names;
}

/** The `name` a declaration binds, plus the head of a dotted namespace name. */
function addName(node: Node, names: Set<string>): void {
  const name = node.childForFieldName("name");
  if (name === null) return;
  names.add(name.text);
  // `namespace A.B {}` binds `A` in the scope around it.
  const dot = name.text.indexOf(".");
  if (dot > 0) names.add(name.text.slice(0, dot));
}

/** Names bound by a binding pattern, however nested. */
function addPattern(node: Node | null, names: Set<string>): void {
  if (node === null) return;
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      names.add(node.text);
      return;
    case "object_pattern":
    case "array_pattern":
      for (const child of node.namedChildren) addPattern(child, names);
      return;
    case "pair_pattern":
      addPattern(node.childForFieldName("value"), names);
      return;
    case "rest_pattern":
    case "assignment_pattern":
    case "object_assignment_pattern":
      addPattern(node.namedChildren[0] ?? null, names);
      return;
    default:
      return;
  }
}

function sortByLine<T extends { line: number }>(records: T[]): T[] {
  return records.sort((a, b) => a.line - b.line);
}

function dedupe<T>(records: T[], key: (record: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const record of records) {
    const id = key(record);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(record);
  }
  return out;
}

/**
 * One declaration per symbol id: an implementation wins over its overload and
 * abstract signatures, and otherwise the first declaration in the file wins
 * (accessor pairs, declaration merging). `exported` is true when any is exported.
 */
function collapseOverloads(entries: Entry[]): Declaration[] {
  const chosen = new Map<string, Entry>();
  const order: string[] = [];
  for (const entry of entries) {
    const previous = chosen.get(entry.decl.id);
    if (previous === undefined) {
      chosen.set(entry.decl.id, entry);
      order.push(entry.decl.id);
      continue;
    }
    const winner = previous.overload && !entry.overload ? entry : previous;
    const exported = previous.decl.exported || entry.decl.exported;
    chosen.set(entry.decl.id, { decl: { ...winner.decl, exported }, overload: winner.overload });
  }
  const decls: Declaration[] = [];
  for (const id of order) {
    const entry = chosen.get(id);
    if (entry !== undefined) decls.push(entry.decl);
  }
  return decls;
}
