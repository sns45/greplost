/**
 * Call resolution and symbol paths for the TypeScript truth generator (leaf 1.5.1).
 *
 * Split out of `truth/ts.ts`: that file owns the program, module resolution, imports and
 * exports; this one owns the two questions a call edge asks — *what is being called* and
 * *who is calling it* — in greplost's id vocabulary (tech spec 5.3).
 *
 * Conservatism rules, restated (a truth set that over-claims is worse than useless):
 *   - the callee must be a plain identifier or the `.name` of a property access; element
 *     access, `super()`, `import()` and calls on call results are never guessed;
 *   - the target declaration must be *addressable*: at module scope (optionally inside
 *     namespaces) or a member of a named class / interface / enum. Locals, parameters,
 *     loop bindings and import specifiers are never call targets;
 *   - the caller follows core's extractor rule exactly (see `isCallerDeclaration`), because
 *     truth and prediction are compared on `(from, to)` and a caller the two sides disagree
 *     about costs one false positive *and* one false negative.
 */
import ts from "typescript";
import { symbolId } from "@greplost/core/schema";

/** Both ends of one resolved call edge, already in greplost id form. */
export interface CallEndpoints {
  /** `<file>#<symbol>` of the enclosing declaration, or `<file>` for top-level code. */
  from: string;
  /** `<file>#<symbol>` of the callee's declaration. */
  to: string;
}

/**
 * Resolve one call or construction to a truth edge, or undefined when it does not resolve
 * to an addressable declaration in a listed file.
 *
 * `toId` maps an absolute file name to a listed file id (or undefined when the file is
 * outside the scored universe: lib.d.ts, node_modules, a file the caller did not list).
 */
/** A call, a construction, or a tagged template (`tag\`…\`` invokes `tag`; ruling 2026-09-04). */
export type CallLike = ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;

export function resolveCallEdge(
  node: CallLike,
  checker: ts.TypeChecker,
  toId: (fileName: string) => string | undefined,
  fileId: string,
): CallEndpoints | undefined {
  const callee = calleeIdentifier(node);
  if (!callee) return undefined;
  const symbol = unalias(checker, checker.getSymbolAtLocation(callee));
  if (!symbol) return undefined;

  for (const declaration of symbol.declarations ?? []) {
    const targetFile = toId(declaration.getSourceFile().fileName);
    if (targetFile === undefined) continue;
    const targetPath = declarationSymbolPath(declaration);
    if (targetPath === undefined) continue;
    return { from: enclosingCaller(node, fileId), to: symbolId(targetFile, targetPath) };
  }
  return undefined;
}

/** Look through parentheses, non-null assertions and `as` / `satisfies` casts. */
export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    else return current;
  }
}

/** The identifier naming the callee: `foo`, the `.name` of `a.foo`, else nothing. */
export function calleeIdentifier(node: CallLike): ts.Node | undefined {
  const expr = unwrapExpression(ts.isTaggedTemplateExpression(node) ? node.tag : node.expression);
  if (ts.isIdentifier(expr)) return expr;
  if (ts.isPropertyAccessExpression(expr)) return expr.name;
  // Element access, `super()`, `import()`, calls on call results: never guessed.
  return undefined;
}

/** Follow import/export aliases to the declaration that actually defines the symbol. */
export function unalias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
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
export function declarationSymbolPath(declaration: ts.Declaration): string | undefined {
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
export function moduleScopePath(node: ts.Node): string | undefined {
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

/**
 * Declaration kinds that own the calls written inside them.
 *
 * This mirrors core's extractor rule (core-extract spec) exactly, and deliberately does
 * not generalise it:
 *   - a function, method, accessor or constructor owns its body;
 *   - a `variable_declarator` owns its calls **only when its value is a function or arrow**,
 *     so module-scope `const a = b();` belongs to the file, not to `a`;
 *   - a class field whose value is a function or arrow is a method in core (`C.handle`), so
 *     it owns its body the same way; a field with any other initializer falls through to
 *     the class, so `private bus = new Bus()` belongs to `C`;
 *   - a class owns its field initializers and its `static {}` blocks;
 *   - everything else (namespaces, interfaces, enums, plain variable initializers) falls
 *     through to the enclosing scope, and top-level code belongs to the file.
 */
function isCallerDeclaration(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
    // The initializer is unwrapped exactly as `calleeIdentifier` unwraps a callee, so
    // `const f = ((…) => {…})` owns its calls like `const f = <T>(…) => …` already does.
    const initializer = node.initializer === undefined ? undefined : unwrapExpression(node.initializer);
    return initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
  }
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    // Kept for the class field initializer rule: `private bus = new Bus()` belongs to the class.
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/**
 * The symbol that owns a call site: the nearest enclosing declaration that owns its calls.
 *
 * Anonymous functions and local declarations are walked through — a call inside
 * `retry(() => this.client.send(cmd))` belongs to the method around it — and a call in a
 * class property initializer belongs to the class. Top-level code belongs to the file.
 */
export function enclosingCaller(node: ts.Node, fileId: string): string {
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
