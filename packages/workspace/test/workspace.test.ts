/**
 * `@greplost/workspace` end to end (workspace spec "Tests", tech spec 4.4, X10).
 *
 * Every test runs against a temp copy of `fixtures/two-repo-workspace`, never
 * the fixture itself: `buildWorkspace` writes `.greplost/` into each repo, and
 * a fixture that builds in place would show up in `git status` and stop being
 * a fixture. The Go workspace is built inline rather than committed, because
 * the spec's fixture is the TypeScript one and a second committed fixture
 * nobody else consumes is a liability.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKSPACE_ARTIFACTS,
  WORKSPACE_FILE,
  buildWorkspace,
  findWorkspaceRoot,
  impactAcross,
  loadWorkspace,
  verifyWorkspace,
} from "../src/index.ts";
import type { CrossEdge } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = path.join(repoRoot, "fixtures", "two-repo-workspace");

const temporaries: string[] = [];

/** A temp copy of the two-repo fixture, removed when the file finishes. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-ws-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  temporaries.push(dir);
  return dir;
}

function emptyDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-ws-${label}-`));
  temporaries.push(dir);
  return dir;
}

function artifact(root: string, rel: string): string {
  return readFileSync(path.join(root, ".greplost", rel), "utf8");
}

/** Built once: every read-only assertion answers from the same workspace. */
let ws = "";

beforeAll(async () => {
  ws = copyFixture("built");
  await buildWorkspace(ws);
});

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe("workspace config", () => {
  test("findWorkspaceRoot walks up from a nested directory", () => {
    expect(findWorkspaceRoot(ws)).toBe(ws);
    expect(findWorkspaceRoot(path.join(ws, "repo-b", "src"))).toBe(ws);
  });

  test("findWorkspaceRoot is null where there is no workspace file", () => {
    expect(findWorkspaceRoot(emptyDir("nows"))).toBe(null);
  });

  test("loadWorkspace reads the name and the repo list as written", () => {
    expect(loadWorkspace(ws)).toEqual({ name: "two-repo", repos: ["./repo-a", "./repo-b"] });
  });

  test("a workspace file that is not an object is a greplost error", () => {
    const broken = emptyDir("broken");
    writeFileSync(path.join(broken, WORKSPACE_FILE), "[]\n");
    expect(() => loadWorkspace(broken)).toThrow(/greplost:/);
  });

  test("a repo listed inside another repo is refused", () => {
    const nested = emptyDir("nested");
    writeFileSync(
      path.join(nested, WORKSPACE_FILE),
      `${JSON.stringify({ name: "n", repos: ["./repo-a", "./repo-a/inner"] })}\n`,
    );
    expect(() => loadWorkspace(nested)).toThrow(/is inside repo/);
  });

  test("a workspace root that is also an indexed repo is refused", () => {
    const both = emptyDir("both");
    writeFileSync(path.join(both, WORKSPACE_FILE), `${JSON.stringify({ name: "b", repos: ["./repo-a"] })}\n`);
    mkdirSync(path.join(both, ".greplost"), { recursive: true });
    writeFileSync(path.join(both, ".greplost", "manifest.json"), "{}\n");
    expect(() => loadWorkspace(both)).toThrow(/both a workspace root and an indexed repository/);
  });

  test("a workspace with no repos still builds and verifies", async () => {
    const empty = emptyDir("empty");
    writeFileSync(path.join(empty, WORKSPACE_FILE), `${JSON.stringify({ repos: [] })}\n`);

    const build = await buildWorkspace(empty);
    expect(build.repos).toEqual([]);
    expect(build.cross).toEqual([]);
    // No name in the file: the workspace directory names itself.
    expect(build.name).toBe(path.basename(empty));
    expect(artifact(empty, WORKSPACE_ARTIFACTS.cross)).toBe("");
    expect(artifact(empty, WORKSPACE_ARTIFACTS.workspace)).not.toContain("```mermaid");
    expect((await verifyWorkspace(empty)).ok).toBe(true);
  });
});

describe("cross edge", () => {
  test("repo-b's import of @fx/a targets repo-a's entry file", async () => {
    const build = await buildWorkspace(ws);
    expect(build.cross).toEqual([
      {
        from: "repo-b::src/main.ts",
        to: "repo-a::src/index.ts",
        kind: "import",
        symbols: ["hello"],
        confidence: "high",
        specifier: "@fx/a",
      },
    ]);
  });

  test("the repo table carries package and file counts", async () => {
    const build = await buildWorkspace(ws);
    expect(build.repos).toEqual([
      { dir: "repo-a", name: "@fx/a", packages: ["@fx/a"], files: 2 },
      { dir: "repo-b", name: "@fx/b", packages: ["@fx/b"], files: 2 },
    ]);
  });

  test("graph/cross.jsonl holds one sorted, key-sorted line per edge", () => {
    const text = artifact(ws, WORKSPACE_ARTIFACTS.cross);
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      '{"confidence":"high","from":"repo-b::src/main.ts","kind":"import",' +
        '"specifier":"@fx/a","symbols":["hello"],"to":"repo-a::src/index.ts"}',
    );
  });

  test("WORKSPACE.md titles the workspace, links each repo and lists the dependency", () => {
    const text = artifact(ws, WORKSPACE_ARTIFACTS.workspace);
    expect(text.startsWith("# two-repo workspace\n")).toBe(true);
    expect(text).toContain("> Generated by greplost.");
    expect(text).toContain("./repo-a/.greplost/INDEX.md");
    expect(text).toContain("./repo-b/.greplost/INDEX.md");
    expect(text).toContain("```mermaid\ngraph LR\n");
    expect(text).toContain("## Cross-repo dependencies");
    expect(text).toContain("| repo-b | `src/main.ts` | repo-a | `@fx/a` | `hello` |");
  });

  test("a sibling with no resolvable entry file falls back to pkg:<name>", async () => {
    const noEntry = copyFixture("noentry");
    writeFileSync(
      path.join(noEntry, "repo-a", "package.json"),
      `${JSON.stringify({ name: "@fx/a", version: "1.0.0", private: true }, null, 2)}\n`,
    );
    const build = await buildWorkspace(noEntry);
    expect(build.cross.map((edge: CrossEdge) => edge.to)).toEqual(["repo-a::pkg:@fx/a"]);
  });

  test("an external package no sibling publishes is not a cross edge", async () => {
    const outside = copyFixture("outside");
    writeFileSync(
      path.join(outside, "repo-b", "src", "main.ts"),
      'import { hello } from "@fx/a";\nimport { readFile } from "node:fs/promises";\n\n' +
        "export function run(name: string): string {\n  void readFile;\n  return hello(name);\n}\n",
    );
    const build = await buildWorkspace(outside);
    expect(build.cross.map((edge: CrossEdge) => edge.to)).toEqual(["repo-a::src/index.ts"]);
  });

  /** repo-a grows `src/sub.ts`; repo-b imports it through `@fx/a/sub`. */
  function subpathWorkspace(label: string, exportsMap: Record<string, string>): string {
    const dir = copyFixture(label);
    writeFileSync(
      path.join(dir, "repo-a", "package.json"),
      `${JSON.stringify({ name: "@fx/a", version: "1.0.0", private: true, exports: exportsMap }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(dir, "repo-a", "src", "sub.ts"),
      "export function sub(name: string): string {\n  return `sub:${name}`;\n}\n",
    );
    writeFileSync(
      path.join(dir, "repo-b", "src", "main.ts"),
      'import { sub } from "@fx/a/sub";\n\nexport function run(name: string): string {\n  return sub(name);\n}\n',
    );
    return dir;
  }

  test("a subpath import resolves through the sibling's exports map", async () => {
    const dir = subpathWorkspace("subpath", { ".": "./src/index.ts", "./sub": "./src/sub.ts" });

    const build = await buildWorkspace(dir);
    expect(build.cross).toEqual([
      {
        from: "repo-b::src/main.ts",
        to: "repo-a::src/sub.ts",
        kind: "import",
        symbols: ["sub"],
        confidence: "high",
        specifier: "@fx/a/sub",
      },
    ]);
    expect(impactAcross(dir, "repo-a::src/sub.ts")).toEqual([
      { id: "repo-b::src/main.ts", depth: 1 },
      { id: "repo-b::src/app.ts", depth: 2 },
    ]);
    // The entry file is no longer where a subpath import is attributed.
    expect(impactAcross(dir, "repo-a::src/index.ts")).toEqual([]);
  });

  test("a wildcard exports pattern resolves the subpath too", async () => {
    const dir = subpathWorkspace("wildcard", { ".": "./src/index.ts", "./*": "./src/*.ts" });
    const build = await buildWorkspace(dir);
    expect(build.cross.map((edge: CrossEdge) => edge.to)).toEqual(["repo-a::src/sub.ts"]);
  });

  test("a subpath the exports map does not answer falls back to the entry file", async () => {
    const dir = subpathWorkspace("subpathmiss", { ".": "./src/index.ts" });
    const build = await buildWorkspace(dir);
    expect(build.cross.map((edge: CrossEdge) => edge.to)).toEqual(["repo-a::src/index.ts"]);
  });

  test("two packages in one repo declaring one npm name warn on stderr", async () => {
    const dupe = copyFixture("dupe");
    mkdirSync(path.join(dupe, "repo-a", "packages", "twin", "src"), { recursive: true });
    writeFileSync(
      path.join(dupe, "repo-a", "packages", "twin", "package.json"),
      `${JSON.stringify({ name: "@fx/a", version: "1.0.0", private: true }, null, 2)}\n`,
    );
    writeFileSync(path.join(dupe, "repo-a", "packages", "twin", "src", "twin.ts"), "export const twin = 1;\n");

    const warnings: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await buildWorkspace(dupe);
    } finally {
      console.error = error;
    }
    expect(warnings.join("\n")).toContain('declares the npm name "@fx/a" in two packages');
  });

  test("a type-only import and a re-export are cross edges too", async () => {
    const mixed = copyFixture("mixed");
    writeFileSync(
      path.join(mixed, "repo-b", "src", "main.ts"),
      'import { hello } from "@fx/a";\nimport type { Greeting } from "@fx/a";\n\n' +
        'export * from "@fx/a";\n\nexport function run(name: string): Greeting {\n' +
        "  return { text: hello(name) };\n}\n",
    );

    const build = await buildWorkspace(mixed);
    expect(build.cross.map((edge: CrossEdge) => edge.symbols)).toEqual([["*"], ["Greeting"], ["hello"]]);
    for (const edge of build.cross) {
      expect(edge.kind).toBe("import");
      expect(edge.from).toBe("repo-b::src/main.ts");
      expect(edge.to).toBe("repo-a::src/index.ts");
    }
    expect(artifact(mixed, WORKSPACE_ARTIFACTS.workspace)).toContain("## Cross-repo dependencies (3)");
  });

  test("a Go import path under a sibling's module path targets that package directory", async () => {
    const go = emptyDir("go");
    writeFileSync(path.join(go, WORKSPACE_FILE), `${JSON.stringify({ name: "go-two", repos: ["./go-a", "./go-b"] })}\n`);
    for (const [repo, files] of goRepos()) {
      for (const [rel, body] of files) {
        mkdirSync(path.join(go, repo, path.dirname(rel)), { recursive: true });
        writeFileSync(path.join(go, repo, rel), body);
      }
      mkdirSync(path.join(go, repo, ".greplost"), { recursive: true });
      writeFileSync(
        path.join(go, repo, ".greplost", "config.json"),
        `${JSON.stringify({ languages: ["go"] }, null, 2)}\n`,
      );
    }

    const build = await buildWorkspace(go);
    expect(build.cross).toEqual([
      {
        from: "go-b::main.go",
        to: "go-a::store",
        kind: "import",
        symbols: ["*"],
        confidence: "high",
        specifier: "example.com/a/store",
      },
    ]);
    expect(impactAcross(go, "go-a::store/store.go")).toEqual([{ id: "go-b::main.go", depth: 1 }]);
  });
});

/** A two-module Go workspace: `go-b/main.go` imports `go-a/store`. */
function goRepos(): Array<[string, Array<[string, string]>]> {
  return [
    [
      "go-a",
      [
        ["go.mod", "module example.com/a\n\ngo 1.22\n"],
        ["store/store.go", "package store\n\nfunc Get(key string) string {\n\treturn key\n}\n"],
      ],
    ],
    [
      "go-b",
      [
        ["go.mod", "module example.com/b\n\ngo 1.22\n"],
        [
          "main.go",
          'package main\n\nimport (\n\t"example.com/a/store"\n)\n\nfunc main() {\n\tprintln(store.Get("k"))\n}\n',
        ],
      ],
    ],
  ];
}

describe("impactAcross", () => {
  test("repo-a's entry file reaches repo-b at depth 1 and its caller at depth 2", () => {
    expect(impactAcross(ws, "repo-a::src/index.ts")).toEqual([
      { id: "repo-b::src/main.ts", depth: 1 },
      { id: "repo-b::src/app.ts", depth: 2 },
    ]);
  });

  test("a repo-internal file reaches across the workspace too", () => {
    expect(impactAcross(ws, "repo-a::src/greet.ts")).toEqual([
      { id: "repo-a::src/index.ts", depth: 1 },
      { id: "repo-b::src/main.ts", depth: 2 },
      { id: "repo-b::src/app.ts", depth: 3 },
    ]);
  });

  test("depth truncates the listing", () => {
    expect(impactAcross(ws, "repo-a::src/index.ts", 1)).toEqual([{ id: "repo-b::src/main.ts", depth: 1 }]);
  });

  test("a leaf of the workspace graph reaches nothing", () => {
    expect(impactAcross(ws, "repo-b::src/app.ts")).toEqual([]);
  });

  test("an unknown target is a greplost error", () => {
    expect(() => impactAcross(ws, "repo-a::src/nope.ts")).toThrow(/greplost:/);
    expect(() => impactAcross(ws, "src/index.ts")).toThrow(/greplost:/);
    expect(() => impactAcross(ws, "repo-z::src/index.ts")).toThrow(/greplost:/);
  });
});

describe("verifyWorkspace", () => {
  test("a freshly built workspace verifies", async () => {
    const result = await verifyWorkspace(ws);
    expect(result).toEqual({ ok: true, changed: [], missing: [], extra: [] });
  });

  test("an unindexed source edit fails, and a rebuild fixes it", async () => {
    const drifting = copyFixture("drift");
    await buildWorkspace(drifting);
    expect((await verifyWorkspace(drifting)).ok).toBe(true);

    writeFileSync(
      path.join(drifting, "repo-a", "src", "index.ts"),
      readFileSync(path.join(drifting, "repo-a", "src", "index.ts"), "utf8") +
        "\nexport function shout(name: string): string {\n  return hello(name).toUpperCase();\n}\n",
    );

    const drifted = await verifyWorkspace(drifting);
    expect(drifted.ok).toBe(false);
    expect(drifted.changed).toContain("repo-a/.greplost/manifest.json");

    await buildWorkspace(drifting);
    expect((await verifyWorkspace(drifting)).ok).toBe(true);
  });

  test("a repo diff names the repo it came from", async () => {
    const diffing = copyFixture("repodiff");
    await buildWorkspace(diffing);
    writeFileSync(path.join(diffing, "repo-a", ".greplost", "INDEX.md"), "# not the map\n");

    const result = await verifyWorkspace(diffing, { diff: true });
    expect(result.ok).toBe(false);
    expect(result.changed).toContain("repo-a/.greplost/INDEX.md");
    expect(result.diff?.split("\n").slice(0, 2)).toEqual([
      "--- a/repo-a/.greplost/INDEX.md",
      "+++ b/repo-a/.greplost/INDEX.md",
    ]);
  });

  test("a stray file under the workspace .greplost/ is reported as extra", async () => {
    const stray = copyFixture("stray");
    await buildWorkspace(stray);
    writeFileSync(path.join(stray, ".greplost", "graph", "leftover.jsonl"), "{}\n");
    // Dotfiles are runtime files, not artifacts, and must not be reported.
    writeFileSync(path.join(stray, ".greplost", ".gitignore"), "*.tmp\n");

    const result = await verifyWorkspace(stray);
    expect(result.ok).toBe(false);
    expect(result.extra).toEqual([".greplost/graph/leftover.jsonl"]);
  });

  test("a deleted workspace artifact is reported as missing", async () => {
    const gap = copyFixture("gap");
    await buildWorkspace(gap);
    rmSync(path.join(gap, ".greplost", WORKSPACE_ARTIFACTS.workspace));

    const result = await verifyWorkspace(gap);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([`.greplost/${WORKSPACE_ARTIFACTS.workspace}`]);
  });
});

describe("byte-stable", () => {
  test("WORKSPACE.md and graph/cross.jsonl are identical across two builds", async () => {
    const stable = copyFixture("stable");
    await buildWorkspace(stable);
    const first = [artifact(stable, WORKSPACE_ARTIFACTS.workspace), artifact(stable, WORKSPACE_ARTIFACTS.cross)];

    await buildWorkspace(stable);
    const second = [artifact(stable, WORKSPACE_ARTIFACTS.workspace), artifact(stable, WORKSPACE_ARTIFACTS.cross)];

    expect(second).toEqual(first);
  });

  test("a fresh checkout of the same sources builds the same bytes", async () => {
    const other = copyFixture("stable2");
    const build = await buildWorkspace(other);
    expect(artifact(other, WORKSPACE_ARTIFACTS.workspace)).toBe(artifact(ws, WORKSPACE_ARTIFACTS.workspace));
    expect(artifact(other, WORKSPACE_ARTIFACTS.cross)).toBe(artifact(ws, WORKSPACE_ARTIFACTS.cross));
    expect(build.files.get(WORKSPACE_ARTIFACTS.workspace)).toBe(artifact(ws, WORKSPACE_ARTIFACTS.workspace));
  });

  test("no absolute path, hostname or date reaches the artifacts", () => {
    for (const rel of [WORKSPACE_ARTIFACTS.workspace, WORKSPACE_ARTIFACTS.cross]) {
      const text = artifact(ws, rel);
      expect(text).not.toContain(ws);
      expect(text).not.toContain(tmpdir());
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});
