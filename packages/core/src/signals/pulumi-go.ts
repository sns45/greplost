/**
 * Pulumi Go program signal pass (build 2, leaf 2.7; spec 2026-09-04 section 3.6).
 *
 * **The constructor check is structural, not name-based.** `s3.NewBucket(ctx, "site", …)` is a
 * resource because `s3` is the local name of an import whose path starts with
 * `github.com/pulumi/pulumi-`; an identically shaped `thing.NewThing(ctx, "x", &thing.ThingArgs{})`
 * from an in-repo package is not, and `fixtures/tiny-pulumi-go` carries that decoy so the rule
 * cannot quietly become a text match on `New`.
 *
 * Two narrowings the spec's sentence implies and this file makes explicit:
 *
 *  - `github.com/pulumi/pulumi/sdk/...` is the **core SDK**, a library rather than a provider.
 *    It makes the pass apply (a Go file that imports it is a Pulumi program), but
 *    `pulumi.NewFileAsset(...)` and `pulumi.NewAssetArchive(...)` are not resources. Only
 *    `github.com/pulumi/pulumi-<provider>/...` packages construct them.
 *  - the package identifier is **not** always the last path segment. `.../resources/v3` is
 *    package `resources`, because `/v3` is a Go module major-version suffix; the language
 *    extractor's `local` says `v3`, so this pass registers the version-stripped segment as a
 *    second name for that import. Eleven imports in the pinned corpus are written that way.
 *
 * A resource is named after the identifier its `:=` (or `=`, or `var`) binds. An unbound
 * result — `_, err = s3.NewBucketObject(...)`, or a bare call statement — is named `~<index>` by
 * its position among the file's unbound resources: the spec's `#<index>` cannot be used,
 * because `nodeId` refuses a `#` in a name (leaf 2.0 report, concern 1; driver ruling
 * 2026-09-04). A name bound twice inside one file takes `~<n>` from 2, the same rule.
 *
 * `resource-input`: a value inside the constructor's arguments that reads `<var>.<Field>` where
 * `<var>` is another resource in this file gives a reference. `vpc.ID()` and `bucket.Arn` both
 * reduce to the same `selector_expression`, so a method call and a field read are one rule.
 * Confidence is the linker's call (`references/go.ts`).
 *
 * Determinism: nothing here reads the filesystem, the clock or the environment, and the whole
 * pass is a function of `SignalInput` (spec section 3.1).
 */

import type { Node } from "web-tree-sitter";
import type { Declaration, ImportRecord, Lang, ReferenceRecord } from "../schema.ts";
import type { SignalInput, SignalOutput, SignalPass } from "./index.ts";
import { NameAllocator, field, signalNode, spanOf, stringOf, walk } from "./ts-nodes.ts";

const LANGS: ReadonlySet<Lang> = new Set<Lang>(["go"]);

/** Every provider SDK lives under this prefix; the segment after it is the provider. */
const PROVIDER_PREFIX = "github.com/pulumi/pulumi-";
/** The core SDK: a library, not a provider. Its presence still means "this is a Pulumi program". */
const CORE_SDK_PREFIX = "github.com/pulumi/pulumi/sdk";
/** `New` followed by an upper-case letter: Go's exported-constructor convention. */
const CONSTRUCTOR = /^New[A-Z]/u;
/** A Go module major-version suffix, which is never the package name. */
const VERSION_SEGMENT = /^v[0-9]+$/u;

/**
 * Cheap text gate (spec 3.6): a Go file that imports a Pulumi path.
 *
 * The opening quote is part of the needle, so a comment or a URL in a doc string does not make
 * a file a Pulumi program; Go import paths are always string literals.
 */
function applies(_path: string, source: string): boolean {
  for (const quote of ['"', "`"]) {
    if (source.includes(`${quote}${PROVIDER_PREFIX}`)) return true;
    if (source.includes(`${quote}${CORE_SDK_PREFIX}`)) return true;
  }
  return false;
}

export const pulumiGoPass: SignalPass = {
  id: "pulumi-go",
  langs: LANGS,
  applies,
  run(input: SignalInput): SignalOutput {
    const providers = providerImports(input.base.imports);
    if (providers.size === 0) return { decls: [], refs: [] };

    const names = new NameAllocator();
    const decls: Declaration[] = [];
    const refs: ReferenceRecord[] = [];
    /** Binding name -> the node name of the resource it holds, for `resource-input`. */
    const resourceByBinding = new Map<string, string>();
    const pending: Array<{ name: string; args: Node }> = [];
    let anonymous = 0;

    walk(input.tree.rootNode, (node) => {
      if (node.type !== "call_expression") return;
      const resource = classify(node, providers);
      if (resource === null) return;

      const binding = bindingNameOf(node);
      const name = names.take(binding ?? `~${anonymous}`);
      if (binding === null) anonymous += 1;
      else if (!resourceByBinding.has(binding)) resourceByBinding.set(binding, name);

      const resourceName = firstStringArgument(resource.args);
      decls.push(
        signalNode({
          path: input.path,
          kind: "resource",
          name,
          signature:
            resourceName === undefined
              ? `${resource.written}(…)`
              : `${resource.written}("${resourceName}")`,
          span: spanOf(node),
          signal: "pulumi-go",
          meta: {
            type: `${resource.provider}:${resource.module}/${lowerFirst(resource.type)}:${resource.type}`,
            typeSource: "import-path",
            provider: resource.provider,
            resourceName,
          },
        }),
      );
      pending.push({ name, args: resource.args });
    });

    // References come second: a resource may be fed the output of one constructed below it
    // (Go allows it through a closure), so the binding index has to be complete first.
    for (const { name, args } of pending) {
      for (const ref of resourceInputs(args, resourceByBinding, name)) refs.push(ref);
    }

    return { decls, refs };
  },
};

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

/** What a provider import contributes to a type token. */
interface ProviderImport {
  /** The `pulumi-<provider>` segment, verbatim (`aws`, `azure-native-sdk`, `aws-apigateway`). */
  provider: string;
  /** The segment that names the package, which is what a Pulumi type token's module is. */
  module: string;
}

/**
 * Local package identifier -> the provider import that bound it.
 *
 * Built from `SignalInput.base.imports` rather than from the tree: the language extractor has
 * already normalised every import form, and a signal pass that re-read the import block would
 * be a second, differently-wrong parser of the same syntax.
 *
 * The version-suffix names are added in a second sweep and never overwrite a name an import
 * actually bound; a suffix name two imports both want is dropped, because an ambiguous package
 * identifier is not one any rule may trust.
 */
function providerImports(imports: readonly ImportRecord[]): Map<string, ProviderImport> {
  const out = new Map<string, ProviderImport>();
  const extras = new Map<string, ProviderImport | null>();

  for (const record of imports) {
    if (!record.specifier.startsWith(PROVIDER_PREFIX)) continue;
    const entry = providerOf(record.specifier);
    if (entry === null) continue;
    for (const symbol of record.symbols) {
      // First binding wins: a name bound twice in one file is not a name a rule may trust.
      if (!out.has(symbol.local)) out.set(symbol.local, entry);
      // `local` is the alias when there is one and the last path segment otherwise, so a
      // version-suffixed path needs its package segment offered as well.
      if (symbol.local === entry.module || entry.module === "") continue;
      extras.set(entry.module, extras.has(entry.module) ? null : entry);
    }
  }

  for (const [name, entry] of extras) {
    if (entry === null || out.has(name)) continue;
    out.set(name, entry);
  }
  return out;
}

/** `github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3` -> `{ provider: "aws", module: "s3" }`. */
function providerOf(specifier: string): ProviderImport | null {
  const rest = specifier.slice(PROVIDER_PREFIX.length);
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  const provider = segments[0];
  if (provider === undefined || provider.length === 0) return null;
  return { provider, module: packageSegment(segments) };
}

/**
 * The segment of an import path that names the package.
 *
 * The last one, unless it is a major-version suffix: `.../aws/s3` is package `s3`, and
 * `.../resources/v3` is package `resources`. A path that is nothing but a version segment
 * (`pulumi-x/v2`) falls back to the provider itself.
 */
function packageSegment(segments: readonly string[]): string {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i] as string;
    if (!VERSION_SEGMENT.test(segment)) return segment;
  }
  return segments[0] ?? "";
}

// ---------------------------------------------------------------------------
// constructors
// ---------------------------------------------------------------------------

/** A call that constructs a Pulumi resource, and everything its node needs. */
interface ResourceCall {
  provider: string;
  module: string;
  /** The constructed type: `NewBucketPolicy` -> `BucketPolicy`. */
  type: string;
  /** The callee as written, for the signature. */
  written: string;
  /** The call's `argument_list`, where `resource-input` reads live. */
  args: Node;
}

/**
 * Classify one `call_expression`.
 *
 * `<pkg>.New<Type>(ctx, name, …)`: the package identifier must be a provider import, the field
 * must be an exported `New…`, and the call must carry at least the context and the name. Every
 * one of those is a question about the tree and the import block, never about the spelling of
 * the type.
 */
function classify(call: Node, providers: ReadonlyMap<string, ProviderImport>): ResourceCall | null {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "selector_expression") return null;
  const operand = field(callee, "operand");
  const selected = field(callee, "field");
  if (operand === null || selected === null) return null;
  if (operand.type !== "identifier" && operand.type !== "package_identifier") return null;
  if (!CONSTRUCTOR.test(selected.text)) return null;

  const provider = providers.get(operand.text);
  if (provider === undefined) return null;

  const args = field(call, "arguments");
  // Every Pulumi constructor takes at least a context and a logical name; a one-argument `New…`
  // is some other function that happens to share the prefix.
  if (args === null || args.namedChildren.filter((child) => child !== null).length < 2) return null;

  return {
    provider: provider.provider,
    module: provider.module,
    type: selected.text.slice(3),
    written: `${operand.text}.${selected.text}`,
    args,
  };
}

/**
 * The identifier a constructor's result is bound to, or null when it is not bound.
 *
 * Go's constructors return `(*T, error)`, so the resource is the first name on the left of a
 * `:=`, a `=` or a `var`. The blank identifier binds nothing, and a right-hand side holding
 * more than this one call is not a binding this rule can read.
 */
function bindingNameOf(call: Node): string | null {
  const list = call.parent;
  if (list === null || list.type !== "expression_list" || list.namedChildCount !== 1) return null;
  const statement = list.parent;
  if (statement === null) return null;

  if (statement.type === "short_var_declaration" || statement.type === "assignment_statement") {
    if (!isSameNode(field(statement, "right"), list)) return null;
    return firstIdentifier(field(statement, "left"));
  }
  if (statement.type === "var_spec" || statement.type === "const_spec") {
    if (!isSameNode(field(statement, "value"), list)) return null;
    return firstIdentifier(statement, "name");
  }
  return null;
}

/**
 * Whether two handles name the same tree node.
 *
 * `childForFieldName` hands back a fresh wrapper each time, so `===` on two handles for one
 * node is false; the node id is what identity means here.
 */
function isSameNode(a: Node | null, b: Node | null): boolean {
  return a !== null && b !== null && a.id === b.id;
}

/**
 * The first bound identifier of a left-hand side; null for `_` or for anything else.
 *
 * The blank identifier binds no name, and the grammar spells it `identifier` inside an
 * assignment's left-hand list, so the text is what has to be checked.
 */
function firstIdentifier(node: Node | null, fieldName?: string): string | null {
  if (node === null) return null;
  const first =
    fieldName === undefined
      ? node.namedChildren.find((child) => child !== null)
      : node.childrenForFieldName(fieldName).find((child) => child !== null);
  if (first === undefined || first === null) return null;
  if (first.type !== "identifier") return null;
  return first.text === "_" ? null : first.text;
}

/** The second argument when it is a string literal: Pulumi's logical name. */
function firstStringArgument(args: Node): string | undefined {
  const named = args.namedChildren.filter((child): child is Node => child !== null);
  const second = named[1];
  if (second === undefined) return undefined;
  if (second.type !== "interpreted_string_literal" && second.type !== "raw_string_literal") {
    return undefined;
  }
  return stringOf(second);
}

function lowerFirst(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

// ---------------------------------------------------------------------------
// resource inputs
// ---------------------------------------------------------------------------

/**
 * `resource-input` references from one constructor's arguments.
 *
 * Deliberately narrow: `<var>.<Field>` where `<var>` names another resource in this file.
 * `vpc.ID()` is a `call_expression` wrapping exactly that selector, and
 * `bucket.Arn.ApplyT(f)`'s innermost selector is still `bucket.Arn`, so both reduce to the same
 * node type and neither needs a rule of its own.
 */
function resourceInputs(
  args: Node,
  resourceByBinding: ReadonlyMap<string, string>,
  self: string,
): ReferenceRecord[] {
  const seen = new Set<string>();
  const out: ReferenceRecord[] = [];
  walk(args, (node) => {
    if (node.type !== "selector_expression") return;
    const operand = field(node, "operand");
    const selected = field(node, "field");
    if (operand === null || selected === null || operand.type !== "identifier") return;
    const target = resourceByBinding.get(operand.text);
    if (target === undefined || target === self) return;
    const address = `${operand.text}.${selected.text}`;
    if (seen.has(address)) return;
    seen.add(address);
    out.push({
      from: `resource.${self}`,
      to: address,
      refKind: "resource-input",
      line: spanOf(node)[0],
    });
  });
  return out;
}
