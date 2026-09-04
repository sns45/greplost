/**
 * The TypeScript signal oracle (build 2, leaf 2.3; spec 2026-09-04 sections 3.7 and 3.8).
 *
 * `describe` names are fixed by the spec and by `gates/leaf-2.3.md`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NOTES, appRoutePath, generateExtra, generateTruth } from "../src/truth/signals-ts.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const FIXTURE = path.join(REPO_ROOT, "fixtures/tiny-signals-ts");
const ORACLE = path.join(REPO_ROOT, "bench/src/truth/signals-ts.ts");

const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** Every source file of the fixture, repo-relative, exactly as the harness would list them. */
function fixtureFiles(root: string = FIXTURE): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.name === "node_modules" || entry.name === "types" || entry.name === ".greplost") continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-signals-${label}-`));
  temporaries.push(dir);
  const root = path.join(dir, "repo");
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** A throwaway repo written from `files` (repo-relative path -> text); returns its root. */
function repoOf(label: string, files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-signals-${label}-`));
  temporaries.push(dir);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

/** `[from, to, refKind]` for every reference the oracle reports over `files`. */
function edgesOf(root: string, files: string[]): Array<[string, string, string]> {
  return generateExtra(root, files).references.map((e) => [e.from, e.to, e.refKind] as [string, string, string]);
}

describe("checker oracle", () => {
  test("the fixture's signal nodes are exactly these", () => {
    const extra = generateExtra(FIXTURE, fixtureFiles());
    expect(extra.nodes).toEqual([
      "app/api/health/route.ts#handler.GET",
      "app/api/health/route.ts#handler.POST",
      "app/api/health/route.ts#route./api/health",
      "app/page.tsx#component.Page",
      "app/page.tsx#route./",
      "app/users/[id]/page.tsx#component.User",
      "app/users/[id]/page.tsx#route./users/[id]",
      "infra/index.ts#resource.bucket",
      "infra/index.ts#resource.policy",
      "src/Button.tsx#component.Button",
      "src/Card.tsx#component.Card",
      "src/routes/index.tsx#component.Home",
      "src/routes/index.tsx#handler.loader",
      "src/routes/index.tsx#route./",
      "src/routes/posts.$id.tsx#handler.loader",
      "src/routes/posts.$id.tsx#route./posts/$id",
    ]);
  });

  test("the local class named Bucket is not a resource", () => {
    const nodes = generateExtra(FIXTURE, fixtureFiles()).nodes;
    expect(nodes.filter((id) => id.startsWith("infra/fake.ts"))).toEqual([]);
  });

  test("the base-type chain is what makes a Pulumi resource, and the fixture proves it", () => {
    // `infra/index.ts` resolves `aws.s3.Bucket` to a class declaration (the fixture ships the
    // `@pulumi/*` declarations through tsconfig `paths`), so the checker really does walk
    // `CustomResource` -> `Resource`. Without that chain there would be no resource here.
    const nodes = generateExtra(FIXTURE, ["infra/index.ts"]).nodes;
    expect(nodes).toEqual(["infra/index.ts#resource.bucket", "infra/index.ts#resource.policy"]);
  });

  test("the reference edges fold the resource inputs and the route handlers in", () => {
    const extra = generateExtra(FIXTURE, fixtureFiles());
    expect(extra.references.map((e) => [e.from, e.to, e.refKind])).toEqual([
      ["app/page.tsx#route./", "app/page.tsx#component.Page", "route-handler"],
      ["app/users/[id]/page.tsx#route./users/[id]", "app/users/[id]/page.tsx#component.User", "route-handler"],
      ["infra/index.ts#resource.policy", "infra/index.ts#resource.bucket", "resource-input"],
      ["src/routes/index.tsx#route./", "src/routes/index.tsx#component.Home", "route-handler"],
    ]);
  });

  test("the App Router path rules", () => {
    expect(appRoutePath("app/page.tsx")).toBe("/");
    expect(appRoutePath("app/users/[id]/page.tsx")).toBe("/users/[id]");
    expect(appRoutePath("app/(marketing)/about/page.tsx")).toBe("/about");
    expect(appRoutePath("app/blog/[...slug]/page.tsx")).toBe("/blog/[...slug]");
    expect(appRoutePath("app/@modal/login/page.tsx")).toBe("/login");
    expect(appRoutePath("src/components/x.tsx")).toBeUndefined();
  });

  test("notes name the three mechanisms, and S1 to S4 are declared unsupported", () => {
    expect(NOTES).toEqual(["tsc-checker-oracle", "base-type-chain-for-pulumi", "app-router-path-rules"]);
    const truth = generateTruth(FIXTURE, fixtureFiles());
    expect(truth.notes).toEqual([
      "tsc-checker-oracle",
      "base-type-chain-for-pulumi",
      "app-router-path-rules",
      "unsupported:S1",
      "unsupported:S2",
      "unsupported:S3",
      "unsupported:S4",
    ]);
    expect(truth.files.length).toBe(fixtureFiles().length);
  });

  test("it throws rather than returning an empty truth for files it could not load", () => {
    expect(() => generateExtra(FIXTURE, ["does/not/exist.ts"])).toThrow(/loaded none of 1 file/);
  });

  test("an empty file list is not an error", () => {
    expect(generateExtra(FIXTURE, [])).toEqual({ nodes: [], references: [] });
  });

  // Spec 3.4 lets a `route-handler` land on the referenced component node *or* on the
  // declaration, and `references/ts.ts` follows exactly one import to reach either. An oracle
  // that always names a same-file component node scores a rule greplost never implemented.

  test("a route-handler follows one import to the component node in the imported file", () => {
    const root = repoOf("import-hop", {
      "src/Home.tsx": "export function Home() {\n  return <div/>;\n}\n",
      "src/routes/index.tsx":
        'import { createFileRoute } from "@tanstack/react-router";\n' +
        'import { Home } from "../Home.tsx";\n' +
        'export const Route = createFileRoute("/")({ component: Home });\n',
    });
    expect(edgesOf(root, ["src/Home.tsx", "src/routes/index.tsx"])).toEqual([
      ["src/routes/index.tsx#route./", "src/Home.tsx#component.Home", "route-handler"],
    ]);
  });

  test("a route-handler falls back to the declaration when no component node names it", () => {
    const root = repoOf("decl-fallback", {
      "src/routes/index.tsx":
        'import { createFileRoute } from "@tanstack/react-router";\n' +
        'import { wrap } from "../wrap.ts";\n' +
        "const Home = wrap(1);\n" +
        'export const Route = createFileRoute("/")({ component: Home });\n',
      "src/wrap.ts": "export function wrap(n: number): number {\n  return n;\n}\n",
    });
    expect(edgesOf(root, ["src/routes/index.tsx", "src/wrap.ts"])).toEqual([
      ["src/routes/index.tsx#route./", "src/routes/index.tsx#Home", "route-handler"],
    ]);
  });

  test("a route-handler naming nothing the program declares is dropped, never guessed", () => {
    const root = repoOf("unresolved", {
      "src/routes/index.tsx":
        'import { createFileRoute } from "@tanstack/react-router";\n' +
        'export const Route = createFileRoute("/")({ component: Missing });\n',
    });
    expect(edgesOf(root, ["src/routes/index.tsx"])).toEqual([]);
  });

  test("an App Router page whose default export is imported resolves through that import", () => {
    const root = repoOf("next-import", {
      "app/page.tsx": 'import Home from "../src/Home.tsx";\nexport default Home;\n',
      "src/Home.tsx": "export default function Home() {\n  return <main/>;\n}\n",
    });
    expect(edgesOf(root, ["app/page.tsx", "src/Home.tsx"])).toEqual([
      ["app/page.tsx#route./", "src/Home.tsx#component.Home", "route-handler"],
    ]);
  });

  test("a target file outside the scored set is not a reference", () => {
    const root = repoOf("outside", {
      "src/Home.tsx": "export function Home() {\n  return <div/>;\n}\n",
      "src/routes/index.tsx":
        'import { createFileRoute } from "@tanstack/react-router";\n' +
        'import { Home } from "../Home.tsx";\n' +
        'export const Route = createFileRoute("/")({ component: Home });\n',
    });
    expect(edgesOf(root, ["src/routes/index.tsx"])).toEqual([]);
  });
});

describe("oracle independence", () => {
  test("the oracle imports nothing from packages/core/src/signals", () => {
    const source = readFileSync(ORACLE, "utf8");
    const imports = [...source.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gmu)].map((match) => match[1] as string);
    expect(imports.filter((specifier) => specifier.includes("signals"))).toEqual([]);
    expect(imports.filter((specifier) => specifier.includes("packages/core"))).toEqual([]);
    // The only `@greplost/core` entry point it may use is the shared schema vocabulary, which
    // is types plus `compareStrings`; it must never reach into core's implementation.
    expect(imports.filter((specifier) => specifier.startsWith("@greplost/"))).toEqual(["@greplost/core/schema"]);
    expect(source).not.toContain("web-tree-sitter");
  });

  test("its output tracks the fixture: a new component appears", () => {
    const root = copyFixture("added");
    const before = generateExtra(root, fixtureFiles(root)).nodes;
    writeFileSync(path.join(root, "src/Badge.tsx"), "export function Badge() {\n  return <span />;\n}\n");
    const after = generateExtra(root, fixtureFiles(root)).nodes;
    expect(before).not.toContain("src/Badge.tsx#component.Badge");
    expect(after).toContain("src/Badge.tsx#component.Badge");
  });

  test("its output tracks the fixture: a removed resource disappears", () => {
    const root = copyFixture("removed");
    expect(generateExtra(root, fixtureFiles(root)).nodes).toContain("infra/index.ts#resource.policy");
    writeFileSync(
      path.join(root, "infra/index.ts"),
      'import * as aws from "@pulumi/aws";\n\nexport const bucket = new aws.s3.Bucket("logs");\n',
    );
    const after = generateExtra(root, fixtureFiles(root)).nodes;
    expect(after).toContain("infra/index.ts#resource.bucket");
    expect(after).not.toContain("infra/index.ts#resource.policy");
  });

  test("renaming a route changes the node it reports", () => {
    const root = copyFixture("renamed");
    writeFileSync(
      path.join(root, "src/routes/posts.$id.tsx"),
      'import { createFileRoute } from "@tanstack/react-start";\n\n' +
        'export const Route = createFileRoute("/articles/$id")({\n  loader: fetchPost,\n});\n\n' +
        "async function fetchPost() {\n  return { id: \"1\" };\n}\n",
    );
    const nodes = generateExtra(root, fixtureFiles(root)).nodes;
    expect(nodes).toContain("src/routes/posts.$id.tsx#route./articles/$id");
    expect(nodes).not.toContain("src/routes/posts.$id.tsx#route./posts/$id");
  });
});
