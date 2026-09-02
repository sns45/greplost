import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createResolver, detectPackages, loadTsconfigPaths, packageOf } from "../src/resolve/index.ts";
import type { RepoContext, ResolvedTarget } from "../src/resolve/index.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";
import type { GreplostConfig, Lang, PackageInfo } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const ROOT_PKG: PackageInfo = { name: "repo", path: ".", source: "root" };

/** In-memory repo: `sources` maps repo-relative paths to content. */
function ctxOf(
  sources: Record<string, string>,
  opts: { indexed?: string[]; packages?: PackageInfo[] } = {},
): RepoContext {
  const indexed = opts.indexed ?? Object.keys(sources).filter((p) => CODE_EXT.test(p));
  return {
    root: "/repo",
    files: new Set(indexed),
    packages: opts.packages ?? [ROOT_PKG],
    readFile: (rel: string) => sources[rel] ?? null,
  };
}

function file(p: string): ResolvedTarget {
  return { type: "file", path: p };
}

function external(pkg: string): ResolvedTarget {
  return { type: "external", pkg };
}

const UNRESOLVED: ResolvedTarget = { type: "unresolved" };

/** Empty file bodies: the resolver only ever looks at the file *set*. */
function sources(...paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) out[p] = "";
  return out;
}

const temps: string[] = [];

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "greplost-resolve-"));
  temps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function configWith(roots: string[]): GreplostConfig {
  return { ...DEFAULT_CONFIG, packages: { roots } };
}

// ---------------------------------------------------------------------------

describe("relative", () => {
  const indexed = [
    "src/a.ts",
    "src/b.ts",
    "src/b.js",
    "src/index.ts",
    "src/widget.tsx",
    "src/esm.mts",
    "src/cjs.cts",
    "src/both.ts",
    "src/both.tsx",
    "src/sub/index.ts",
    "src/deep/nested/index.tsx",
    "lib/x.ts",
    "index.ts",
  ];
  const ctx = ctxOf(
    { ...sources(...indexed), "src/secret.ts": "// on disk but not indexed" },
    { indexed },
  );
  const resolver = createResolver(ctx);
  const from = "src/a.ts";
  const r = (spec: string, lang: Lang = "ts") => resolver.resolve(from, spec, lang);

  test("exact relative path", () => {
    expect(r("./b.ts")).toEqual(file("src/b.ts"));
  });

  test("extensionless specifier probes .ts first", () => {
    expect(r("./both")).toEqual(file("src/both.ts"));
  });

  test(".js specifier maps to .ts", () => {
    expect(r("./esm.mjs")).toEqual(file("src/esm.mts"));
    expect(r("./cjs.cjs")).toEqual(file("src/cjs.cts"));
  });

  test(".js specifier falls through to .tsx when no .ts exists", () => {
    expect(r("./widget.js")).toEqual(file("src/widget.tsx"));
  });

  test("an indexed .js file wins over the .ts rewrite", () => {
    expect(r("./b.js")).toEqual(file("src/b.js"));
  });

  test("directory specifier resolves to its index file", () => {
    expect(r("./sub")).toEqual(file("src/sub/index.ts"));
    expect(r("./sub/")).toEqual(file("src/sub/index.ts"));
    expect(r("./deep/nested")).toEqual(file("src/deep/nested/index.tsx"));
  });

  test("dot specifier resolves to the current directory index", () => {
    expect(resolver.resolve("src/sub/thing.ts", ".", "ts")).toEqual(file("src/sub/index.ts"));
    expect(resolver.resolve("src/sub/thing.ts", "..", "ts")).toEqual(file("src/index.ts"));
  });

  test("parent-relative specifier", () => {
    expect(r("../lib/x")).toEqual(file("lib/x.ts"));
    expect(r("../index")).toEqual(file("index.ts"));
  });

  test("a file at the repo root resolves its own siblings", () => {
    expect(resolver.resolve("index.ts", "./lib/x", "ts")).toEqual(file("lib/x.ts"));
    expect(resolver.resolve("index.ts", "./src/b.ts", "ts")).toEqual(file("src/b.ts"));
    expect(resolver.resolve("index.ts", "../outside", "ts")).toEqual(UNRESOLVED);
  });

  test("root-absolute specifier resolves from the repo root", () => {
    expect(r("/src/b.ts")).toEqual(file("src/b.ts"));
    expect(r("/lib/x")).toEqual(file("lib/x.ts"));
  });

  test("a file that exists on disk but is not indexed is unresolved", () => {
    expect(ctx.readFile("src/secret.ts")).not.toBeNull();
    expect(r("./secret")).toEqual(UNRESOLVED);
  });

  test("a missing relative specifier is unresolved", () => {
    expect(r("./nope")).toEqual(UNRESOLVED);
    expect(r("./sub/nope.js")).toEqual(UNRESOLVED);
  });

  test("a specifier escaping the repo root is unresolved", () => {
    expect(r("../../../etc/passwd")).toEqual(UNRESOLVED);
  });
});

describe("tsconfig paths", () => {
  test("baseUrl plus wildcard key", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/app/util.ts"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(file("src/app/util.ts"));
  });

  test("exact (non-wildcard) key", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/lib/index.ts"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { lib: ["src/lib/index.ts"] } },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "lib", "ts")).toEqual(file("src/lib/index.ts"));
  });

  test("longest-prefix key wins", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/wrong/b/c.ts", "src/right/c.ts"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@a/*": ["src/wrong/*"], "@a/b/*": ["src/right/*"] },
        },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@a/b/c", "ts")).toEqual(file("src/right/c.ts"));
  });

  test("mappings are tried in order, first indexed hit wins", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/second/thing.ts"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@x/*": ["src/first/*", "src/second/*"] },
        },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@x/thing", "ts")).toEqual(file("src/second/thing.ts"));
  });

  test("comments and trailing commas are tolerated", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/app/util.ts"),
      "tsconfig.json": `{
        // a line comment with a "quote
        "compilerOptions": {
          /* a block comment */
          "baseUrl": ".",
          "paths": { "@app/*": ["src/app/*"], },
        },
      }`,
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(file("src/app/util.ts"));
  });

  test("extends chain: base supplies paths, derived supplies baseUrl", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/app/util.ts"),
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { paths: { "@app/*": ["src/app/*"] } } }),
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { baseUrl: "." },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(file("src/app/util.ts"));
  });

  test("derived paths replace the base paths", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/new/util.ts", "src/old/util.ts"),
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/old/*"] } },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { paths: { "@app/*": ["src/new/*"] } },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(file("src/new/util.ts"));
  });

  test("paths without baseUrl resolve relative to the declaring tsconfig", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "config/src/util.ts"),
      "config/base.json": JSON.stringify({ compilerOptions: { paths: { "@app/*": ["./src/*"] } } }),
      "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(file("config/src/util.ts"));
  });

  test("extends a package tsconfig under node_modules", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/app/util.ts"),
      "node_modules/@tsconfig/node20/tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } },
      }),
      "tsconfig.json": JSON.stringify({ extends: "@tsconfig/node20/tsconfig.json" }),
    });
    // baseUrl "." of the package config points at node_modules/@tsconfig/node20, which
    // holds nothing indexed, so the mapping misses and the specifier stays external.
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(external("@app/util"));
    const tp = loadTsconfigPaths("/repo", "src/x.ts", ctx.readFile);
    expect(tp).toEqual({
      baseUrl: "node_modules/@tsconfig/node20",
      paths: { "@app/*": ["src/app/*"] },
    });
  });

  test("an unreadable package extends is ignored", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/app/util.ts"),
      "tsconfig.json": JSON.stringify({
        extends: "@tsconfig/node20/tsconfig.json",
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(file("src/app/util.ts"));
  });

  test("the nearest tsconfig upward wins", () => {
    const ctx = ctxOf({
      ...sources("packages/a/src/x.ts", "packages/a/src/inner/util.ts", "shared/util.ts"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@u/*": ["shared/*"] } },
      }),
      "packages/a/tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@u/*": ["src/inner/*"] } },
      }),
    });
    expect(createResolver(ctx).resolve("packages/a/src/x.ts", "@u/util", "ts")).toEqual(
      file("packages/a/src/inner/util.ts"),
    );
  });

  test("a mapped target may use a .js extension for a .ts file", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/app/util.ts"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/util": ["src/app/util.js"] } },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(file("src/app/util.ts"));
  });

  test("a mapped target may be a directory with an index", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/app/index.ts"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app": ["src/app"] } },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app", "ts")).toEqual(file("src/app/index.ts"));
  });

  test("an unmatched specifier falls through to the external rule", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@other/thing", "ts")).toEqual(external("@other/thing"));
  });

  test("baseUrl alone resolves a bare specifier the way tsc does", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/shared/util.ts"),
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "shared/util", "ts")).toEqual(file("src/shared/util.ts"));
    expect(createResolver(ctx).resolve("src/x.ts", "shared/missing", "ts")).toEqual(external("shared"));
  });

  test("${configDir} in an extended base resolves against the loaded config", () => {
    const ctx = ctxOf({
      ...sources("packages/a/src/x.ts", "packages/a/src/util.ts", "src/util.ts"),
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { paths: { "@self/*": ["${configDir}/src/*"] } },
      }),
      "packages/a/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
    });
    expect(createResolver(ctx).resolve("packages/a/src/x.ts", "@self/util", "ts")).toEqual(
      file("packages/a/src/util.ts"),
    );
  });

  test("a byte order mark does not break the tsconfig", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/app/util.ts"),
      "tsconfig.json":
        "\uFEFF" +
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } } }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(file("src/app/util.ts"));
  });

  test("loadTsconfigPaths returns null without a tsconfig", () => {
    const ctx = ctxOf(sources("src/x.ts"));
    expect(loadTsconfigPaths("/repo", "src/x.ts", ctx.readFile)).toBeNull();
  });

  test("an extends cycle terminates", () => {
    const ctx = ctxOf({
      ...sources("src/x.ts", "src/app/util.ts"),
      "a.json": JSON.stringify({ extends: "./tsconfig.json" }),
      "tsconfig.json": JSON.stringify({
        extends: "./a.json",
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/app/*"] } },
      }),
    });
    expect(createResolver(ctx).resolve("src/x.ts", "@app/util", "ts")).toEqual(file("src/app/util.ts"));
  });
});

describe("workspace package", () => {
  const pkgs = (...entries: Array<[string, string]>): PackageInfo[] => [
    ROOT_PKG,
    ...entries.map(([name, p]): PackageInfo => ({ name, path: p, source: "package.json" })),
  ];

  test("exports string map at the package root", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts"),
        "packages/core/package.json": JSON.stringify({ name: "@w/core", exports: { ".": "./src/index.ts" } }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core", "ts")).toEqual(
      file("packages/core/src/index.ts"),
    );
  });

  test("exports conditions are tried in order (source beats import)", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts", "packages/core/dist/index.js"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          exports: { ".": { import: "./dist/index.js", source: "./src/index.ts" } },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core", "ts")).toEqual(
      file("packages/core/src/index.ts"),
    );
  });

  test("nested condition objects are followed", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          exports: { ".": { import: { types: "./dist/index.d.ts", default: "./src/index.ts" } } },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core", "ts")).toEqual(
      file("packages/core/src/index.ts"),
    );
  });

  test("conditions sugar without subpath keys", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          exports: { import: "./src/index.ts", require: "./dist/index.cjs" },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core", "ts")).toEqual(
      file("packages/core/src/index.ts"),
    );
  });

  test("exports arrays are tried in order", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          exports: { ".": ["./missing.js", "./src/index.ts"] },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core", "ts")).toEqual(
      file("packages/core/src/index.ts"),
    );
  });

  test("explicit exports subpath", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/util.ts"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          exports: { ".": "./src/index.ts", "./utils": "./src/util.ts" },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core/utils", "ts")).toEqual(
      file("packages/core/src/util.ts"),
    );
  });

  test("exports pattern keys, longest prefix first", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/foo.ts", "packages/core/lib/x.ts"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          exports: { "./*": "./src/*.ts", "./deep/*": "./lib/*.ts" },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    const resolver = createResolver(ctx);
    expect(resolver.resolve("app/main.ts", "@w/core/foo", "ts")).toEqual(file("packages/core/src/foo.ts"));
    expect(resolver.resolve("app/main.ts", "@w/core/deep/x", "ts")).toEqual(file("packages/core/lib/x.ts"));
  });

  test("a .js exports target resolves to the .ts source", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          exports: { ".": "./src/index.js" },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core", "ts")).toEqual(
      file("packages/core/src/index.ts"),
    );
  });

  test("module and main fields", () => {
    const withModule = ctxOf(
      {
        ...sources("app/main.ts", "packages/a/src/mod.ts"),
        "packages/a/package.json": JSON.stringify({ name: "a", module: "./src/mod.ts", main: "./nope.js" }),
      },
      { packages: pkgs(["a", "packages/a"]) },
    );
    expect(createResolver(withModule).resolve("app/main.ts", "a", "ts")).toEqual(file("packages/a/src/mod.ts"));

    const withMain = ctxOf(
      {
        ...sources("app/main.ts", "packages/b/lib/entry.ts"),
        "packages/b/package.json": JSON.stringify({ name: "b", main: "lib/entry.ts" }),
      },
      { packages: pkgs(["b", "packages/b"]) },
    );
    expect(createResolver(withMain).resolve("app/main.ts", "b", "ts")).toEqual(file("packages/b/lib/entry.ts"));
  });

  test("a main pointing at an unbuilt dist falls back to src/index", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts"),
        "packages/core/package.json": JSON.stringify({ name: "@w/core", main: "dist/index.js" }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core", "ts")).toEqual(
      file("packages/core/src/index.ts"),
    );
  });

  test("a package.json with no entry fields falls back to index", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/plain/index.ts"),
        "packages/plain/package.json": JSON.stringify({ name: "plain" }),
      },
      { packages: pkgs(["plain", "packages/plain"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "plain", "ts")).toEqual(file("packages/plain/index.ts"));
  });

  test("a subpath without exports probes the package directory and its src", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/util.ts", "packages/core/lib/deep/thing.ts"),
        "packages/core/package.json": JSON.stringify({ name: "@w/core" }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    const resolver = createResolver(ctx);
    expect(resolver.resolve("app/main.ts", "@w/core/lib/deep/thing", "ts")).toEqual(
      file("packages/core/lib/deep/thing.ts"),
    );
    expect(resolver.resolve("app/main.ts", "@w/core/util", "ts")).toEqual(file("packages/core/src/util.ts"));
  });

  test("an exports pattern pointing at an unbuilt dist falls back to the sources", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts", "packages/core/src/util.ts"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          exports: { ".": "./dist/index.js", "./*": "./dist/*.js" },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    const resolver = createResolver(ctx);
    expect(resolver.resolve("app/main.ts", "@w/core", "ts")).toEqual(file("packages/core/src/index.ts"));
    expect(resolver.resolve("app/main.ts", "@w/core/util", "ts")).toEqual(file("packages/core/src/util.ts"));
  });

  test("an unscoped workspace package name", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts"),
        "packages/core/package.json": JSON.stringify({ name: "core", exports: { ".": "./src/index.ts" } }),
      },
      { packages: pkgs(["core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "core", "ts")).toEqual(file("packages/core/src/index.ts"));
  });

  test("a workspace package with nothing indexed is unresolved, not external", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts"),
        "packages/core/package.json": JSON.stringify({ name: "@w/core", exports: { ".": "./src/index.ts" } }),
        "packages/core/src/index.ts": "// excluded by config",
      },
      { indexed: ["app/main.ts"], packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core", "ts")).toEqual(UNRESOLVED);
  });

  test("a blocked (null) exports subpath does not resolve", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          exports: { ".": "./src/index.ts", "./blocked": null },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core/blocked", "ts")).toEqual(UNRESOLVED);
  });

  test("a package-internal '#' import resolves through the imports map", () => {
    const ctx = ctxOf(
      {
        ...sources("packages/core/src/a.ts", "packages/core/src/internal/thing.ts"),
        "packages/core/package.json": JSON.stringify({
          name: "@w/core",
          imports: { "#internal/*": "./src/internal/*.ts", "#dep": "lodash" },
        }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    const resolver = createResolver(ctx);
    expect(resolver.resolve("packages/core/src/a.ts", "#internal/thing", "ts")).toEqual(
      file("packages/core/src/internal/thing.ts"),
    );
    expect(resolver.resolve("packages/core/src/a.ts", "#dep", "ts")).toEqual(external("lodash"));
  });

  test("a '#' import with no imports map is unresolved, never external", () => {
    const ctx = ctxOf(
      {
        ...sources("packages/core/src/a.ts"),
        "packages/core/package.json": JSON.stringify({ name: "@w/core" }),
      },
      { packages: pkgs(["@w/core", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("packages/core/src/a.ts", "#missing", "ts")).toEqual(UNRESOLVED);
  });

  test("a renamed duplicate package name is not matched by a specifier", () => {
    const ctx = ctxOf(
      {
        ...sources("app/main.ts", "packages/core/src/index.ts"),
        "packages/core/package.json": JSON.stringify({ name: "@w/core", exports: { ".": "./src/index.ts" } }),
      },
      { packages: pkgs(["@w/core (packages/core)", "packages/core"]) },
    );
    expect(createResolver(ctx).resolve("app/main.ts", "@w/core", "ts")).toEqual(external("@w/core"));
  });
});

describe("external", () => {
  const ctx = ctxOf(
    {
      ...sources("src/a.ts", "packages/core/src/index.ts"),
      "packages/core/package.json": JSON.stringify({ name: "@w/core", exports: { ".": "./src/index.ts" } }),
    },
    {
      packages: [ROOT_PKG, { name: "@w/core", path: "packages/core", source: "package.json" }],
    },
  );
  const resolver = createResolver(ctx);
  const r = (spec: string) => resolver.resolve("src/a.ts", spec, "ts");

  test("a plain bare specifier", () => {
    expect(r("lodash")).toEqual(external("lodash"));
  });

  test("a scoped name", () => {
    expect(r("@aws-sdk/client-sqs")).toEqual(external("@aws-sdk/client-sqs"));
  });

  test("a subpath keeps the package name", () => {
    expect(r("@aws-sdk/client-sqs/dist/commands/SendMessageCommand")).toEqual(
      external("@aws-sdk/client-sqs"),
    );
    expect(r("lodash/fp")).toEqual(external("lodash"));
  });

  test("node: prefixed builtins keep the whole specifier", () => {
    expect(r("node:fs")).toEqual(external("node:fs"));
    expect(r("node:fs/promises")).toEqual(external("node:fs/promises"));
    expect(r("node:test")).toEqual(external("node:test"));
  });

  test("unprefixed builtins", () => {
    expect(r("fs")).toEqual(external("fs"));
    expect(r("path")).toEqual(external("path"));
    expect(r("fs/promises")).toEqual(external("fs/promises"));
  });

  test("a scope-only specifier", () => {
    expect(r("@scope")).toEqual(external("@scope"));
  });

  test("a name sharing a prefix with a workspace package is still external", () => {
    expect(r("@w/core-extras")).toEqual(external("@w/core-extras"));
    expect(r("@w/other")).toEqual(external("@w/other"));
  });

  test("an empty specifier is unresolved", () => {
    expect(r("")).toEqual(UNRESOLVED);
  });
});

describe("detectPackages", () => {
  test("the root package always exists, named from its package.json", () => {
    const root = tempRepo({ "package.json": JSON.stringify({ name: "the-root" }), "a.ts": "" });
    expect(detectPackages(root, ["a.ts"], configWith([]))).toEqual([
      { name: "the-root", path: ".", source: "root" },
    ]);
  });

  test("the root package falls back to go.mod then the directory basename", () => {
    const goRoot = tempRepo({ "go.mod": "module example.com/tiny\n\ngo 1.22\n", "main.go": "" });
    expect(detectPackages(goRoot, ["main.go"], configWith([]))[0]).toEqual({
      name: "tiny",
      path: ".",
      source: "root",
    });

    const bare = tempRepo({ "a.ts": "" });
    expect(detectPackages(bare, ["a.ts"], configWith([]))[0]).toEqual({
      name: path.basename(bare),
      path: ".",
      source: "root",
    });
  });

  test("config roots detect package.json directories", () => {
    const root = tempRepo({
      "package.json": JSON.stringify({ name: "root" }),
      "packages/a/package.json": JSON.stringify({ name: "@w/a" }),
      "packages/a/src/a.ts": "",
      "apps/site/package.json": JSON.stringify({ name: "site" }),
      "apps/site/src/main.ts": "",
    });
    const files = ["apps/site/src/main.ts", "packages/a/src/a.ts"];
    expect(detectPackages(root, files, configWith(["packages/*", "apps/*"]))).toEqual([
      { name: "root", path: ".", source: "root" },
      { name: "site", path: "apps/site", source: "package.json" },
      { name: "@w/a", path: "packages/a", source: "package.json" },
    ]);
  });

  test("package.json workspaces, array and object forms", () => {
    const arrayForm = tempRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["libs/*"] }),
      "libs/one/package.json": JSON.stringify({ name: "one" }),
      "libs/one/index.ts": "",
    });
    expect(detectPackages(arrayForm, ["libs/one/index.ts"], configWith([]))).toEqual([
      { name: "root", path: ".", source: "root" },
      { name: "one", path: "libs/one", source: "package.json" },
    ]);

    const objectForm = tempRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: { packages: ["libs/*"] } }),
      "libs/two/package.json": JSON.stringify({ name: "two" }),
      "libs/two/index.ts": "",
    });
    expect(detectPackages(objectForm, ["libs/two/index.ts"], configWith([]))).toEqual([
      { name: "root", path: ".", source: "root" },
      { name: "two", path: "libs/two", source: "package.json" },
    ]);
  });

  test("pnpm-workspace.yaml packages", () => {
    const root = tempRepo({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": 'packages:\n  - "libs/*"\n  - apps/**\n\nother: 1\n',
      "libs/one/package.json": JSON.stringify({ name: "one" }),
      "libs/one/index.ts": "",
      "apps/deep/web/package.json": JSON.stringify({ name: "web" }),
      "apps/deep/web/index.ts": "",
      "elsewhere/pkg/package.json": JSON.stringify({ name: "nope" }),
      "elsewhere/pkg/index.ts": "",
    });
    const files = ["apps/deep/web/index.ts", "elsewhere/pkg/index.ts", "libs/one/index.ts"];
    expect(detectPackages(root, files, configWith([]))).toEqual([
      { name: "root", path: ".", source: "root" },
      { name: "web", path: "apps/deep/web", source: "package.json" },
      { name: "one", path: "libs/one", source: "package.json" },
    ]);
  });

  test("go.work use entries and go.mod modules", () => {
    const root = tempRepo({
      "go.work": "go 1.22\n\nuse (\n\t./svc/a\n\t./svc/b\n)\n",
      "svc/a/go.mod": "module example.com/svc/alpha\n",
      "svc/a/main.go": "",
      "svc/b/go.mod": "module example.com/svc/beta\n",
      "svc/b/main.go": "",
    });
    expect(detectPackages(root, ["svc/a/main.go", "svc/b/main.go"], configWith([]))).toEqual([
      { name: path.basename(root), path: ".", source: "root" },
      { name: "alpha", path: "svc/a", source: "go.mod" },
      { name: "beta", path: "svc/b", source: "go.mod" },
    ]);
  });

  test("a single-line go.work use entry", () => {
    const root = tempRepo({
      "go.work": "go 1.22\nuse ./svc/a\n",
      "svc/a/go.mod": "module example.com/alpha\n",
      "svc/a/main.go": "",
    });
    expect(detectPackages(root, ["svc/a/main.go"], configWith([])).map((p) => p.path)).toEqual([".", "svc/a"]);
  });

  test("a directory without a manifest is not a package", () => {
    const root = tempRepo({
      "package.json": JSON.stringify({ name: "root" }),
      "packages/plain/src/x.ts": "",
    });
    expect(detectPackages(root, ["packages/plain/src/x.ts"], configWith(["packages/*"]))).toEqual([
      { name: "root", path: ".", source: "root" },
    ]);
  });

  test("a manifest outside every glob is not a package", () => {
    const root = tempRepo({
      "package.json": JSON.stringify({ name: "root" }),
      "tools/gen/package.json": JSON.stringify({ name: "gen" }),
      "tools/gen/index.ts": "",
    });
    expect(detectPackages(root, ["tools/gen/index.ts"], configWith(["packages/*"]))).toEqual([
      { name: "root", path: ".", source: "root" },
    ]);
  });

  test("a package with no indexed files is still detected from its manifest", () => {
    const root = tempRepo({
      "package.json": JSON.stringify({ name: "root" }),
      "packages/quiet/package.json": JSON.stringify({ name: "quiet" }),
      "packages/quiet/src/x.test.ts": "",
      "packages/loud/package.json": JSON.stringify({ name: "loud" }),
      "packages/loud/src/x.ts": "",
    });
    expect(detectPackages(root, ["packages/loud/src/x.ts"], configWith(["packages/*"])).map((p) => p.name)).toEqual(
      ["root", "loud", "quiet"],
    );
  });

  test("a name missing from the manifest falls back to the directory basename", () => {
    const root = tempRepo({
      "package.json": JSON.stringify({ name: "root" }),
      "packages/anon/package.json": "{}",
      "packages/anon/index.ts": "",
    });
    expect(detectPackages(root, ["packages/anon/index.ts"], configWith(["packages/*"]))[1]).toEqual({
      name: "anon",
      path: "packages/anon",
      source: "package.json",
    });
  });

  test("duplicate names keep the first by path order and rename the rest", () => {
    const root = tempRepo({
      "package.json": JSON.stringify({ name: "dup" }),
      "apps/one/package.json": JSON.stringify({ name: "dup" }),
      "apps/one/index.ts": "",
      "packages/two/package.json": JSON.stringify({ name: "dup" }),
      "packages/two/index.ts": "",
    });
    const files = ["apps/one/index.ts", "packages/two/index.ts"];
    expect(detectPackages(root, files, configWith(["packages/*", "apps/*"]))).toEqual([
      { name: "dup", path: ".", source: "root" },
      { name: "dup (apps/one)", path: "apps/one", source: "package.json" },
      { name: "dup (packages/two)", path: "packages/two", source: "package.json" },
    ]);
  });

  test("results are sorted by path with the root first, whatever the file order", () => {
    const root = tempRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", "apps/*"] }),
      "packages/zeta/package.json": JSON.stringify({ name: "zeta" }),
      "packages/zeta/index.ts": "",
      "packages/alpha/package.json": JSON.stringify({ name: "alpha" }),
      "packages/alpha/index.ts": "",
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/index.ts": "",
    });
    const files = ["packages/zeta/index.ts", "apps/web/index.ts", "packages/alpha/index.ts"];
    const forward = detectPackages(root, files, configWith([])).map((p) => p.path);
    const reversed = detectPackages(root, [...files].reverse(), configWith([])).map((p) => p.path);
    expect(forward).toEqual([".", "apps/web", "packages/alpha", "packages/zeta"]);
    expect(reversed).toEqual(forward);
  });

  test("node_modules is never walked", () => {
    const root = tempRepo({
      "package.json": JSON.stringify({ name: "root" }),
      "node_modules/dep/package.json": JSON.stringify({ name: "dep" }),
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/a/index.ts": "",
    });
    expect(detectPackages(root, ["packages/a/index.ts"], configWith(["**"])).map((p) => p.path)).toEqual([
      ".",
      "packages/a",
    ]);
  });
});

describe("packageOf", () => {
  const packages: PackageInfo[] = [
    { name: "root", path: ".", source: "root" },
    { name: "@w/core", path: "packages/core", source: "package.json" },
    { name: "@w/core-plugin", path: "packages/core-plugin", source: "package.json" },
    { name: "@w/nested", path: "packages/core/nested", source: "package.json" },
  ];

  test("picks the deepest path prefix", () => {
    expect(packageOf("packages/core/src/index.ts", packages).name).toBe("@w/core");
    expect(packageOf("packages/core/nested/src/a.ts", packages).name).toBe("@w/nested");
    expect(packageOf("packages/core-plugin/a.ts", packages).name).toBe("@w/core-plugin");
  });

  test("falls back to the root package", () => {
    expect(packageOf("scripts/build.ts", packages).name).toBe("root");
    expect(packageOf("README.md", packages).name).toBe("root");
    expect(packageOf("packages/other/a.ts", packages).name).toBe("root");
  });

  test("a sibling directory sharing a name prefix does not match", () => {
    expect(packageOf("packages/core-extra/a.ts", packages).name).toBe("root");
  });

  test("the input order of packages does not matter", () => {
    const shuffled = [packages[3]!, packages[1]!, packages[0]!, packages[2]!];
    expect(packageOf("packages/core/nested/src/a.ts", shuffled).name).toBe("@w/nested");
    expect(packageOf("packages/core/src/a.ts", shuffled).name).toBe("@w/core");
  });
});

describe("tiny-ts", () => {
  const root = path.resolve(import.meta.dir, "../../../fixtures/tiny-ts");
  const files = [
    "apps/worker/src/config.ts",
    "apps/worker/src/main.ts",
    "packages/adapters/src/index.ts",
    "packages/adapters/src/memory.ts",
    "packages/adapters/src/sqs.ts",
    "packages/core/src/bus.ts",
    "packages/core/src/events.ts",
    "packages/core/src/index.ts",
    "packages/core/src/queue.ts",
    "packages/core/src/registry.ts",
    "packages/core/src/retry.ts",
    "packages/core/src/types.ts",
  ];
  const readFile = (rel: string): string | null => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const packages = detectPackages(root, files, DEFAULT_CONFIG);
  const resolver = createResolver({ root, files: new Set(files), packages, readFile });

  const CORE_INDEX = "packages/core/src/index.ts";
  const ADAPTERS_INDEX = "packages/adapters/src/index.ts";

  // Specifiers extracted by hand from the 12 fixture files, in file order.
  const imports: Array<[from: string, specifier: string, target: ResolvedTarget]> = [
    ["apps/worker/src/main.ts", "@tiny/core", file(CORE_INDEX)],
    ["apps/worker/src/main.ts", "@tiny/adapters", file(ADAPTERS_INDEX)],
    ["apps/worker/src/main.ts", "./config", file("apps/worker/src/config.ts")],
    [ADAPTERS_INDEX, "./sqs", file("packages/adapters/src/sqs.ts")],
    [ADAPTERS_INDEX, "./memory", file("packages/adapters/src/memory.ts")],
    ["packages/adapters/src/memory.ts", "@tiny/core", file(CORE_INDEX)],
    ["packages/adapters/src/sqs.ts", "@tiny/core", file(CORE_INDEX)],
    ["packages/adapters/src/sqs.ts", "@aws-sdk/client-sqs", external("@aws-sdk/client-sqs")],
    ["packages/core/src/bus.ts", "./events", file("packages/core/src/events.ts")],
    ["packages/core/src/bus.ts", "./types", file("packages/core/src/types.ts")],
    ["packages/core/src/events.ts", "./bus", file("packages/core/src/bus.ts")],
    [CORE_INDEX, "./registry", file("packages/core/src/registry.ts")],
    [CORE_INDEX, "./retry", file("packages/core/src/retry.ts")],
    [CORE_INDEX, "./queue", file("packages/core/src/queue.ts")],
    [CORE_INDEX, "./types", file("packages/core/src/types.ts")],
    ["packages/core/src/queue.ts", "./types", file("packages/core/src/types.ts")],
    ["packages/core/src/registry.ts", "./queue", file("packages/core/src/queue.ts")],
    ["packages/core/src/registry.ts", "./retry", file("packages/core/src/retry.ts")],
    ["packages/core/src/registry.ts", "./bus", file("packages/core/src/bus.ts")],
  ];

  test("has 12 indexed files and 4 packages", () => {
    expect(files).toHaveLength(12);
    expect(packages).toEqual([
      { name: "tiny-ts", path: ".", source: "root" },
      { name: "worker", path: "apps/worker", source: "package.json" },
      { name: "@tiny/adapters", path: "packages/adapters", source: "package.json" },
      { name: "@tiny/core", path: "packages/core", source: "package.json" },
    ]);
  });

  test("every file belongs to the expected package", () => {
    expect(files.map((f) => packageOf(f, packages).name)).toEqual([
      "worker",
      "worker",
      "@tiny/adapters",
      "@tiny/adapters",
      "@tiny/adapters",
      "@tiny/core",
      "@tiny/core",
      "@tiny/core",
      "@tiny/core",
      "@tiny/core",
      "@tiny/core",
      "@tiny/core",
    ]);
  });

  test("every import of the 12 files resolves to the expected target", () => {
    const actual = imports.map(([from, spec]) => [from, spec, resolver.resolve(from, spec, "ts")]);
    expect(actual).toEqual(imports.map(([from, spec, target]) => [from, spec, target]));
  });

  test("the two files with no imports exist and hold none of the fixture specifiers", () => {
    for (const quiet of ["packages/core/src/retry.ts", "packages/core/src/types.ts", "apps/worker/src/config.ts"]) {
      expect(readFile(quiet)).not.toBeNull();
      expect(readFile(quiet)).not.toContain("import ");
      expect(imports.some(([from]) => from === quiet)).toBe(false);
    }
  });

  test("@tiny/core resolves through the workspace package when the tsconfig is absent", () => {
    const noTsconfig = createResolver({
      root,
      files: new Set(files),
      packages,
      readFile: (rel) => (rel.endsWith("tsconfig.json") ? null : readFile(rel)),
    });
    expect(noTsconfig.resolve("apps/worker/src/main.ts", "@tiny/core", "ts")).toEqual(file(CORE_INDEX));
    expect(noTsconfig.resolve("apps/worker/src/main.ts", "@tiny/adapters", "ts")).toEqual(file(ADAPTERS_INDEX));
  });

  test("resolution is stable across calls", () => {
    for (const [from, spec, target] of imports) {
      expect(resolver.resolve(from, spec, "ts")).toEqual(target);
      expect(resolver.resolve(from, spec, "ts")).toEqual(target);
    }
  });
});
