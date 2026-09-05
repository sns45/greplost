/**
 * Pulumi TypeScript program signal pass (build 2, leaf 2.3; spec 2026-09-04 section 3.5).
 *
 * **The class check is structural, not name-based.** A `new X(...)` is a resource when the root
 * of `X` resolves to an import whose specifier starts with `@pulumi/`, or when `X` is a class
 * declared in this file whose heritage clause names a `pulumi.*Resource`. A local class called
 * `Bucket` is not a resource, and that is the whole point of the rule.
 *
 * One narrowing the spec's text does not spell out but its intent requires: `@pulumi/pulumi` is
 * the SDK, not a provider. `new pulumi.Config()` and `new pulumi.asset.FileAsset(...)` are
 * imported from `@pulumi/pulumi` and are emphatically not resources, so from that one package
 * only the resource base classes and `StackReference` count, 46 `new pulumi.Config()` calls in
 * the pinned corpus would otherwise be resources. Every other `@pulumi/<provider>` package is a
 * provider SDK, whose exported classes are resources.
 *
 * A resource is named after the binding it is assigned to. An unassigned `new` (which is common,
 * a bucket policy nobody refers to again) takes its Pulumi logical name when the first argument
 * is a string literal (`~site`), and otherwise its position among the file's *remaining*
 * unassigned resources (`~0`). The literal comes first because a position is not an identity: an
 * unassigned resource inserted above another shifts every index below it, and the two sides of
 * the score then disagree about which node is which. This is the rule `signals/pulumi-go.ts`
 * already applies, extended here by the ruling of 2026-09-05. The spec's `#<index>` cannot be
 * used at all, because `nodeId` refuses a `#` in a name (leaf 2.0 report, concern 1), which is
 * also why a logical name containing one falls back to the index.
 *
 * `resource-input`: an argument that reads `<var>.<prop>` where `<var>` is another resource in
 * this file gives a reference. Confidence is the linker's call (`references/ts.ts`).
 */

import type { Node } from "web-tree-sitter";
import type { Declaration, Lang, ReferenceRecord } from "../schema.ts";
import type { SignalInput, SignalOutput, SignalPass } from "./index.ts";
import {
  NameAllocator,
  field,
  importBindings,
  memberPath,
  signalNode,
  spanOf,
  stringOf,
  walk,
} from "./ts-nodes.ts";
import type { ImportBinding } from "./ts-nodes.ts";

const LANGS: ReadonlySet<Lang> = new Set<Lang>(["ts", "tsx", "js", "jsx"]);

const PULUMI_SCOPE = "@pulumi/";
/** The core SDK: a library, not a provider. */
const PULUMI_CORE = "@pulumi/pulumi";

/**
 * The only classes `@pulumi/pulumi` itself exports that are resources. `Resource`,
 * `CustomResource`, `ComponentResource` and `ProviderResource` are the bases a program extends;
 * `StackReference` is the one concrete resource in the core SDK.
 */
const CORE_RESOURCE_CLASSES: ReadonlySet<string> = new Set([
  "ComponentResource",
  "CustomResource",
  "ProviderResource",
  "Resource",
  "StackReference",
]);

/** A heritage clause naming one of these, on `pulumi.` or bare, makes a local class a resource. */
const RESOURCE_BASE = /(^|\.)([A-Za-z0-9_$]*Resource)$/;

/**
 * Characters a node name cannot carry: `#` separates a file from its node in an id, and a
 * newline or a NUL cannot be in one at all (`nodeId`). A logical name holding any of them is
 * not usable as a name, so that resource falls back to its position.
 */
const UNUSABLE_IN_NAME = /[#\n\0]/u;

function applies(_path: string, source: string): boolean {
  return source.includes(PULUMI_SCOPE);
}

export const pulumiTsPass: SignalPass = {
  id: "pulumi-ts",
  langs: LANGS,
  applies,
  run(input: SignalInput): SignalOutput {
    const imports = importBindings(input.base.imports);
    const localResourceClasses = resourceClassesIn(input.tree.rootNode, imports);
    const names = new NameAllocator();
    const decls: Declaration[] = [];
    const refs: ReferenceRecord[] = [];
    /** Binding name -> the node name of the resource it holds, for `resource-input`. */
    const resourceByBinding = new Map<string, string>();
    const pending: Array<{ name: string; call: Node }> = [];
    let anonymous = 0;

    walk(input.tree.rootNode, (node) => {
      if (node.type !== "new_expression") return;
      const constructor = field(node, "constructor");
      if (constructor === null) return;
      const path = memberPath(constructor);
      if (path === null) return;
      const resource = classify(path, imports, localResourceClasses);
      if (resource === null) return;

      const binding = bindingNameOf(node);
      const resourceName = firstStringArgument(node);
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
          signature: signatureOf(node),
          span: spanOf(node),
          signal: "pulumi-ts",
          meta: {
            type: resource.type,
            typeSource: resource.typeSource,
            provider: resource.provider,
            resourceName: firstStringArgument(node),
          },
        }),
      );
      pending.push({ name, call: node });
    });

    // References come second: a resource may be fed the output of one declared below it, so the
    // binding index has to be complete before any argument is read.
    for (const { name, call } of pending) {
      for (const input_ of resourceInputs(call, resourceByBinding, name)) refs.push(input_);
    }

    return { decls, refs };
  },
};

/** What the constructor resolved to, when it resolved to a resource. */
interface ResourceClass {
  type: string | undefined;
  typeSource: string;
  provider: string | undefined;
}

/**
 * Classify `new <path>(...)`.
 *
 * Two structural routes, and nothing else: the root of the member path is an `@pulumi/` import,
 * or the whole path is a class this file declares with a resource heritage clause.
 */
function classify(
  path: string,
  imports: ReadonlyMap<string, ImportBinding>,
  localResourceClasses: ReadonlySet<string>,
): ResourceClass | null {
  const parts = path.split(".");
  const root = parts[0] as string;
  const className = parts[parts.length - 1] as string;

  if (parts.length === 1 && localResourceClasses.has(root)) {
    return { type: undefined, typeSource: "heritage", provider: undefined };
  }

  const binding = imports.get(root);
  if (binding === undefined || !binding.specifier.startsWith(PULUMI_SCOPE)) return null;

  // A named import (`import { Bucket } from "@pulumi/aws/s3"`) names the class itself; a
  // namespace import names the package, and the class is at the end of the member path.
  const modules = binding.name === "*" ? parts.slice(1, parts.length - 1) : specifierModules(binding.specifier);
  const provider = providerOf(binding.specifier);

  if (binding.specifier === PULUMI_CORE || provider === "pulumi") {
    // The core SDK: only the resource classes, and only when written without a namespace hop
    // (`pulumi.StackReference`, never `pulumi.asset.FileAsset`).
    if (!CORE_RESOURCE_CLASSES.has(className)) return null;
    if (binding.name === "*" && parts.length > 2) return null;
    return { type: `pulumi:pulumi/${lowerFirst(className)}:${className}`, typeSource: "import-path", provider: "pulumi" };
  }

  const module = modules.length === 0 ? "index" : modules.join("/");
  return {
    type: `${provider}:${module}/${lowerFirst(className)}:${className}`,
    typeSource: "import-path",
    provider,
  };
}

/** `@pulumi/aws` -> `aws`; `@pulumi/aws-apigateway` -> `aws-apigateway`. */
function providerOf(specifier: string): string {
  const rest = specifier.slice(PULUMI_SCOPE.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : rest.slice(0, slash);
}

/** `@pulumi/aws/s3` -> `["s3"]`; `@pulumi/aws` -> `[]`. */
function specifierModules(specifier: string): string[] {
  const rest = specifier.slice(PULUMI_SCOPE.length);
  const parts = rest.split("/");
  return parts.slice(1);
}

function lowerFirst(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Classes declared in this file whose heritage names a Pulumi resource base.
 *
 * `class X extends pulumi.ComponentResource` and `class X extends ComponentResource` (with
 * `ComponentResource` imported from `@pulumi/pulumi`) both count; `class X extends Base` where
 * `Base` is local does not, because nothing structural connects it to Pulumi.
 */
function resourceClassesIn(root: Node, imports: ReadonlyMap<string, ImportBinding>): ReadonlySet<string> {
  const out = new Set<string>();
  walk(root, (node) => {
    if (node.type !== "class_declaration" && node.type !== "abstract_class_declaration") return;
    const name = field(node, "name");
    if (name === null) return;
    for (const child of node.children) {
      if (child === null || child.type !== "class_heritage") continue;
      if (heritageIsPulumiResource(child, imports)) out.add(name.text);
    }
  });
  return out;
}

function heritageIsPulumiResource(heritage: Node, imports: ReadonlyMap<string, ImportBinding>): boolean {
  let found = false;
  walk(heritage, (node) => {
    if (found) return;
    if (node.type !== "identifier" && node.type !== "member_expression") return;
    const path = memberPath(node);
    if (path === null || !RESOURCE_BASE.test(path)) return;
    const root = path.split(".")[0] as string;
    // `pulumi.ComponentResource` needs the namespace to be a Pulumi import; a bare
    // `ComponentResource` needs to have been imported from one.
    const binding = imports.get(root);
    if (binding !== undefined && binding.specifier.startsWith(PULUMI_SCOPE)) found = true;
  });
  return found;
}

/** The identifier a `new` expression is assigned to, or null when it is not assigned. */
function bindingNameOf(call: Node): string | null {
  const parent = call.parent;
  if (parent === null) return null;
  if (parent.type === "variable_declarator") {
    const name = field(parent, "name");
    return name !== null && name.type === "identifier" ? name.text : null;
  }
  if (parent.type === "assignment_expression") {
    const left = field(parent, "left");
    return left !== null && left.type === "identifier" ? left.text : null;
  }
  return null;
}

/** The first constructor argument when it is a string literal: Pulumi's logical name. */
function firstStringArgument(call: Node): string | undefined {
  const args = field(call, "arguments");
  if (args === null) return undefined;
  const first = args.namedChildren.find((child) => child !== null);
  if (first === undefined || first === null || first.type !== "string") return undefined;
  return stringOf(first);
}

function signatureOf(call: Node): string {
  const constructor = field(call, "constructor");
  const name = firstStringArgument(call);
  const written = constructor === null ? "?" : (memberPath(constructor) ?? constructor.text);
  return name === undefined ? `new ${written}(…)` : `new ${written}("${name}")`;
}

/**
 * `resource-input` references from one `new` expression's arguments.
 *
 * The rule is deliberately narrow: `<var>.<prop>` where `<var>` names another resource in this
 * file. `bucket.arn.apply(f)` reaches the same place, because the innermost member expression
 * is still `bucket.arn`.
 */
function resourceInputs(
  call: Node,
  resourceByBinding: ReadonlyMap<string, string>,
  self: string,
): ReferenceRecord[] {
  const args = field(call, "arguments");
  if (args === null) return [];
  const seen = new Set<string>();
  const out: ReferenceRecord[] = [];
  walk(args, (node) => {
    if (node.type !== "member_expression") return;
    const object = field(node, "object");
    const property = field(node, "property");
    if (object === null || property === null) return;
    if (object.type !== "identifier" || property.type !== "property_identifier") return;
    const target = resourceByBinding.get(object.text);
    if (target === undefined || target === self) return;
    const address = `${object.text}.${property.text}`;
    if (seen.has(address)) return;
    seen.add(address);
    out.push({ from: `resource.${self}`, to: address, refKind: "resource-input", line: spanOf(node)[0] });
  });
  return out;
}
