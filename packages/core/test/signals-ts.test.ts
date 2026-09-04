/**
 * TypeScript framework signal passes (build 2, leaf 2.3; spec 2026-09-04 sections 3.1 to 3.5).
 *
 * `describe` names are fixed by the spec and by `gates/leaf-2.3.md`; do not rename them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractFile } from "../src/extract/index.ts";
import { extractTs } from "../src/extract/ts.ts";
import { SIGNAL_PASSES, runSignals } from "../src/signals/index.ts";
import { nextRoutePath } from "../src/signals/next.ts";
import { pulumiTsPass } from "../src/signals/pulumi-ts.ts";
import { buildSnapshot } from "../src/build.ts";
import type { SignalOutput, SignalPass } from "../src/signals/index.ts";
import type { Declaration, Lang, ReferenceRecord, Snapshot } from "../src/schema.ts";
import { compareDeclarations, splitNodeId, stableStringify } from "../src/schema.ts";

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "fixtures/tiny-signals-ts");

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

/** Everything the applicable passes produce for one file, exactly as `extractFile` runs them. */
function signals(path: string, lang: Lang, source: string): SignalOutput {
  const tree = parser.parse(source, lang);
  try {
    const base = extractTs(path, lang, source, tree);
    return runSignals({
      path,
      lang,
      source,
      tree,
      base: { decls: base.decls, imports: base.imports, exports: base.exports, calls: base.calls },
    });
  } finally {
    tree.delete();
  }
}

/** One pass on its own, bypassing `applies`, so a rule can be tested without its path gate. */
function runPass(pass: SignalPass, path: string, lang: Lang, source: string): SignalOutput {
  const tree = parser.parse(source, lang);
  try {
    const base = extractTs(path, lang, source, tree);
    return pass.run({
      path,
      lang,
      source,
      tree,
      base: { decls: base.decls, imports: base.imports, exports: base.exports, calls: base.calls },
    });
  } finally {
    tree.delete();
  }
}

function ids(out: SignalOutput): string[] {
  return out.decls.map((d) => d.id);
}

function node(out: SignalOutput, id: string): Declaration {
  const found = out.decls.find((d) => d.id === id);
  if (!found) throw new Error(`no signal node ${id} in [${ids(out).join(", ")}]`);
  return found;
}

function refs(out: SignalOutput): Array<[string, string, string]> {
  return out.refs.map((r: ReferenceRecord) => [r.from, r.to, r.refKind]);
}

// ---------------------------------------------------------------- react

describe("react components", () => {
  test("an upper-case function returning JSX becomes a component node", () => {
    const out = signals("src/Button.tsx", "tsx", "export function Button() { return <button/>; }\n");
    // A component that calls no hook carries no `hooks` key at all, the same way it carries no
    // `props` key: an empty string is not a fact about the component.
    expect(out.decls.map((d) => [d.id, d.kind, d.meta])).toEqual([
      ["src/Button.tsx#component.Button", "component", { decl: "Button", signal: "react" }],
    ]);
  });

  test("a lower-case function returning JSX is not a component", () => {
    const out = signals("src/x.tsx", "tsx", "export function render() { return <div/>; }\n");
    expect(out.decls).toEqual([]);
  });

  test("an upper-case function with no JSX return is not a component", () => {
    const out = signals("src/x.tsx", "tsx", "export function Helper() { return 1; }\n");
    expect(out.decls).toEqual([]);
  });

  test("a React.memo wrapper makes a component of a value with no JSX of its own", () => {
    const out = signals("src/Card.tsx", "tsx", 'import * as React from "react";\nconst Card = React.memo(Inner);\n');
    expect(ids(out)).toEqual(["src/Card.tsx#component.Card"]);
  });

  test("a forwardRef wrapper counts too", () => {
    const out = signals("src/Input.tsx", "tsx", 'import { forwardRef } from "react";\nconst Input = forwardRef(Inner);\n');
    expect(ids(out)).toEqual(["src/Input.tsx#component.Input"]);
  });

  test("a class with a JSX return in a method is a component", () => {
    const out = signals("src/Old.tsx", "tsx", "export class Old { render() { return <div/>; } }\n");
    expect(ids(out)).toEqual(["src/Old.tsx#component.Old"]);
  });

  test("hooks are the sorted, comma-joined use* calls in the body", () => {
    const source =
      'import * as React from "react";\n' +
      "export function Panel() {\n" +
      "  const [a] = React.useState(1);\n" +
      "  useEffect(() => {});\n" +
      "  useEffect(() => {});\n" +
      "  return <div>{a}</div>;\n" +
      "}\n";
    expect(node(signals("src/Panel.tsx", "tsx", source), "src/Panel.tsx#component.Panel").meta?.["hooks"]).toBe(
      "useEffect,useState",
    );
  });

  test("meta.props names the props type when the signature has one", () => {
    const source = "interface Props { a: string }\nexport function Chip(props: Props) { return <b/>; }\n";
    expect(node(signals("src/Chip.tsx", "tsx", source), "src/Chip.tsx#component.Chip").meta?.["props"]).toBe("Props");
  });

  test("the language declaration is never replaced, only joined", () => {
    const record = extractFile(
      { path: "src/Button.tsx", lang: "tsx", source: "export function Button() { return <button/>; }\n", sha256: ZERO_SHA },
      parser,
    );
    expect(record.decls.map((d) => d.id)).toEqual(["src/Button.tsx#Button", "src/Button.tsx#component.Button"]);
  });

  test("a .ts file with no react import is never given the tree", () => {
    const source = "export function Button() { return 1; }\n";
    const out = signals("src/plain.ts", "ts", source);
    expect(out.decls).toEqual([]);
  });

  test("a component node carries meta.signal so its pass is always recoverable", () => {
    const out = signals("src/Button.tsx", "tsx", "export function Button() { return <button/>; }\n");
    expect(node(out, "src/Button.tsx#component.Button").meta?.["signal"]).toBe("react");
  });
});

// ------------------------------------------------------------- tanstack

describe("tanstack routes", () => {
  test("createFileRoute with a string literal gives a route node", () => {
    const source =
      'import { createFileRoute } from "@tanstack/react-start";\n' +
      'export const Route = createFileRoute("/posts/$id")({});\n';
    const out = signals("src/routes/posts.$id.tsx", "tsx", source);
    expect(out.decls.map((d) => [d.id, d.kind, d.meta])).toEqual([
      [
        "src/routes/posts.$id.tsx#route./posts/$id",
        "route",
        { file: "src/routes/posts.$id.tsx", framework: "tanstack-start", signal: "tanstack" },
      ],
    ]);
  });

  test("a computed route path emits nothing at all", () => {
    const source =
      'import { createFileRoute } from "@tanstack/react-router";\n' +
      "const path = `/posts/` + id;\n" +
      "export const Route = createFileRoute(path)({ loader: load });\n";
    expect(signals("src/routes/x.tsx", "tsx", source).decls).toEqual([]);
  });

  test("createRootRoute is the route /", () => {
    const source =
      'import { createRootRoute } from "@tanstack/react-router";\n' +
      "export const Route = createRootRoute({});\n";
    expect(ids(signals("src/routes/__root.tsx", "tsx", source))).toEqual(["src/routes/__root.tsx#route./"]);
  });

  test("createRootRouteWithContext is the same root route, typed", () => {
    const source =
      'import { createRootRouteWithContext } from "@tanstack/react-router";\n' +
      "export const Route = createRootRouteWithContext<Ctx>()({});\n";
    expect(ids(signals("src/routes/__root.tsx", "tsx", source))).toEqual(["src/routes/__root.tsx#route./"]);
  });

  test("a server file route records meta.server and one handler per method", () => {
    const source =
      'import { createServerFileRoute } from "@tanstack/react-start";\n' +
      'export const ServerRoute = createServerFileRoute("/api/hello")({ GET: read, POST: write });\n';
    const out = signals("src/routes/api/hello.ts", "ts", source);
    expect(ids(out)).toEqual([
      "src/routes/api/hello.ts#handler.GET",
      "src/routes/api/hello.ts#handler.POST",
      "src/routes/api/hello.ts#route./api/hello",
    ]);
    expect(node(out, "src/routes/api/hello.ts#route./api/hello").meta?.["server"]).toBe("1");
  });

  test("a file with neither creator is never given the tree", () => {
    expect(signals("src/routes/plain.ts", "ts", "export const x = 1;\n").decls).toEqual([]);
  });
});

describe("tanstack loaders", () => {
  test("loader and beforeLoad become handler nodes under the route", () => {
    const source =
      'import { createFileRoute } from "@tanstack/react-start";\n' +
      'export const Route = createFileRoute("/")({\n' +
      "  beforeLoad: guard,\n" +
      "  loader: load,\n" +
      "});\n";
    const out = signals("src/routes/index.tsx", "tsx", source);
    // Sorted by `compareDeclarations`: the route's span opens the call, so it leads.
    expect(ids(out)).toEqual([
      "src/routes/index.tsx#route./",
      "src/routes/index.tsx#handler.beforeLoad",
      "src/routes/index.tsx#handler.loader",
    ]);
    expect(node(out, "src/routes/index.tsx#handler.loader").meta?.["route"]).toBe("/");
  });

  test("component gives a route-handler reference, loader does not", () => {
    const source =
      'import { createFileRoute } from "@tanstack/react-start";\n' +
      'export const Route = createFileRoute("/")({ component: Home, loader: load });\n' +
      "function Home() { return <div/>; }\n";
    expect(refs(signals("src/routes/index.tsx", "tsx", source))).toEqual([["route./", "Home", "route-handler"]]);
  });

  test("a component written inline resolves to nothing rather than guessing", () => {
    const source =
      'import { createFileRoute } from "@tanstack/react-start";\n' +
      'export const Route = createFileRoute("/")({ component: () => <div/> });\n';
    expect(signals("src/routes/index.tsx", "tsx", source).refs).toEqual([]);
  });
});

// ----------------------------------------------------------------- next

describe("next app routes", () => {
  test.each([
    ["app/page.tsx", "/"],
    ["app/users/[id]/page.tsx", "/users/[id]"],
    ["app/(marketing)/about/page.tsx", "/about"],
    ["app/blog/[...slug]/page.tsx", "/blog/[...slug]"],
    ["app/@modal/login/page.tsx", "/login"],
    ["app/shop/[[...opt]]/page.tsx", "/shop/[[...opt]]"],
    ["examples/x/app/api/health/route.ts", "/api/health"],
    ["src/app/layout.tsx", "/"],
    ["app/(a)/(b)/page.tsx", "/"],
  ])("%s -> %s", (path, route) => {
    expect(nextRoutePath(path)).toBe(route);
  });

  test("a page becomes a route node with meta.kind page", () => {
    const out = signals("app/page.tsx", "tsx", "export default function Page() { return <main/>; }\n");
    expect(node(out, "app/page.tsx#route./").meta).toEqual({
      file: "app/page.tsx",
      framework: "next",
      kind: "page",
      signal: "next",
    });
  });

  test("a layout becomes a route node with meta.kind layout", () => {
    const out = signals("app/layout.tsx", "tsx", "export default function Layout() { return <html/>; }\n");
    expect(node(out, "app/layout.tsx#route./").meta?.["kind"]).toBe("layout");
  });

  test("a dynamic segment sets meta.dynamic and a slot goes into meta.slot", () => {
    const page = "export default function P() { return <div/>; }\n";
    expect(node(signals("app/users/[id]/page.tsx", "tsx", page), "app/users/[id]/page.tsx#route./users/[id]").meta?.["dynamic"]).toBe(
      "1",
    );
    expect(node(signals("app/@modal/login/page.tsx", "tsx", page), "app/@modal/login/page.tsx#route./login").meta?.["slot"]).toBe(
      "modal",
    );
  });

  test("an exported runtime string literal is recorded", () => {
    const source = 'export const runtime = "edge";\nexport default function P() { return <div/>; }\n';
    expect(node(signals("app/page.tsx", "tsx", source), "app/page.tsx#route./").meta?.["runtime"]).toBe("edge");
  });

  test("a page route links to its default-exported component", () => {
    const out = signals("app/page.tsx", "tsx", "export default function Page() { return <main/>; }\n");
    expect(refs(out)).toEqual([["route./", "Page", "route-handler"]]);
  });

  test("the Pages Router is out of scope", () => {
    // React still sees a component; what must not appear is a route.
    const out = signals("pages/about.tsx", "tsx", "export default function About() { return <div/>; }\n");
    expect(out.decls.filter((d) => d.kind === "route" || d.kind === "handler")).toEqual([]);
    expect(ids(out)).toEqual(["pages/about.tsx#component.About"]);
  });

  test("a component file under app/ is not a route", () => {
    const out = signals("app/avatar.tsx", "tsx", "export function Avatar() { return <img/>; }\n");
    expect(ids(out)).toEqual(["app/avatar.tsx#component.Avatar"]);
  });
});

describe("next handlers", () => {
  test("route.ts gives one handler node per exported HTTP method", () => {
    const source = "export async function GET() {}\nexport async function POST() {}\nexport function helper() {}\n";
    const out = signals("app/api/health/route.ts", "ts", source);
    // `compareDeclarations` is (file, span start, id): the route node spans the whole file,
    // so it ties with whatever starts on line 1 and the id breaks the tie.
    expect(ids(out)).toEqual([
      "app/api/health/route.ts#handler.GET",
      "app/api/health/route.ts#route./api/health",
      "app/api/health/route.ts#handler.POST",
    ]);
    expect(node(out, "app/api/health/route.ts#route./api/health").meta?.["kind"]).toBe("handler");
  });

  test("an unexported method function is not a handler", () => {
    const out = signals("app/api/x/route.ts", "ts", "async function GET() {}\nexport const dynamic = 1;\n");
    expect(ids(out)).toEqual(["app/api/x/route.ts#route./api/x"]);
  });

  test("a handler node carries its method and route", () => {
    const out = signals("app/api/health/route.ts", "ts", "export async function GET() {}\n");
    expect(node(out, "app/api/health/route.ts#handler.GET").meta).toEqual({
      framework: "next",
      method: "GET",
      route: "/api/health",
      signal: "next",
    });
  });
});

// --------------------------------------------------------------- pulumi

const AWS = 'import * as aws from "@pulumi/aws";\n';
const PULUMI = 'import * as pulumi from "@pulumi/pulumi";\n';

describe("pulumi resources", () => {
  test("a constructor from an @pulumi/ import is a resource with its type token", () => {
    const out = signals("infra/index.ts", "ts", `${AWS}const bucket = new aws.s3.Bucket("logs");\n`);
    expect(out.decls.map((d) => [d.id, d.kind, d.meta])).toEqual([
      [
        "infra/index.ts#resource.bucket",
        "resource",
        {
          provider: "aws",
          resourceName: "logs",
          signal: "pulumi-ts",
          type: "aws:s3/bucket:Bucket",
          typeSource: "import-path",
        },
      ],
    ]);
  });

  test("a local class named Bucket is not a Pulumi resource", () => {
    const out = signals("infra/fake.ts", "ts", `${PULUMI}class Bucket {}\nconst b = new Bucket();\n`);
    expect(out.decls).toEqual([]);
  });

  test("the class check runs even when applies is bypassed", () => {
    const out = runPass(pulumiTsPass, "infra/fake.ts", "ts", "class Bucket {}\nconst b = new Bucket();\n");
    expect(out.decls).toEqual([]);
  });

  test("a local class extending pulumi.ComponentResource is a resource", () => {
    const source = `${PULUMI}class Website extends pulumi.ComponentResource {}\nconst site = new Website("site");\n`;
    const out = signals("infra/site.ts", "ts", source);
    expect(ids(out)).toEqual(["infra/site.ts#resource.site"]);
    expect(node(out, "infra/site.ts#resource.site").meta?.["typeSource"]).toBe("heritage");
  });

  test("a named import of ComponentResource counts as heritage too", () => {
    const source =
      'import { ComponentResource } from "@pulumi/pulumi";\n' +
      "class Vpc extends ComponentResource {}\n" +
      'const vpc = new Vpc("v");\n';
    expect(ids(signals("infra/vpc.ts", "ts", source))).toEqual(["infra/vpc.ts#resource.vpc"]);
  });

  test("the core SDK's non-resource classes are not resources", () => {
    const source = `${PULUMI}const cfg = new pulumi.Config();\nconst file = new pulumi.asset.FileAsset("f");\n`;
    expect(signals("infra/cfg.ts", "ts", source).decls).toEqual([]);
  });

  test("pulumi.StackReference is a resource", () => {
    const out = signals("infra/ref.ts", "ts", `${PULUMI}const other = new pulumi.StackReference("dev");\n`);
    expect(ids(out)).toEqual(["infra/ref.ts#resource.other"]);
  });

  test("an unassigned resource is named by position, never with a #", () => {
    const source = `${AWS}new aws.s3.Bucket("a");\nnew aws.s3.Bucket("b");\n`;
    expect(ids(signals("infra/anon.ts", "ts", source))).toEqual(["infra/anon.ts#resource.~0", "infra/anon.ts#resource.~1"]);
  });

  test("a duplicate binding name is disambiguated with ~2", () => {
    const source = `${AWS}if (x) { const b = new aws.s3.Bucket("a"); } else { const b = new aws.s3.Bucket("c"); }\n`;
    expect(ids(signals("infra/dup.ts", "ts", source))).toEqual(["infra/dup.ts#resource.b", "infra/dup.ts#resource.b~2"]);
  });

  test("a file with no @pulumi/ text is never given the tree", () => {
    expect(signals("infra/plain.ts", "ts", 'const b = new aws.s3.Bucket("x");\n').decls).toEqual([]);
  });
});

describe("resource inputs", () => {
  test("reading another resource's output gives a resource-input reference", () => {
    const source =
      `${AWS}const bucket = new aws.s3.Bucket("logs");\n` +
      'const policy = new aws.s3.BucketPolicy("p", { bucket: bucket.id });\n';
    expect(refs(signals("infra/index.ts", "ts", source))).toEqual([
      ["resource.policy", "bucket.id", "resource-input"],
    ]);
  });

  test("an .apply on a resource output still names the resource", () => {
    const source =
      `${AWS}const bucket = new aws.s3.Bucket("logs");\n` +
      'const other = new aws.s3.Bucket("x", { tags: bucket.arn.apply((a) => ({ a })) });\n';
    expect(refs(signals("infra/apply.ts", "ts", source))).toEqual([["resource.other", "bucket.arn", "resource-input"]]);
  });

  test("a plain local variable is not a resource input", () => {
    const source = `${AWS}const cfg = { name: "x" };\nconst bucket = new aws.s3.Bucket("logs", { tags: cfg.name });\n`;
    expect(signals("infra/plain2.ts", "ts", source).refs).toEqual([]);
  });

  test("a resource never references itself", () => {
    const source = `${AWS}const bucket = new aws.s3.Bucket("logs", { tags: bucket.id });\n`;
    expect(signals("infra/self.ts", "ts", source).refs).toEqual([]);
  });
});

// ------------------------------------------------------- ordering and config

describe("pass ordering", () => {
  test("the registry is sorted by pass id", () => {
    expect(SIGNAL_PASSES.map((p) => p.id)).toEqual(["next", "pulumi-go", "pulumi-ts", "react", "tanstack"]);
  });

  test("concatenated declarations come back sorted with compareDeclarations", () => {
    const source =
      'import { createFileRoute } from "@tanstack/react-start";\n' +
      "function Home() { return <div/>; }\n" +
      'export const Route = createFileRoute("/")({ component: Home, loader: load });\n' +
      "function load() { return 1; }\n";
    const out = signals("app/routes/page.tsx", "tsx", source);
    const sorted = [...out.decls].sort(compareDeclarations);
    expect(out.decls.map((d) => d.id)).toEqual(sorted.map((d) => d.id));
    // Two passes contributed, so this is a real merge and not one pass's own order.
    expect(new Set(out.decls.map((d) => d.meta?.["signal"]))).toEqual(new Set(["next", "react", "tanstack"]));
  });

  test("references come back sorted by (from, to, refKind, line)", () => {
    const source =
      `${AWS}const a = new aws.s3.Bucket("a");\n` +
      'const b = new aws.s3.Bucket("b", { x: a.id, y: a.arn });\n' +
      'const c = new aws.s3.Bucket("c", { x: b.id });\n';
    const out = signals("infra/order.ts", "ts", source);
    const key = (r: ReferenceRecord): string => `${r.from} ${r.to} ${r.refKind} ${r.line}`;
    expect(out.refs.map(key)).toEqual([...out.refs].map(key).sort());
  });

  test("every signal node names the pass that made it", () => {
    const source =
      'import * as React from "react";\nexport function Card() { return <div/>; }\n';
    for (const decl of signals("src/Card.tsx", "tsx", source).decls) {
      expect(decl.meta?.["signal"]).toBe("react");
    }
  });
});

describe("signals disabled", () => {
  test("an empty pass list turns the layer off entirely", () => {
    const tree = parser.parse("export function Button() { return <button/>; }\n", "tsx");
    try {
      const base = extractTs("src/Button.tsx", "tsx", "export function Button() { return <button/>; }\n", tree);
      const out = runSignals(
        {
          path: "src/Button.tsx",
          lang: "tsx",
          source: "export function Button() { return <button/>; }\n",
          tree,
          base: { decls: base.decls, imports: base.imports, exports: base.exports, calls: base.calls },
        },
        [],
      );
      expect(out).toEqual({ decls: [], refs: [] });
    } finally {
      tree.delete();
    }
  });

  test("naming one pass runs only that pass", () => {
    const source =
      'import { createFileRoute } from "@tanstack/react-start";\n' +
      'export const Route = createFileRoute("/")({});\n' +
      "function Home() { return <div/>; }\n";
    const tree = parser.parse(source, "tsx");
    try {
      const base = extractTs("src/routes/index.tsx", "tsx", source, tree);
      const out = runSignals(
        {
          path: "src/routes/index.tsx",
          lang: "tsx",
          source,
          tree,
          base: { decls: base.decls, imports: base.imports, exports: base.exports, calls: base.calls },
        },
        ["react"],
      );
      expect(out.decls.map((d) => d.id)).toEqual(["src/routes/index.tsx#component.Home"]);
    } finally {
      tree.delete();
    }
  });
});

// ------------------------------------------------------------- the fixture

describe("tiny-signals-ts", () => {
  let snapshot: Snapshot;

  beforeAll(async () => {
    snapshot = await buildSnapshot({ root: FIXTURE, parser });
  });

  test("every fixture file is indexed", () => {
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "app/api/health/route.ts",
      "app/page.tsx",
      "app/users/[id]/page.tsx",
      "infra/fake.ts",
      "infra/index.ts",
      "src/Button.tsx",
      "src/Card.tsx",
      "src/notacomponent.ts",
      "src/routes/index.tsx",
      "src/routes/posts.$id.tsx",
    ]);
  });

  test("the signal nodes are exactly these", () => {
    const nodes = snapshot.symbols.filter((d) => d.meta?.["signal"] !== undefined).map((d) => d.id);
    expect(nodes).toEqual([
      "app/api/health/route.ts#handler.GET",
      "app/api/health/route.ts#route./api/health",
      "app/api/health/route.ts#handler.POST",
      "app/page.tsx#route./",
      "app/page.tsx#component.Page",
      "app/users/[id]/page.tsx#route./users/[id]",
      "app/users/[id]/page.tsx#component.User",
      "infra/index.ts#resource.bucket",
      "infra/index.ts#resource.policy",
      "src/Button.tsx#component.Button",
      "src/Card.tsx#component.Card",
      "src/routes/index.tsx#route./",
      "src/routes/index.tsx#handler.loader",
      "src/routes/index.tsx#component.Home",
      "src/routes/posts.$id.tsx#route./posts/$id",
      "src/routes/posts.$id.tsx#handler.loader",
    ]);
  });

  test("no signal node replaced a language declaration", () => {
    const button = snapshot.files.find((f) => f.path === "src/Button.tsx");
    expect(button?.decls.map((d) => d.id)).toEqual([
      "src/Button.tsx#Props",
      "src/Button.tsx#Button",
      "src/Button.tsx#component.Button",
    ]);
  });

  test("the reference edges are exactly these", () => {
    expect((snapshot.references ?? []).map((e) => [e.from, e.to, e.refKind, e.confidence])).toEqual([
      ["app/page.tsx#route./", "app/page.tsx#component.Page", "route-handler", "high"],
      ["app/users/[id]/page.tsx#route./users/[id]", "app/users/[id]/page.tsx#component.User", "route-handler", "high"],
      ["infra/index.ts#resource.policy", "infra/index.ts#resource.bucket", "resource-input", "high"],
      ["src/routes/index.tsx#route./", "src/routes/index.tsx#component.Home", "route-handler", "high"],
    ]);
  });

  test("the build is byte-identical when repeated", async () => {
    const again = await buildSnapshot({ root: FIXTURE, parser });
    expect(stableStringify(again.symbols)).toBe(stableStringify(snapshot.symbols));
    expect(stableStringify(again.references ?? [])).toBe(stableStringify(snapshot.references ?? []));
  });
});

// ------------------------------------------------- byte-identical twins

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

/** Build a snapshot over a throwaway repo written from `files` (repo-relative path -> text). */
async function snapshotOf(files: Readonly<Record<string, string>>): Promise<Snapshot> {
  const dir = mkdtempSync(join(tmpdir(), "greplost-signals-ts-"));
  temporaryDirs.push(dir);
  for (const [relative, text] of Object.entries(files)) {
    const file = join(dir, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return buildSnapshot({ root: dir, parser });
}

const TWIN_ROUTE =
  'import { createFileRoute } from "@tanstack/react-start";\n' +
  'export const Route = createFileRoute("/x")({});\n';

const TWIN_INFRA =
  'import * as aws from "@pulumi/aws";\n' +
  'export const bucket = new aws.s3.Bucket("logs");\n';

/**
 * `extractAll` keys extraction by `(lang, sha256)` and re-stamps the shared record onto the
 * second path, so a node id is rebuilt outside the pass that made it. `Declaration.id` is the
 * canonical form (driver ruling 2026-09-04) and re-derivation goes through `splitNodeId`;
 * `Declaration.name` is the bare node name, as the HCL nodes already are.
 */
describe("byte-identical files", () => {
  let snapshot: Snapshot;

  beforeAll(async () => {
    snapshot = await snapshotOf({
      "a/routes/x.tsx": TWIN_ROUTE,
      "b/routes/x.tsx": TWIN_ROUTE,
      "infra1/index.ts": TWIN_INFRA,
      "infra2/index.ts": TWIN_INFRA,
    });
  });

  test("both twins are indexed and share their bytes", () => {
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "a/routes/x.tsx",
      "b/routes/x.tsx",
      "infra1/index.ts",
      "infra2/index.ts",
    ]);
    expect(snapshot.files[0]?.sha256).toBe(snapshot.files[1]?.sha256 ?? "");
    expect(snapshot.files[2]?.sha256).toBe(snapshot.files[3]?.sha256 ?? "");
  });

  test("a re-stamped node keeps its kind in the id and its bare name", () => {
    const nodes = snapshot.symbols
      .filter((d) => d.meta?.["signal"] !== undefined)
      .map((d) => [d.id, d.name, d.kind]);
    expect(nodes).toEqual([
      ["a/routes/x.tsx#route./x", "/x", "route"],
      ["b/routes/x.tsx#route./x", "/x", "route"],
      ["infra1/index.ts#resource.bucket", "bucket", "resource"],
      ["infra2/index.ts#resource.bucket", "bucket", "resource"],
    ]);
  });

  test("every node id round-trips through splitNodeId", () => {
    for (const decl of snapshot.symbols) {
      if (decl.meta?.["signal"] === undefined) continue;
      const parts = splitNodeId(decl.id);
      expect(parts).not.toBeNull();
      expect(parts?.file).toBe(decl.file);
      expect(parts?.kind).toBe(decl.kind);
      expect(parts?.name).toBe(decl.name);
    }
  });

  test("a component node never shadows the function it names", async () => {
    const shadow = await snapshotOf({
      "src/Button.tsx":
        "export function Button() { return <button/>; }\n",
      "src/App.tsx":
        'import { Button } from "./Button.tsx";\n' +
        "export function App() { return <Button/>; }\n" +
        "export const used = Button();\n",
    });
    const button = shadow.files.find((f) => f.path === "src/Button.tsx");
    expect(button?.decls.map((d) => [d.id, d.name])).toEqual([
      ["src/Button.tsx#Button", "Button"],
      ["src/Button.tsx#component.Button", "Button"],
    ]);
    // The export index reports the function, not the node, and the call lands on the function.
    expect(button?.exports.map((e) => e.name)).toEqual(["Button"]);
    expect(shadow.manifest.files["src/Button.tsx"]?.exports).toEqual(["Button"]);
    expect(shadow.calls.map((c) => [c.from, c.to])).toEqual([
      ["src/App.tsx", "src/Button.tsx#Button"],
    ]);
  });
});
