/**
 * The Go type facts one file can decide on its own (build 2.1, leaf 2.13).
 *
 * `extract/go.ts` records what a `.go` file says; `resolve/go.ts` turns that into
 * edges. Neither can see the other's file, so three facts have to be written
 * down while the tree is in hand, or they are gone by resolution time:
 *
 *  - the **shape of a struct**: the types it embeds, so `recv.m()` can find the
 *    method a type promotes rather than only the ones it declares itself, and
 *    the names of its own fields, because a field of that name shadows every
 *    promoted method below it and is never a call target;
 *  - the **named type a function or method returns**, so `x, err := f()` types
 *    `x` without the resolver reading another package's source;
 *  - the **local bindings whose type the syntax fixes**: `x := &T{}`, `x := T{}`,
 *    `var x T`, `var x *T`, `x, err := f()`, and a parameter typed `T` or `*T`.
 *
 * They ride in `Declaration.meta`, the schema's home for language attributes
 * with no other place (the Kotlin extractor already puts a package there).
 *
 * Nothing here infers. A binding whose type needs type inference (a map index, a
 * type assertion, a conversion, a value from another package's function) is
 * recorded as *undecidable*, and a name bound twice with two different types is
 * undecidable too: the extractor flattens Go's block scoping deliberately (see
 * `boundNames`), so agreement across every binding in one function is what makes
 * a type safe to use. Under-dropping here would emit a wrong `high` edge, which
 * is the one thing the structure layer must never do.
 */

import type { Node } from "web-tree-sitter";
import { field } from "./ts-signature.ts";

/**
 * Go's predeclared type names. A result of one of these names no declaration in
 * the repo, so recording it would only add noise to a card.
 */
const PREDECLARED: ReadonlySet<string> = new Set([
  "any",
  "bool",
  "byte",
  "comparable",
  "complex64",
  "complex128",
  "error",
  "float32",
  "float64",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "rune",
  "string",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
]);

/** A binding whose type the syntax does not fix. */
const UNDECIDED = null;

/**
 * The named type a type expression denotes, pointer, parentheses and type
 * arguments stripped: `*Store`, `(Store)` and `Store[T]` all give `Store`, and
 * `*core.Base` gives `core.Base`. A slice, map, channel, function or anonymous
 * struct type gives null: none of them names a declaration.
 */
export function namedType(node: Node | null): string | null {
  let current = node;
  while (current !== null) {
    if (current.type === "type_identifier") return current.text;
    if (current.type === "qualified_type") {
      const pkg = field(current, "package");
      const name = field(current, "name");
      if (pkg === null || name === null) return null;
      return `${pkg.text}.${name.text}`;
    }
    if (current.type === "pointer_type" || current.type === "generic_type" || current.type === "parenthesized_type") {
      current = current.namedChild(0);
      continue;
    }
    return null;
  }
  return null;
}

/** What a struct declaration says about itself, both halves sorted. */
export interface GoStructShape {
  /** The types it embeds: every `field_declaration` written without a name. */
  embeds: string[];
  /** Its own field names, which no promoted method of the same name survives. */
  fields: string[];
}

/**
 * The embedded types and the field names of a struct, sorted and deduplicated.
 *
 * An embedded field is a `field_declaration` written without a name, and every
 * other one contributes its names. An embedded type the tree cannot name (an
 * anonymous struct, a type parameter constraint) is skipped, and so is a field
 * named `_`, which no selector can reach.
 */
export function structShape(typeNode: Node | null): GoStructShape {
  const embeds = new Set<string>();
  const fields = new Set<string>();
  if (typeNode === null || typeNode.type !== "struct_type") return { embeds: [], fields: [] };
  for (const child of typeNode.namedChildren) {
    if (child.type !== "field_declaration_list") continue;
    for (const declaration of child.namedChildren) {
      if (declaration.type !== "field_declaration") continue;
      const named = declaration.childrenForFieldName("name");
      if (named.length === 0) {
        const name = namedType(field(declaration, "type"));
        if (name !== null) embeds.add(name);
        continue;
      }
      for (const name of named) {
        if (name.text !== "_") fields.add(name.text);
      }
    }
  }
  return { embeds: [...embeds].sort(), fields: [...fields].sort() };
}

/**
 * The named type of a function's or method's first result, or null.
 *
 * `func New() (*Store, error)` gives `Store`; `func Count() int` gives null,
 * because a predeclared type is not a declaration a call can land on.
 */
export function firstResultType(node: Node): string | null {
  const result = field(node, "result");
  if (result === null) return null;
  const first = result.type === "parameter_list" ? (result.namedChild(0) ?? null) : result;
  if (first === null) return null;
  const type = namedType(first.type === "parameter_declaration" ? field(first, "type") : first);
  if (type === null || PREDECLARED.has(type)) return null;
  return type;
}

/**
 * Callee text, normalised the way `CallSite.callee` fixes it:
 * `f()` -> `f`, `pkg.F()` / `recv.m()` -> `pkg.F` / `recv.m`. Anything else -
 * a deeper chain, a call on a call, a generic instantiation, a call on a
 * parenthesised or literal value - is not recorded. Composite literals
 * (`Store{...}`) are not call expressions in Go and never reach here.
 */
export function calleeText(node: Node): string | null {
  const fn = field(node, "function");
  if (fn === null) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type !== "selector_expression") return null;
  const operand = field(fn, "operand");
  const member = field(fn, "field");
  if (operand === null || member === null || operand.type !== "identifier") return null;
  return `${operand.text}.${member.text}`;
}

/** The composite literal behind an expression: `T{}` and `&T{}` both give it. */
function compositeLiteral(expression: Node): Node | null {
  if (expression.type === "composite_literal") return expression;
  if (expression.type !== "unary_expression") return null;
  const operand = field(expression, "operand");
  return operand !== null && operand.type === "composite_literal" ? operand : null;
}

/**
 * The type an initialiser fixes, or null when it needs inference.
 *
 * A call is recorded as `@<callee>`: the resolver knows which declaration the
 * callee names and what that declaration returns, and this file does not. Only
 * two callees qualify, the two the resolver can follow in one hop: a
 * package-scope function of this file's own package, and a method on `receiver`.
 * A callee whose leading identifier is a local binding is refused, because
 * `f := func() *Store { ... }; x := f()` says nothing about a package-scope `f`,
 * and `store.New()` is refused because another package's result is not written
 * down in this file.
 */
function initialiserType(expression: Node, bound: ReadonlySet<string>, receiver: string | null): string | null {
  const literal = compositeLiteral(expression);
  if (literal !== null) {
    const type = namedType(field(literal, "type"));
    return type === null || bound.has(type.split(".")[0] ?? type) ? UNDECIDED : type;
  }
  if (expression.type !== "call_expression") return UNDECIDED;
  const callee = calleeText(expression);
  if (callee === null) return UNDECIDED;
  const dot = callee.indexOf(".");
  if (dot === -1) return bound.has(callee) ? UNDECIDED : `@${callee}`;
  return receiver !== null && callee.slice(0, dot) === receiver ? `@${callee}` : UNDECIDED;
}

/** Identifiers of an expression list, or of a lone identifier. */
function listNames(node: Node | null): Node[] {
  if (node === null) return [];
  if (node.type === "identifier") return [node];
  return node.namedChildren.filter((child) => child.type === "identifier");
}

/**
 * Every local of one function whose type the syntax fixes, `name -> type`.
 *
 * `bound` is the function's whole set of local names (`boundNames`), used to
 * refuse an initialiser that calls a local rather than a package-scope name.
 * `receiver` is the receiver variable, dropped from the result because the
 * resolver already knows the receiver's type from the method it is resolving -
 * but kept in the agreement check above, so a method that rebinds its receiver
 * to another type decides nothing.
 */
export function typedLocals(fn: Node, bound: ReadonlySet<string>, receiver: string | null): Map<string, string> {
  const types = new Map<string, string | null>();
  const record = (name: Node | null, type: string | null): void => {
    if (name === null) return;
    const key = name.text;
    if (key === "_") return;
    if (!types.has(key)) types.set(key, type);
    else if (types.get(key) !== type) types.set(key, UNDECIDED);
  };

  const visit = (node: Node): void => {
    switch (node.type) {
      case "parameter_declaration": {
        const type = namedType(field(node, "type"));
        for (const name of node.childrenForFieldName("name")) record(name, type);
        break;
      }
      case "variadic_parameter_declaration":
        // `xs ...T` binds a slice, which names no method set of its own.
        for (const name of node.childrenForFieldName("name")) record(name, UNDECIDED);
        break;
      case "var_spec": {
        const type = field(node, "type") === null ? UNDECIDED : namedType(field(node, "type"));
        for (const name of node.childrenForFieldName("name")) record(name, type);
        break;
      }
      case "const_spec":
      case "type_spec":
        for (const name of node.childrenForFieldName("name")) record(name, UNDECIDED);
        break;
      case "short_var_declaration": {
        const names = listNames(field(node, "left"));
        const values = field(node, "right")?.namedChildren ?? [];
        if (names.length === values.length) {
          // One initialiser each: every name is decided on its own.
          names.forEach((name, i) => record(name, initialiserType(values[i] as Node, bound, receiver)));
        } else {
          // `x, err := f()`: one call fills every name, and only the first of
          // them takes the call's first result.
          const only = values.length === 1 ? (values[0] as Node) : null;
          const type =
            only === null || only.type !== "call_expression" ? UNDECIDED : initialiserType(only, bound, receiver);
          names.forEach((name, i) => record(name, i === 0 ? type : UNDECIDED));
        }
        break;
      }
      case "range_clause":
        for (const name of listNames(field(node, "left"))) record(name, UNDECIDED);
        break;
      case "type_switch_statement":
        for (const name of listNames(field(node, "alias"))) record(name, UNDECIDED);
        break;
      default:
        break;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(fn);

  const decided = new Map<string, string>();
  for (const [name, type] of types) {
    if (type !== UNDECIDED && name !== receiver) decided.set(name, type);
  }
  return decided;
}
