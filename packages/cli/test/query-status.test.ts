/**
 * `query` and `impact` ergonomics (leaf 2.15, PLAN "Build 2.1").
 *
 * The evaluation on anyq lost four navigation turns to the same three gaps: a
 * directory argument was answered with "run `greplost update`", a file the
 * config excludes looked exactly like a typo, and a wrong node kind got no
 * suggestion. Each test below is one of those turns, run against a fixture.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/main.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_TS = path.join(repoRoot, "fixtures", "tiny-ts");
const TINY_GO = path.join(repoRoot, "fixtures", "tiny-go");
const TINY_TF = path.join(repoRoot, "fixtures", "tiny-terraform");

const temporaries: string[] = [];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

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

function copyFixture(source: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-ergo-${label}-`));
  cpSync(source, dir, { recursive: true });
  temporaries.push(dir);
  return dir;
}

function onlyJson(run: Run): Record<string, unknown> {
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

let ts = "";
let go = "";
let tf = "";

beforeAll(async () => {
  ts = copyFixture(TINY_TS, "ts");
  expect((await cli("init", "--no-hooks", "--root", ts)).code).toBe(0);

  go = copyFixture(TINY_GO, "go");
  mkdirSync(path.join(go, ".greplost"), { recursive: true });
  writeFileSync(
    path.join(go, ".greplost", "config.json"),
    `${JSON.stringify({ languages: ["go"] }, null, 2)}\n`,
  );
  expect((await cli("init", "--no-hooks", "--root", go)).code).toBe(0);

  tf = copyFixture(TINY_TF, "tf");
  expect((await cli("init", "--no-hooks", "--root", tf)).code).toBe(0);
});

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe("query status", () => {
  test("a hit is found, in both a symbol and a file answer", async () => {
    const symbol = onlyJson(await cli("query", "Registry", "--json", "--root", ts));
    expect(symbol["status"]).toBe("found");
    expect(symbol["message"]).toBeUndefined();
    expect(symbol["suggestions"]).toBeUndefined();

    const file = onlyJson(await cli("query", "packages/core/src/retry.ts", "--json", "--root", ts));
    expect(file["status"]).toBe("found");
  });

  test("a typo is absent and the text error no longer suggests an update", async () => {
    const json = await cli("query", "Regsitry", "--json", "--root", ts);
    expect(json.code).toBe(1);
    const result = onlyJson(json);
    expect(result["status"]).toBe("absent");
    expect(result["matches"]).toEqual([]);
    expect(String(result["message"])).not.toContain("greplost update");

    const human = await cli("query", "Regsitry", "--root", ts);
    expect(human.code).toBe(1);
    expect(human.stderr).not.toContain("greplost update");
    expect(human.stderr).toContain("Regsitry");
  });

  test("a path that is on disk and excluded by config names the pattern and the config line", async () => {
    writeFileSync(path.join(ts, "packages/core/src/retry.test.ts"), "export const x = 1;\n");
    const run = await cli("query", "packages/core/src/retry.test.ts", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(result["status"]).toBe("excluded");
    expect(result["excludedBy"]).toBe("**/*.test.*");
    expect(String(result["message"])).toContain(".greplost/config.json");
    expect(String(result["message"])).not.toContain("greplost update");

    const human = await cli("query", "packages/core/src/retry.test.ts", "--root", ts);
    expect(human.stderr).toContain("**/*.test.*");
    expect(human.stderr).not.toContain("greplost update");
  });

  test("a file written after the map is stale and says to run an update", async () => {
    writeFileSync(path.join(ts, "packages/core/src/brand-new.ts"), "export const brandNew = 1;\n");
    const run = await cli("query", "packages/core/src/brand-new.ts", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(result["status"]).toBe("stale");
    expect(String(result["message"])).toContain("greplost update");

    const human = await cli("query", "packages/core/src/brand-new.ts", "--root", ts);
    expect(human.stderr).toContain("greplost update");
  });

  test("an indexed file whose bytes changed since the map is stale and still answers", async () => {
    const fresh = copyFixture(TINY_TS, "stale");
    expect((await cli("init", "--no-hooks", "--root", fresh)).code).toBe(0);
    writeFileSync(path.join(fresh, "packages/core/src/retry.ts"), "export const retry = 1;\n");

    const run = await cli("query", "packages/core/src/retry.ts", "--json", "--root", fresh);
    expect(run.code).toBe(0);
    const result = onlyJson(run);
    expect(result["status"]).toBe("stale");
    expect(result["file"]).toBeDefined();
    expect(String(result["message"])).toContain("greplost update");
  });

  /** Fix round 1, I1: the map holds it, the disk does not. */
  test("a file deleted from disk but still in the map is stale, not found", async () => {
    const fresh = copyFixture(TINY_TS, "deleted");
    expect((await cli("init", "--no-hooks", "--root", fresh)).code).toBe(0);
    rmSync(path.join(fresh, "packages/core/src/retry.ts"));

    const run = await cli("query", "packages/core/src/retry.ts", "--json", "--root", fresh);
    const result = onlyJson(run);
    expect(result["status"]).toBe("stale");
    expect(String(result["message"])).toContain("no longer on disk");
    expect(String(result["message"])).toContain("greplost update");
    // The map still answers: the point is that the answer is labelled.
    expect(result["file"]).toBeDefined();
  });

  /** Fix round 1: a symbol answer is as stale as the file it was read from. */
  test("a symbol whose declaring file has changed is stale", async () => {
    const fresh = copyFixture(TINY_TS, "symbol-stale");
    expect((await cli("init", "--no-hooks", "--root", fresh)).code).toBe(0);

    const before = onlyJson(await cli("query", "Registry", "--json", "--root", fresh));
    expect(before["status"]).toBe("found");

    writeFileSync(path.join(fresh, "packages/core/src/registry.ts"), "export class Registry {}\n");
    const after = onlyJson(await cli("query", "Registry", "--json", "--root", fresh));
    expect(after["status"]).toBe("stale");
    expect(String(after["message"])).toContain("packages/core/src/registry.ts");
    expect(String(after["message"])).toContain("greplost update");
    expect((after["matches"] as unknown[]).length).toBe(1);
  });

  /** Fix round 1: discovery never follows symlinks, so an update cannot help. */
  test("a symlink is absent and says symlinks are not indexed", async () => {
    symlinkSync(
      path.join(ts, "packages/core/src/retry.ts"),
      path.join(ts, "packages/core/src/retry-link.ts"),
    );
    const run = await cli("query", "packages/core/src/retry-link.ts", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(result["status"]).toBe("absent");
    expect(String(result["message"])).toContain("symlink");
    expect(String(result["message"])).not.toContain("greplost update");
  });

  test("a path outside every language the map indexes is reported without an update hint", async () => {
    const run = await cli("query", "package.json", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(result["status"]).toBe("excluded");
    expect(String(result["message"])).toContain("languages");
    expect(String(result["message"])).not.toContain("greplost update");
  });
});

describe("query suggestions", () => {
  test("a wrong node kind suggests the id the map actually holds", async () => {
    const run = await cli("query", "main.tf#job.aws_vpc.main", "--json", "--root", tf);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    const suggestions = result["suggestions"] as string[];
    expect(suggestions).toContain("main.tf#resource.aws_vpc.main");
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  test("a misspelled symbol suggests the declaration id, deterministically", async () => {
    const first = onlyJson(await cli("query", "Regsitry", "--json", "--root", ts));
    const second = onlyJson(await cli("query", "Regsitry", "--json", "--root", ts));
    expect(first["suggestions"]).toEqual(second["suggestions"]);
    expect(first["suggestions"]).toContain("packages/core/src/registry.ts#Registry");
  });

  test("a misspelled path suggests the file the map holds", async () => {
    const result = onlyJson(await cli("query", "packages/core/src/regisry.ts", "--json", "--root", ts));
    expect(result["suggestions"]).toContain("packages/core/src/registry.ts");
  });

  test("the text miss prints the suggestions under the error", async () => {
    const run = await cli("query", "Regsitry", "--root", ts);
    expect(run.stderr).toContain("packages/core/src/registry.ts#Registry");
  });
});

describe("query directories", () => {
  test("a directory holding mapped files lists them with the file envelope", async () => {
    const run = await cli("query", "packages/core/src", "--json", "--root", ts);
    expect(run.code).toBe(0);
    const result = onlyJson(run);
    expect(result["status"]).toBe("found");
    const directory = result["directory"] as { path: string; files: Array<Record<string, unknown>> };
    expect(directory.path).toBe("packages/core/src");
    expect(directory.files.map((f) => f["path"])).toContain("packages/core/src/retry.ts");
    const entry = directory.files.find((f) => f["path"] === "packages/core/src/retry.ts") as Record<
      string,
      unknown
    >;
    expect(Object.keys(entry).sort()).toEqual(["exports", "fanIn", "fanOut", "loc", "path"]);
    expect(typeof entry["loc"]).toBe("number");
    expect(typeof entry["exports"]).toBe("number");
    // Sorted, like every other list the CLI prints.
    const paths = directory.files.map((f) => String(f["path"]));
    expect([...paths].sort()).toEqual(paths);
  });

  test("a trailing slash and a nested directory both resolve", async () => {
    const slash = onlyJson(await cli("query", "packages/core/src/", "--json", "--root", ts));
    expect((slash["directory"] as { path: string }).path).toBe("packages/core/src");

    const nested = onlyJson(await cli("query", "packages", "--json", "--root", ts));
    const files = (nested["directory"] as { files: unknown[] }).files;
    expect(files.length).toBeGreaterThan(5);
  });

  test("a Go package directory lists its files", async () => {
    const result = onlyJson(await cli("query", "internal/store", "--json", "--root", go));
    const directory = result["directory"] as { files: Array<{ path: string }> };
    expect(directory.files.map((f) => f.path)).toContain("internal/store/store.go");
  });

  test("human output is a sorted table of the directory's files", async () => {
    const run = await cli("query", "packages/core/src", "--root", ts);
    expect(run.code).toBe(0);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toBe("packages/core/src");
    expect(run.stdout).toMatch(/FILE +LOC +EXPORTS +FAN-IN +FAN-OUT/);
    expect(run.stdout).toContain("packages/core/src/retry.ts");
    for (const line of lines) expect(line).not.toMatch(/\s$/);
  });

  test("a directory that is nowhere at all is absent", async () => {
    const run = await cli("query", "packages/core/nope", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(result["directory"]).toBeUndefined();
    expect(result["status"]).toBe("absent");
  });

  /**
   * Fix round 1, C1. A directory on disk that the map holds nothing under used
   * to be handed to the *file* classifier, which answered "outside the
   * languages this map indexes" while listing that very language, and set
   * `excluded` with no pattern to name. A directory is classified from the
   * files under it or not at all.
   */
  test("a directory on disk whose files are all excluded says so, and names the pattern", async () => {
    const dir = path.join(ts, "packages/core/test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "registry.test.ts"), "export const t = 1;\n");
    writeFileSync(path.join(dir, "retry.test.ts"), "export const t = 2;\n");

    const run = await cli("query", "packages/core/test", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(result["directory"]).toBeUndefined();
    expect(result["status"]).toBe("excluded");
    expect(result["excludedBy"]).toBe("**/*.test.*");
    expect(String(result["message"])).toContain(".greplost/config.json");
    expect(String(result["message"])).not.toContain("greplost update");
    expect(String(result["message"])).not.toContain("languages");
  });

  test("a directory on disk that the map has not indexed yet is stale", async () => {
    const dir = path.join(ts, "packages/core/src/pgmq2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "client.ts"), "export const client = 1;\n");

    const run = await cli("query", "packages/core/src/pgmq2", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(result["status"]).toBe("stale");
    expect(String(result["message"])).toContain("greplost update");
    expect(result["excludedBy"]).toBeUndefined();
  });

  /**
   * Fix round 2. An update cannot index a language the config does not list, so
   * a directory of documentation is `excluded` and says which languages the map
   * does index, never `stale`.
   */
  test("a directory of files in no indexed language is excluded, by language", async () => {
    const dir = path.join(ts, "packages/core/docs");
    mkdirSync(dir, { recursive: true });
    for (const name of ["overview.md", "adr-1.md", "adr-2.md"]) {
      writeFileSync(path.join(dir, name), "# heading\n");
    }

    const run = await cli("query", "packages/core/docs", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(result["status"]).toBe("excluded");
    expect(result["excludedBy"]).toBe("languages");
    const message = String(result["message"]);
    expect(message).toContain("holds 3 files");
    expect(message).toContain("none in an indexed language");
    expect(message).toContain("ts, tsx, js, jsx");
    expect(message).toContain(".greplost/config.json");
    expect(message).not.toContain("greplost update");
  });

  test("a directory mixing documentation with one unmapped source file is stale", async () => {
    const dir = path.join(ts, "packages/core/mixed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "notes.md"), "# notes\n");
    writeFileSync(path.join(dir, "helper.ts"), "export const helper = 1;\n");

    const result = onlyJson(await cli("query", "packages/core/mixed", "--json", "--root", ts));
    expect(result["status"]).toBe("stale");
    expect(result["excludedBy"]).toBeUndefined();
    expect(String(result["message"])).toContain("greplost update");
  });

  test("a directory mixing documentation with an excluded test names the pattern", async () => {
    const dir = path.join(ts, "packages/core/mixed-tests");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "notes.md"), "# notes\n");
    writeFileSync(path.join(dir, "helper.test.ts"), "export const helper = 1;\n");

    const result = onlyJson(await cli("query", "packages/core/mixed-tests", "--json", "--root", ts));
    expect(result["status"]).toBe("excluded");
    expect(result["excludedBy"]).toBe("**/*.test.*");
  });

  test("an empty directory on disk is absent, not stale", async () => {
    mkdirSync(path.join(ts, "packages/core/src/hollow"), { recursive: true });
    const result = onlyJson(await cli("query", "packages/core/src/hollow", "--json", "--root", ts));
    expect(result["status"]).toBe("absent");
    expect(String(result["message"])).not.toContain("greplost update");
  });

  test("`.` and `./` both name the repo root", async () => {
    const dot = onlyJson(await cli("query", ".", "--json", "--root", ts));
    const slash = onlyJson(await cli("query", "./", "--json", "--root", ts));
    expect((dot["directory"] as { path: string }).path).toBe(".");
    expect(slash["directory"]).toEqual(dot["directory"] as unknown as Record<string, unknown>);
  });
});

/**
 * Fix round 2: leaf 2.14's shapes reach the CLI. A caller is a site, not a
 * name, and a class member's visibility is its own field rather than something
 * a reader infers from `exported`.
 */
describe("callers and visibility", () => {
  test("a caller is an object with its line and confidence", async () => {
    const result = onlyJson(await cli("query", "retry", "--json", "--root", ts));
    const matches = result["matches"] as Array<Record<string, unknown>>;
    const retry = matches.find((m) => m["id"] === "packages/core/src/retry.ts#retry") as Record<
      string,
      unknown
    >;
    const callers = retry["callers"] as Array<Record<string, unknown>>;
    expect(callers.length).toBeGreaterThan(0);
    expect(Object.keys(callers[0] as Record<string, unknown>).sort()).toEqual([
      "confidence",
      "from",
      "line",
    ]);
    expect(callers.map((c) => c["from"])).toEqual([
      "packages/adapters/src/sqs.ts#SqsAdapter.publish",
      "packages/core/src/registry.ts#Registry.publishAll",
    ]);
    for (const caller of callers) {
      expect(typeof caller["line"]).toBe("number");
      // `high` when the callee resolved to one declaration, `med` through a
      // re-export chain; the tiny-ts fixture has one of each.
      expect(["high", "med"]).toContain(caller["confidence"] as string);
    }
  });

  test("the text mode prints each caller as from:line (confidence)", async () => {
    const run = await cli("query", "retry", "--root", ts);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/packages\/core\/src\/registry\.ts#Registry\.publishAll:\d+ \(high\)/);

    const brief = await cli("query", "retry", "--brief", "--root", ts);
    expect(brief.stdout).toMatch(/callers +\d+ callers?/);
  });

  test("visibility sits beside exported on every match that has one", async () => {
    const run = await cli("query", "Registry.register", "--json", "--root", ts);
    const matches = onlyJson(run)["matches"] as Array<Record<string, unknown>>;
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match["visibility"]).toBe("public");
      expect(match["exported"]).toBe(true);
    }
  });
});

describe("query cards and --brief", () => {
  test("card paths are prefixed with the map directory so they open unmodified", async () => {
    const result = onlyJson(await cli("query", "Registry", "--json", "--root", ts));
    const match = (result["matches"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(match["card"]).toBe(".greplost/packages/tiny__core/modules/src/registry.ts.md");

    const file = onlyJson(await cli("query", "packages/core/src/retry.ts", "--json", "--root", ts));
    expect((file["file"] as { card: string }).card).toBe(
      ".greplost/packages/tiny__core/modules/src/retry.ts.md",
    );

    const node = onlyJson(await cli("query", "main.tf#resource.aws_vpc.main", "--json", "--root", tf));
    expect((node["node"] as { card: string }).card.startsWith(".greplost/")).toBe(true);
  });

  test("--brief prints one importer count instead of the importer list", async () => {
    const full = await cli("query", "packages/core/src/types.ts", "--root", ts);
    expect(full.stdout).toContain("packages/core/src/bus.ts");

    const brief = await cli("query", "packages/core/src/types.ts", "--brief", "--root", ts);
    expect(brief.code).toBe(0);
    expect(brief.stdout).not.toContain("packages/core/src/bus.ts");
    expect(brief.stdout).toMatch(/importers +\d+ files?/);
  });

  test("--brief is a text-mode flag and leaves the JSON shape alone", async () => {
    const plain = onlyJson(await cli("query", "Registry", "--json", "--root", ts));
    const brief = onlyJson(await cli("query", "Registry", "--brief", "--json", "--root", ts));
    expect(brief).toEqual(plain);
  });
});

describe("impact counts", () => {
  test("--json carries returned and truncated beside the unbounded radius", async () => {
    const full = onlyJson(await cli("impact", "packages/core/src/retry.ts", "--json", "--root", ts));
    expect(Object.keys(full).sort()).toEqual(["files", "path", "radius", "returned", "truncated"]);
    expect(full["truncated"]).toBe(false);
    expect(full["returned"]).toBe((full["files"] as unknown[]).length);

    const capped = onlyJson(
      await cli("impact", "packages/core/src/retry.ts", "--depth", "1", "--json", "--root", ts),
    );
    expect(capped["radius"]).toBe(6);
    expect(capped["returned"]).toBe(2);
    expect(capped["truncated"]).toBe(true);
  });

  test("the text mode says the listing was bounded, never the radius", async () => {
    const run = await cli("impact", "packages/core/src/retry.ts", "--depth", "1", "--root", ts);
    expect(run.stdout).toContain("2 of 6 listed");
    expect(run.stdout).toContain("--depth bounds the listing, never the radius");

    const full = await cli("impact", "packages/core/src/retry.ts", "--root", ts);
    expect(full.stdout).not.toContain("listed;");
  });

  test("a node target carries the same two counts", async () => {
    const result = onlyJson(
      await cli("impact", "main.tf#resource.aws_vpc.main", "--json", "--root", tf),
    );
    expect(Object.keys(result).sort()).toEqual(["nodes", "path", "radius", "returned", "truncated"]);
    expect(result["truncated"]).toBe(false);
  });

  /**
   * Fix round 1: `--json` answers in JSON even when it cannot answer. Prose on
   * stderr forces a caller that asked for JSON to parse English to find out
   * whether the map was stale or the path was a typo.
   */
  test("a miss under --json is a JSON envelope with a status, not prose", async () => {
    const run = await cli("impact", "packages/core/src/never.ts", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(Object.keys(result).sort()).toEqual(["message", "path", "status", "suggestions"]);
    expect(result["status"]).toBe("absent");
    expect(result["path"]).toBe("packages/core/src/never.ts");
    expect(String(result["message"])).not.toContain("greplost update");

    writeFileSync(path.join(ts, "packages/core/src/impact-new.ts"), "export const n = 1;\n");
    const stale = onlyJson(await cli("impact", "packages/core/src/impact-new.ts", "--json", "--root", ts));
    expect(stale["status"]).toBe("stale");
    expect(String(stale["message"])).toContain("greplost update");
  });

  test("a miss uses the same status language as query", async () => {
    writeFileSync(path.join(ts, "packages/core/src/added-later.ts"), "export const later = 1;\n");
    const stale = await cli("impact", "packages/core/src/added-later.ts", "--root", ts);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("greplost update");

    const absent = await cli("impact", "packages/core/src/never.ts", "--root", ts);
    expect(absent.code).toBe(1);
    expect(absent.stderr).not.toContain("greplost update");
  });
});

describe("help", () => {
  test("help query lists the node kinds and the id shape", async () => {
    const run = await cli("help", "query");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("<file>#<kind>.<name>");
    for (const kind of ["resource", "job", "step", "stage", "route"]) {
      expect(run.stdout).toContain(kind);
    }
  });

  test("help impact says depth bounds the listing and never the radius", async () => {
    const run = await cli("help", "impact");
    expect(run.stdout).toContain("--depth bounds the listing, never the radius");
  });

  test("help prints the default exclude patterns", async () => {
    const run = await cli("--help");
    expect(run.stdout).toContain("**/*_test.go");
    expect(run.stdout).toContain(".greplost/config.json");
  });
});
