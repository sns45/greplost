/**
 * Every command, end to end, on temp copies of the committed fixtures
 * (leaf 1.4.1; plugin-cli spec "Tests").
 *
 * `main` is called in process and its exit code asserted, with stdout and
 * stderr captured, because that is exactly the contract `bin/greplost.js` and
 * the plugin depend on: a number back, nothing written to the wrong stream, and
 * `--json` output that is a single parseable document.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { benchRepoRoot } from "../src/commands/bench.ts";
import { main } from "../src/main.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_TS = path.join(repoRoot, "fixtures", "tiny-ts");
const TINY_GO = path.join(repoRoot, "fixtures", "tiny-go");

const temporaries: string[] = [];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in process, capturing both streams. */
async function cli(...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]): void => {
    out.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    err.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await main(argv);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** A temp copy of a fixture, removed when the file finishes. */
function copyFixture(source: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-cli-${label}-`));
  cpSync(source, dir, { recursive: true });
  temporaries.push(dir);
  return dir;
}

function emptyDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-cli-${label}-`));
  temporaries.push(dir);
  return dir;
}

/** Parse `--json` stdout, proving nothing else was printed to it. */
function onlyJson(run: Run): unknown {
  expect(run.stderr).toBe("");
  expect(run.stdout.trimStart().startsWith("{")).toBe(true);
  return JSON.parse(run.stdout);
}

function manifestOf(root: string): { files: Record<string, { blast: number; fanIn: number }> } {
  return JSON.parse(readFileSync(path.join(root, ".greplost", "manifest.json"), "utf8")) as {
    files: Record<string, { blast: number; fanIn: number }>;
  };
}

/** Built once: every read-only command answers from the same map. */
let ts = "";
let go = "";

beforeAll(async () => {
  ts = copyFixture(TINY_TS, "ts");
  expect((await cli("init", "--no-hooks", "--root", ts)).code).toBe(0);

  go = copyFixture(TINY_GO, "go");
  mkdirSync(path.join(go, ".greplost"), { recursive: true });
  writeFileSync(path.join(go, ".greplost", "config.json"), `${JSON.stringify({ languages: ["go"] }, null, 2)}\n`);
  expect((await cli("init", "--no-hooks", "--root", go)).code).toBe(0);
});

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe("init", () => {
  test("writes the map, the config and the gitignore", () => {
    for (const relative of ["INDEX.md", "manifest.json", "config.json", ".gitignore", "graph/imports.jsonl"]) {
      expect(existsSync(path.join(ts, ".greplost", relative))).toBe(true);
    }
  });

  test("is idempotent and reports the update shape under --json", async () => {
    const fresh = copyFixture(TINY_TS, "init");
    const first = await cli("init", "--no-hooks", "--root", fresh);
    expect(first.code).toBe(0);

    const second = await cli("init", "--no-hooks", "--json", "--root", fresh);
    expect(second.code).toBe(0);
    const result = onlyJson(second) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(
      ["cached", "deleted", "dirty", "mode", "ms", "reparsed", "written"],
    );
    expect(result["mode"]).toBe("full");
    expect(result["written"]).toBe(0);
  });

  test("reports a missing map rather than crashing", async () => {
    const bare = emptyDir("bare");
    const run = await cli("query", "Registry", "--root", bare);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("no map");
    expect(run.stdout).toBe("");
  });
});

describe("query", () => {
  test("finds a symbol and matches the documented --json shape", async () => {
    const run = await cli("query", "Registry", "--json", "--root", ts);
    expect(run.code).toBe(0);
    const result = onlyJson(run) as { query: string; matches: Array<Record<string, unknown>> };

    expect(result.query).toBe("Registry");
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0] as Record<string, unknown>;
    expect(Object.keys(match).sort()).toEqual(
      ["callers", "card", "exported", "file", "id", "importers", "kind", "name", "package", "signature", "span"],
    );
    expect(match["file"]).toBe("packages/core/src/registry.ts");
    expect(match["id"]).toBe("packages/core/src/registry.ts#Registry");
    expect(match["kind"]).toBe("class");
    expect(match["exported"]).toBe(true);
    expect(match["package"]).toBe("@tiny/core");
    expect(match["card"]).toBe("packages/tiny__core/modules/src/registry.ts.md");
    expect(match["span"]).toEqual([5, 26]);
    expect(match["importers"]).toEqual(["packages/core/src/index.ts"]);
  });

  test("lists callers by symbol id", async () => {
    const run = await cli("query", "retry", "--json", "--root", ts);
    const result = onlyJson(run) as { matches: Array<{ id: string; callers: string[] }> };
    const retry = result.matches.find((m) => m.id === "packages/core/src/retry.ts#retry");
    expect(retry?.callers).toEqual([
      "packages/adapters/src/sqs.ts#SqsAdapter.publish",
      "packages/core/src/registry.ts#Registry.publishAll",
    ]);
  });

  test("finds a member symbol by its suffix", async () => {
    const run = await cli("query", "publishAll", "--json", "--root", ts);
    expect(run.code).toBe(0);
    const result = onlyJson(run) as { matches: Array<{ name: string; kind: string }> };
    expect(result.matches.map((m) => m.name)).toContain("Registry.publishAll");
    expect(result.matches[0]?.kind).toBe("method");
  });

  test("returns the file block for a path argument", async () => {
    const run = await cli("query", "packages/core/src/retry.ts", "--json", "--root", ts);
    expect(run.code).toBe(0);
    const result = onlyJson(run) as { file?: Record<string, unknown>; matches: Array<{ file: string }> };

    const file = result.file as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(
      ["blast", "card", "exports", "fanIn", "fanOut", "importers", "imports", "loc", "package", "path"],
    );
    expect(file["path"]).toBe("packages/core/src/retry.ts");
    expect(file["package"]).toBe("@tiny/core");
    expect(file["card"]).toBe("packages/tiny__core/modules/src/retry.ts.md");
    expect(file["importers"]).toContain("packages/core/src/registry.ts");
    expect(file["exports"]).toEqual(["DEFAULT_ATTEMPTS", "RetryOptions", "retry"]);

    const entry = manifestOf(ts).files["packages/core/src/retry.ts"];
    expect(file["blast"]).toBe(entry?.blast as number);
    expect(file["fanIn"]).toBe(entry?.fanIn as number);

    // The declarations of that file come along, so one call answers both halves.
    expect(result.matches.every((m) => m.file === "packages/core/src/retry.ts")).toBe(true);
  });

  test("accepts an absolute path, a ./-prefix, and an unambiguous suffix", async () => {
    for (const argument of [
      path.join(ts, "packages/core/src/retry.ts"),
      "./packages/core/src/retry.ts",
      "core/src/retry.ts",
      "retry.ts",
    ]) {
      const run = await cli("query", argument, "--json", "--root", ts);
      expect(run.code).toBe(0);
      const result = onlyJson(run) as { file?: { path: string } };
      expect(result.file?.path).toBe("packages/core/src/retry.ts");
    }
  });

  test("an ambiguous path suffix resolves to nothing rather than guessing", async () => {
    // Both packages/adapters/src/index.ts and packages/core/src/index.ts end in it.
    const run = await cli("query", "src/index.ts", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run) as { file?: unknown; matches: unknown[] };
    expect(result.file).toBeUndefined();
    expect(result.matches).toEqual([]);
  });

  test("exits 1 with an empty match list when nothing matches", async () => {
    const json = await cli("query", "NoSuchSymbol", "--json", "--root", ts);
    expect(json.code).toBe(1);
    const result = onlyJson(json) as { matches: unknown[]; file?: unknown };
    expect(result.matches).toEqual([]);
    expect(result.file).toBeUndefined();

    const human = await cli("query", "NoSuchSymbol", "--root", ts);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe('greplost: no match for "NoSuchSymbol"');
  });

  test("human output is aligned columns plus the card path", async () => {
    const run = await cli("query", "Registry", "--root", ts);
    expect(run.code).toBe(0);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toMatch(/^NAME +KIND +LOCATION +PACKAGE$/);
    expect(lines[1]).toContain("packages/core/src/registry.ts:5-26");
    expect(run.stdout).toContain("packages/tiny__core/modules/src/registry.ts.md");
    for (const line of lines) expect(line).not.toMatch(/\s$/);
  });

  test("answers a Go map, where imports target directories", async () => {
    const run = await cli("query", "internal/store/store.go", "--json", "--root", go);
    expect(run.code).toBe(0);
    const result = onlyJson(run) as { file?: { importers: string[]; package: string } };
    expect(result.file?.importers).toContain("cmd/app/main.go");
  });
});

describe("impact", () => {
  test("radius equals the manifest blast and depth-2 dependents are listed", async () => {
    const run = await cli("impact", "packages/core/src/retry.ts", "--json", "--root", ts);
    expect(run.code).toBe(0);
    const result = onlyJson(run) as { path: string; radius: number; files: Array<{ path: string; depth: number }> };

    expect(Object.keys(result).sort()).toEqual(["files", "path", "radius"]);
    expect(result.path).toBe("packages/core/src/retry.ts");
    expect(result.radius).toBe(manifestOf(ts).files["packages/core/src/retry.ts"]?.blast as number);
    expect(result.files).toHaveLength(result.radius);
    expect(result.files).toContainEqual({ path: "packages/adapters/src/sqs.ts", depth: 2 });
    expect(result.files.filter((f) => f.depth === 1).map((f) => f.path)).toEqual([
      "packages/core/src/index.ts",
      "packages/core/src/registry.ts",
    ]);
  });

  test("--depth truncates the listing and never the radius", async () => {
    const run = await cli("impact", "packages/core/src/retry.ts", "--depth", "1", "--json", "--root", ts);
    const result = onlyJson(run) as { radius: number; files: Array<{ depth: number }> };
    expect(result.radius).toBe(6);
    expect(result.files.every((f) => f.depth <= 1)).toBe(true);
    expect(result.files).toHaveLength(2);
  });

  test("reports a leaf file as an empty blast radius", async () => {
    const run = await cli("impact", "apps/worker/src/main.ts", "--json", "--root", ts);
    expect(run.code).toBe(0);
    const result = onlyJson(run) as { radius: number; files: unknown[] };
    expect(result.radius).toBe(0);
    expect(result.files).toEqual([]);
  });

  test("exits 1 for a path the map does not hold", async () => {
    const run = await cli("impact", "packages/core/src/nope.ts", "--root", ts);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("is not in the map");
  });

  test("human output is a depth table and says when it was capped", async () => {
    const run = await cli("impact", "packages/core/src/retry.ts", "--root", ts);
    expect(run.code).toBe(0);
    expect(run.stdout.split("\n")[0]).toBe("packages/core/src/retry.ts  blast radius 6");
    expect(run.stdout).toContain("DEPTH  FILE");
    expect(run.stdout).toContain("2      packages/adapters/src/sqs.ts");

    const capped = await cli("impact", "packages/core/src/retry.ts", "--depth", "1", "--root", ts);
    expect(capped.stdout.split("\n")[0]).toBe(
      "packages/core/src/retry.ts  blast radius 6, showing depth <= 1",
    );
  });

  test("expands directory targets so a Go map has a blast radius", async () => {
    const run = await cli("impact", "internal/store/store.go", "--json", "--root", go);
    expect(run.code).toBe(0);
    const result = onlyJson(run) as { radius: number; files: Array<{ path: string; depth: number }> };
    expect(result.files).toContainEqual({ path: "cmd/app/main.go", depth: 1 });
    expect(result.radius).toBe(result.files.length);
  });
});

describe("verify", () => {
  test("exits 0 on a freshly built map", async () => {
    const run = await cli("verify", "--root", ts);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("greplost: map is in sync");
  });

  test("--json reports the documented shape when clean", async () => {
    const run = await cli("verify", "--json", "--root", ts);
    expect(run.code).toBe(0);
    const result = onlyJson(run) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["changed", "extra", "missing", "ok"]);
    expect(result["ok"]).toBe(true);
  });

  test("exits 1 after drift, shows a unified diff, and update restores it", async () => {
    const drifted = copyFixture(TINY_TS, "drift");
    expect((await cli("init", "--no-hooks", "--root", drifted)).code).toBe(0);

    const source = path.join(drifted, "packages", "core", "src", "retry.ts");
    writeFileSync(source, `${readFileSync(source, "utf8")}\nexport function addedByTest(): void {}\n`);

    const plain = await cli("verify", "--root", drifted);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain("map is out of date");

    const diffed = await cli("verify", "--diff", "--json", "--root", drifted);
    expect(diffed.code).toBe(1);
    const result = onlyJson(diffed) as { ok: boolean; changed: string[]; diff: string };
    expect(result.ok).toBe(false);
    expect(result.changed.length).toBeGreaterThan(0);
    expect(result.diff.startsWith("--- a/.greplost/")).toBe(true);
    expect(result.diff).toContain("+++ b/.greplost/");

    const human = await cli("verify", "--diff", "--root", drifted);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("--- a/.greplost/");

    const updated = await cli("update", "--json", "--root", drifted);
    expect(updated.code).toBe(0);
    const summary = onlyJson(updated) as { written: number };
    expect(summary.written).toBeGreaterThan(0);

    expect((await cli("verify", "--root", drifted)).code).toBe(0);
  });

  test("reports a deleted artifact as missing", async () => {
    const broken = copyFixture(TINY_TS, "missing");
    expect((await cli("init", "--no-hooks", "--root", broken)).code).toBe(0);
    rmSync(path.join(broken, ".greplost", "repo", "HOTSPOTS.md"));

    const run = await cli("verify", "--json", "--root", broken);
    expect(run.code).toBe(1);
    const result = onlyJson(run) as { missing: string[] };
    expect(result.missing).toContain("repo/HOTSPOTS.md");
  });
});

describe("update", () => {
  test("defaults to incremental and honours --full", async () => {
    const incremental = onlyJson(await cli("update", "--json", "--root", ts)) as { mode: string };
    expect(incremental.mode).toBe("incremental");

    const full = onlyJson(await cli("update", "--full", "--json", "--root", ts)) as {
      mode: string;
      written: number;
    };
    expect(full.mode).toBe("full");
    expect(full.written).toBe(0);
  });

  test("--files names the dirty set and --quiet silences the summary", async () => {
    const result = onlyJson(
      await cli("update", "--files", "packages/core/src/retry.ts", "--json", "--root", ts),
    ) as { dirty: number };
    expect(result.dirty).toBeGreaterThanOrEqual(1);

    const quiet = await cli("update", "--quiet", "--root", ts);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe("");
  });
});

describe("flows", () => {
  test("exits 1 with a hint when the semantic document is absent", async () => {
    const run = await cli("flows", "@tiny/core", "--root", ts);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("no FLOWS.md for @tiny/core");
    expect(run.stderr).toContain("greplost refresh");
  });

  test("prints the document when it exists, by package name or slug", async () => {
    const flows = path.join(ts, ".greplost", "packages", "tiny__core", "FLOWS.md");
    mkdirSync(path.dirname(flows), { recursive: true });
    writeFileSync(flows, "# Flows\n\nrequest -> registry -> queue\n");
    try {
      const run = await cli("flows", "@tiny/core", "--root", ts);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("# Flows\n\nrequest -> registry -> queue");

      const json = onlyJson(await cli("flows", "tiny__core", "--json", "--root", ts)) as {
        package: string;
        path: string;
        text: string;
      };
      expect(json.path).toBe("packages/tiny__core/FLOWS.md");
      expect(json.text).toContain("request -> registry -> queue");
    } finally {
      rmSync(flows, { force: true });
    }
  });
});

describe("refresh", () => {
  // `--dry-run` throughout: a real refresh spawns `claude -p`, and a test suite
  // that reaches a model is neither hermetic nor free. The seam itself is what
  // is being checked here — that the command finds `@greplost/semantic`, hands
  // it the operands, and passes its exit code back — and the semantic package's
  // own tests drive the model path through an injected runner.
  test("delegates to the semantic layer and reports what a refresh would do", async () => {
    const run = await cli("refresh", "--dry-run", "--root", ts);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("would be refreshed");
    expect(run.stdout).toContain("dry run");
    // A dry run writes nothing, so the shared map is untouched.
    expect(existsSync(path.join(ts, ".greplost", "cache", "summaries.json"))).toBe(false);
  });

  test("passes an unknown package through as the semantic layer's own error", async () => {
    const run = await cli("refresh", "@tiny/nope", "--dry-run", "--root", ts);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("greplost: no package @tiny/nope");
  });

  test("--json is the refresh result and nothing else", async () => {
    const result = onlyJson(await cli("refresh", "--dry-run", "--json", "--root", ts)) as {
      refreshed: number;
      skipped: number;
      calls: number;
      flows: string[];
    };
    expect(result.calls).toBe(0);
    expect(result.flows).toEqual([]);
    expect(result.refreshed + result.skipped).toBe(12);
  });
});

describe("bench", () => {
  test("finds the harness inside the repo and passes the exit code through", async () => {
    expect(benchRepoRoot()).toBe(path.resolve(repoRoot));
    const run = await cli("bench", "no-such-suite", "--root", ts);
    expect(run.code).toBe(2);
  });
});

describe("version", () => {
  test("prints the package version", async () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"),
    ) as { version: string };
    const run = await cli("--version");
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`greplost ${manifest.version}`);

    const json = onlyJson(await cli("--version", "--json")) as { name: string; version: string };
    expect(json).toEqual({ name: "greplost", version: manifest.version });
  });

  test("--help prints the usage block and exits 0", async () => {
    const run = await cli("--help");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("usage: greplost <command>");
  });
});

describe("usage errors", () => {
  test("an unknown flag exits 2 without running anything", async () => {
    const run = await cli("verify", "--nope", "--root", ts);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--nope");
  });

  test("a --root that is not a directory exits 2", async () => {
    const run = await cli("verify", "--root", path.join(ts, "definitely-missing"));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("not a directory");
  });
});

describe("root discovery", () => {
  test("walks up from the working directory to the nearest map", async () => {
    const original = process.cwd();
    try {
      process.chdir(path.join(ts, "packages", "core", "src"));
      const run = await cli("query", "Registry", "--json");
      expect(run.code).toBe(0);
      const result = onlyJson(run) as { matches: Array<{ file: string }> };
      expect(result.matches[0]?.file).toBe("packages/core/src/registry.ts");
    } finally {
      process.chdir(original);
    }
  });
});
