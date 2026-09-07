/**
 * `query` and `impact` ergonomics (leaf 2.15, PLAN "Build 2.1").
 *
 * The evaluation on anyq lost four navigation turns to the same three gaps: a
 * directory argument was answered with "run `greplost update`", a file the
 * config excludes looked exactly like a typo, and a wrong node kind got no
 * suggestion. Each test below is one of those turns, run against a fixture.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("a directory the map does not hold falls through to the miss ladder", async () => {
    const run = await cli("query", "packages/core/nope", "--json", "--root", ts);
    expect(run.code).toBe(1);
    const result = onlyJson(run);
    expect(result["directory"]).toBeUndefined();
    expect(result["status"]).toBe("absent");
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
