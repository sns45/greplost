/**
 * Pulumi Go program signal pass (build 2, leaf 2.7; spec 2026-09-04 section 3.6).
 *
 * **The constructor check is structural, not name-based.** `s3.NewBucket(ctx, "site", …)` is a
 * resource because `s3` is the local name of an import whose path starts with
 * `github.com/pulumi/pulumi-`; an identically shaped `thing.NewThing(ctx, "x", &thing.ThingArgs{})`
 * from an in-repo package is not, and `fixtures/tiny-pulumi-go` carries that decoy so the rule
 * cannot quietly become a text match on `New`.
 *
 * Three shapes make a resource, and all three are questions about the import block and the
 * call, never about the spelling of a type:
 *
 *  - `<pkg>.New<Type>(ctx, name, …)` where `<pkg>` is a provider import: construction.
 *  - `<pkg>.Get<Type>(ctx, "<name>", id, state, …)` where `<pkg>` is a provider import:
 *    **adoption** of a resource that already exists. It is separated from a data source by its
 *    shape and not by widening the `New` regex, because `Get`/`Lookup` is also how a provider
 *    SDK spells a data source, and a data source returns a plain result struct. A data source
 *    is `Get<Thing>(ctx, args, opts)` — two or three arguments, and the second is an args
 *    pointer or `nil`; an adoption constructor takes at least four and names the resource with
 *    a string literal in the second.
 *  - `pulumi.NewStackReference(ctx, name, …)` from the **core SDK**. The core SDK is a library
 *    rather than a provider — `pulumi.NewFileAsset(...)` and `pulumi.NewAssetArchive(...)` are
 *    not resources — and `StackReference` is the one concrete resource it exports, exactly as
 *    `signals/pulumi-ts.ts` treats `@pulumi/pulumi`.
 *
 * One further reading the spec's sentence leaves open: the package identifier is **not** always
 * the last path segment. `.../resources/v3` is package `resources`, because `/v3` is a Go
 * module major-version suffix; the language extractor's `local` says `v3`, so this pass
 * registers the version-stripped segment as a second name for that import. Eleven imports in
 * the pinned corpus are written that way.
 *
 * `meta.type` is a **derived approximation** of the Pulumi type token, not the token the engine
 * uses. It is exact for the AWS-classic shape the spec describes (`.../go/aws/s3` +
 * `NewBucket` -> `aws:s3/bucket:Bucket`); elsewhere it is the best an import path can give.
 * `azure-native` is published as `github.com/pulumi/pulumi-azure-native-sdk/resources/v3`, so
 * this pass writes `azure-native-sdk:resources/resourceGroup:ResourceGroup` where the engine
 * says `azure-native:resources:ResourceGroup`. No metric scores `meta.type`; a card reader
 * should treat it as a label, and `meta.provider` as the reliable half.
 *
 * A resource is named after the identifier its `:=` (or `=`, or `var`) binds. An unbound
 * result — `_, err = s3.NewBucketObject(...)`, or a bare call statement — takes its Pulumi
 * logical name when the second argument is a string literal (`~site`), and otherwise its
 * position among the file's *remaining* unbound resources (`~0`). The literal comes first
 * because a position is not an identity: an unbound resource inserted above another shifts
 * every index below it, and the two sides of the score then disagree about which node is which
 * (leaf 2.7 review, item 3). The spec's `#<index>` cannot be used at all, because `nodeId`
 * refuses a `#` in a name (leaf 2.0 report, concern 1; driver ruling 2026-09-04), which is also
 * why a logical name containing one falls back to the index. A name taken twice inside one file
 * takes `~<n>` from 2, and the allocator is seeded with the file's own language declarations so
 * a Go method on a lower-case type named `resource` cannot be shadowed by a node.
 *
 * `resource-input` is two rules over the constructor's arguments:
 *
 *  - a value that reads `<var>.<Field>` where `<var>` is another resource in this file.
 *    `vpc.ID()` and `bucket.Arn` both reduce to the same `selector_expression`, so a method
 *    call and a field read need one rule between them; the reference's `to` is `<var>.<Field>`.
 *  - a bare identifier naming another resource inside `pulumi.Parent(...)` or
 *    `pulumi.DependsOn(...)`, whose `to` is the bare `<var>`. Those two options are a
 *    dependency the map would otherwise lose entirely (driver ruling, leaf 2.7 review item 2);
 *    `pulumi.Provider(...)` and the rest are deliberately not read, so a bare identifier
 *    anywhere else is never an edge.
 *
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

/** The symbol-path prefix a `resource` node's name carries, for the allocator's seeding. */
const NODE_NAME_PREFIX = "resource.";

/** Every provider SDK lives under this prefix; the segment after it is the provider. */
const PROVIDER_PREFIX = "github.com/pulumi/pulumi-";
/** The core SDK: a library, not a provider. Its presence still means "this is a Pulumi program". */
const CORE_SDK_PREFIX = "github.com/pulumi/pulumi/sdk";
/** The core SDK package itself; `.../go/pulumi/config` is a different package. */
const CORE_PACKAGE_SUFFIX = "/go/pulumi";
/** The one concrete resource the core SDK exports. */
const CORE_RESOURCE = "NewStackReference";
/** `New` followed by an upper-case letter: Go's exported-constructor convention. */
const CONSTRUCTOR = /^New[A-Z]/u;
/** `Get` followed by an upper-case letter: adoption, and also how a data source is spelled. */
const ADOPTION = /^Get[A-Z]/u;
/** How many arguments an adoption constructor takes before its variadic options. */
const ADOPTION_ARITY = 4;
/** A Go module major-version suffix, which is never the package name. */
const VERSION_SEGMENT = /^v[0-9]+$/u;
/** The resource options that name another resource outright (driver ruling, review item 2). */
const RESOURCE_OPTIONS: ReadonlySet<string> = new Set(["DependsOn", "Parent"]);
/** Characters `nodeId` refuses in a name; a logical name carrying one falls back to an index. */
const UNUSABLE_IN_NAME = /[#\n\0]/u;

/**
 * Cheap text gate (spec 3.6): a Go file that imports a Pulumi path.
 *
 * The opening quote is part of the needle, so a comment or a URL in a doc string does not make
 * a file a Pulumi program; Go import paths are always string literals.
 */
function applies(_path: string, source: string): boolean {
  return source.includes(`"${PROVIDER_PREFIX}`) || source.includes(`"${CORE_SDK_PREFIX}`);
}

export const pulumiGoPass: SignalPass = {
  id: "pulumi-go",
  langs: LANGS,
  applies,
  run(input: SignalInput): SignalOutput {
    const providers = providerImports(input.base.imports);
    const core = coreImports(input.base.imports);
    if (providers.size === 0 && core.size === 0) return { decls: [], refs: [] };

    // Seeded with the file's own declarations: a Go method on a lower-case type named
    // `resource` has the symbol path `resource.bucket`, which is exactly the id a
    // `resource.bucket` node would claim, and a node must never stand in for a symbol.
    const names = new NameAllocator();
    for (const decl of input.base.decls) {
      if (decl.name.startsWith(NODE_NAME_PREFIX)) names.take(decl.name.slice(NODE_NAME_PREFIX.length));
    }

    const decls: Declaration[] = [];
    const refs: ReferenceRecord[] = [];
    /** Binding name -> the node name of the resource it holds, for `resource-input`. */
    const resourceByBinding = new Map<string, string>();
    const pending: Array<{ name: string; args: Node }> = [];
    let anonymous = 0;

    walk(input.tree.rootNode, (node) => {
      if (node.type !== "call_expression") return;
      const resource = classify(node, providers, core);
      if (resource === null) return;

      const binding = bindingNameOf(node);
      const resourceName = logicalNameArgument(resource.args);
      let claimed: string;
      if (binding !== null) {
        claimed = binding;
      } else if (resourceName !== undefined && resourceName !== "" && !UNUSABLE_IN_NAME.test(resourceName)) {
        claimed = `~${resourceName}`;
      } else {
        claimed = `~${anonymous}`;
        anonymous += 1;
      }
      const name = names.take(claimed);
      if (binding !== null && !resourceByBinding.has(binding)) resourceByBinding.set(binding, name);

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
            adopted: resource.adopted ? "1" : undefined,
          },
        }),
      );
      pending.push({ name, args: resource.args });
    });

    // References come second: a resource may be fed the output of one constructed below it
    // (Go allows it through a `var` declared above and assigned later), so the binding index
    // has to be complete first.
    for (const { name, args } of pending) {
      for (const ref of resourceInputs(args, resourceByBinding, name, core)) refs.push(ref);
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

/**
 * Local names bound to the core SDK's own `pulumi` package.
 *
 * `.../sdk/v3/go/pulumi/config` and `.../sdk/v3/go/common/resource` are different packages and
 * are deliberately not in the set: only the package that exports `StackReference`, `Parent` and
 * `DependsOn` counts.
 */
function coreImports(imports: readonly ImportRecord[]): Set<string> {
  const out = new Set<string>();
  for (const record of imports) {
    if (!record.specifier.startsWith(CORE_SDK_PREFIX)) continue;
    if (!record.specifier.endsWith(CORE_PACKAGE_SUFFIX)) continue;
    for (const symbol of record.symbols) out.add(symbol.local);
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

/** A call that constructs or adopts a Pulumi resource, and everything its node needs. */
interface ResourceCall {
  provider: string;
  module: string;
  /** The constructed type: `NewBucketPolicy` -> `BucketPolicy`, `GetService` -> `Service`. */
  type: string;
  /** True for the `Get<Type>` adoption form, which becomes `meta.adopted`. */
  adopted: boolean;
  /** The callee as written, for the signature. */
  written: string;
  /** The call's `argument_list`, where `resource-input` reads live. */
  args: Node;
}

/**
 * Classify one `call_expression`, by the three shapes named in this file's header.
 *
 * Nothing here reads the spelling of a type. What it reads is where the package identifier was
 * imported from, whether the selected name is an exported `New…` or `Get…`, how many arguments
 * the call carries, and whether the second one is a string literal.
 */
function classify(
  call: Node,
  providers: ReadonlyMap<string, ProviderImport>,
  core: ReadonlySet<string>,
): ResourceCall | null {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "selector_expression") return null;
  const operand = field(callee, "operand");
  const selected = field(callee, "field");
  if (operand === null || selected === null) return null;
  if (operand.type !== "identifier" && operand.type !== "package_identifier") return null;

  const args = field(call, "arguments");
  if (args === null) return null;
  const arity = args.namedChildren.filter((child) => child !== null).length;
  const written = `${operand.text}.${selected.text}`;

  const provider = providers.get(operand.text);
  if (provider !== undefined) {
    // Every Pulumi constructor takes at least a context and a logical name; a one-argument
    // `New…` is some other function that happens to share the prefix.
    if (CONSTRUCTOR.test(selected.text) && arity >= 2) {
      return { ...tokenOf(provider, selected.text.slice(3)), adopted: false, written, args };
    }
    // Adoption: `Get<Type>(ctx, "<name>", id, state, …)`. A data source is `Get<Thing>(ctx,
    // args, opts)` or `Lookup<Thing>(ctx, args)` — never four arguments with a string-literal
    // name in the second, which is what separates the two without naming either.
    if (ADOPTION.test(selected.text) && arity >= ADOPTION_ARITY && logicalNameArgument(args) !== undefined) {
      return { ...tokenOf(provider, selected.text.slice(3)), adopted: true, written, args };
    }
    return null;
  }

  // The core SDK is a library with exactly one concrete resource in it.
  if (core.has(operand.text) && selected.text === CORE_RESOURCE && arity >= 2) {
    return { provider: "pulumi", module: "pulumi", type: CORE_RESOURCE.slice(3), adopted: false, written, args };
  }
  return null;
}

function tokenOf(provider: ProviderImport, type: string): Pick<ResourceCall, "provider" | "module" | "type"> {
  return { provider: provider.provider, module: provider.module, type };
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

/**
 * The second argument when it is a string literal: Pulumi's logical name.
 *
 * Every resource constructor and adoption function in every Pulumi Go SDK takes the context
 * first and the logical name second, so this one accessor answers both "what is this resource
 * called" and "is this the adoption form rather than a data source".
 */
function logicalNameArgument(args: Node): string | undefined {
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
 * Two narrow rules, and nothing else:
 *
 *  - `<var>.<Field>` where `<var>` names another resource in this file. `vpc.ID()` is a
 *    `call_expression` wrapping exactly that selector, and `bucket.Arn.ApplyT(f)`'s innermost
 *    selector is still `bucket.Arn`, so a method call and a field read need one rule.
 *  - a bare `<var>` inside `pulumi.Parent(...)` or `pulumi.DependsOn(...)`. A bare identifier is
 *    only ever read inside those two, so `pulumi.Provider(p)` and an args field holding a
 *    resource value produce nothing.
 */
function resourceInputs(
  args: Node,
  resourceByBinding: ReadonlyMap<string, string>,
  self: string,
  core: ReadonlySet<string>,
): ReferenceRecord[] {
  const seen = new Set<string>();
  const out: ReferenceRecord[] = [];
  const add = (address: string, line: number): void => {
    if (seen.has(address)) return;
    seen.add(address);
    out.push({ from: `resource.${self}`, to: address, refKind: "resource-input", line });
  };
  const bareNames = (node: Node): void => {
    walk(node, (inner) => {
      if (inner.type !== "identifier") return;
      const target = resourceByBinding.get(inner.text);
      if (target === undefined || target === self) return;
      add(inner.text, spanOf(inner)[0]);
    });
  };

  walk(args, (node) => {
    if (node.type === "call_expression") {
      const option = resourceOptionArguments(node, core);
      if (option !== null) bareNames(option);
      return;
    }
    if (node.type !== "selector_expression") return;
    const operand = field(node, "operand");
    const selected = field(node, "field");
    if (operand === null || selected === null || operand.type !== "identifier") return;
    const target = resourceByBinding.get(operand.text);
    if (target === undefined || target === self) return;
    add(`${operand.text}.${selected.text}`, spanOf(node)[0]);
  });
  return out;
}

/** The `argument_list` of a `pulumi.Parent(...)`/`pulumi.DependsOn(...)` call, or null. */
function resourceOptionArguments(call: Node, core: ReadonlySet<string>): Node | null {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "selector_expression") return null;
  const operand = field(callee, "operand");
  const selected = field(callee, "field");
  if (operand === null || selected === null || operand.type !== "identifier") return null;
  if (!core.has(operand.text) || !RESOURCE_OPTIONS.has(selected.text)) return null;
  return field(call, "arguments");
}
