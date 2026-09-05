/**
 * The plugin's agent-facing documentation against the code it describes
 * (leaf 2.12, review round 1, I2 and I3).
 *
 * `greplost-plugin/skills/greplost/SKILL.md` is a contract with a reader that
 * cannot check it: an agent reads the skill, believes it, and asks the CLI for a
 * `values-ref` edge that no schema has ever had. Prose drifts from code silently,
 * and the only defence is a test that reads both.
 *
 * These tests are deliberately narrow. They check the vocabulary the skill names
 * (reference kinds, JSON keys) against the schema and the command modules; they
 * do not check the English around it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

function read(...parts: string[]): string {
  return readFileSync(path.join(REPO_ROOT, ...parts), "utf8");
}

const SKILL = read("greplost-plugin", "skills", "greplost", "SKILL.md");
const SCHEMA = read("packages", "core", "src", "schema.ts");

/** The `RefKind` union members, read out of the schema rather than restated. */
function refKinds(): string[] {
  const declaration = /export type RefKind =([\s\S]*?);/.exec(SCHEMA);
  if (declaration === null) throw new Error("schema.ts no longer declares `export type RefKind`");
  return [...declaration[1]!.matchAll(/"([^"]+)"/g)].map((hit) => hit[1] as string).sort();
}

/** Every backticked token in the skill that looks like a reference kind. */
function namedRefKinds(): string[] {
  const paragraph = /reference edges\s*\n?\(([^)]*)\)/.exec(SKILL);
  if (paragraph === null) throw new Error("the skill no longer lists the reference kinds");
  return [...paragraph[1]!.matchAll(/`([^`]+)`/g)].map((hit) => hit[1] as string);
}

describe("plugin skill", () => {
  test("every reference kind the skill names is a RefKind the schema declares", () => {
    const declared = new Set(refKinds());
    const named = namedRefKinds();
    expect(named.length).toBeGreaterThan(0);
    for (const kind of named) expect([kind, declared.has(kind)]).toEqual([kind, true]);
  });

  test("the schema's reference kinds are the ones the map actually writes", () => {
    // A guard on the guard: if `RefKind` is ever renamed or emptied, the test
    // above would pass vacuously.
    expect(refKinds()).toContain("helm-values");
    expect(refKinds()).not.toContain("values-ref");
  });

  test("the skill documents both `impact --json` shapes, the file one and the node one", () => {
    const impact = read("packages", "cli", "src", "commands", "impact.ts");
    // The two interfaces the command really returns.
    expect(impact).toContain("export interface ImpactFiles");
    expect(impact).toContain("export interface ImpactNodes");
    // A file target lists `files`; a node target lists `nodes`. The skill must
    // say both, because its own example passes a node id.
    expect(SKILL).toContain('"files"');
    expect(SKILL).toContain('"nodes"');
    expect(SKILL).toMatch(/node id[\s\S]{0,400}"nodes"/);
  });

  test("the node id shape in the skill is the one the schema builds", () => {
    expect(SKILL).toContain("<file>#<kind>.<name>");
    expect(SCHEMA).toContain("`${file}#${kind}.${name}`");
  });
});

describe("plugin commands and agent", () => {
  const surfaces = [
    ["greplost-plugin", "agents", "greplost-navigator.md"],
    ["greplost-plugin", "commands", "query.md"],
    ["greplost-plugin", "commands", "impact.md"],
  ] as const;

  test("every surface an agent reads mentions node ids", () => {
    for (const surface of surfaces) {
      const text = read(...surface);
      expect([surface.join("/"), text.includes("<file>#<kind>.<name>")]).toEqual([surface.join("/"), true]);
    }
  });
});
