import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { Lang } from "@greplost/core/schema";
import { FIXTURES, fixtureNames } from "../src/fixtures.ts";
import { loadTruth, type TruthTarget } from "../src/truth/registry.ts";

const TRUTH_DIR = path.resolve(import.meta.dir, "..", "src", "truth");

/** Every truth target the registry is expected to resolve, sorted. */
const TARGETS: readonly TruthTarget[] = [
  "dockerfile",
  "go",
  "hcl",
  "java",
  "kotlin",
  "python",
  "rust",
  "signals-pulumi-go",
  "signals-ts",
  "ts",
  "yaml",
  "yaml-actions",
  "yaml-helm",
  "yaml-k8s",
];

describe("loadTruth", () => {
  test("resolves every truth target by convention", async () => {
    for (const target of TARGETS) {
      const mod = await loadTruth(target);
      expect(typeof mod.generateTruth, `${target}.generateTruth`).toBe("function");
    }
  });

  test("accepts the build-1 oracles under their own export names", async () => {
    // `truth/ts.ts` and `truth/go.ts` predate the convention and are owned by other leaves,
    // so the registry accepts `generateTsTruth`/`generateGoTruth` as well as `generateTruth`.
    const ts = await loadTruth("ts");
    const go = await loadTruth("go");
    expect(typeof ts.generateTruth).toBe("function");
    expect(typeof go.generateTruth).toBe("function");
  });

  test("an unimplemented oracle throws a sentence naming its file and its leaf", async () => {
    // `python` was the example here until leaf 2.1 implemented it; `java` is the next
    // still-stubbed one (leaf 2.5, wave 2). Each language leaf moves this to the next stub.
    const mod = await loadTruth("java");
    expect(() => mod.generateTruth("/repo", ["A.java"])).toThrow(
      /greplost: the java truth generator is not implemented yet .* build-2 leaf 2\.5/,
    );
  });

  test("an implemented oracle is reachable and discloses its notes", async () => {
    const mod = await loadTruth("python");
    expect(typeof mod.generateTruth).toBe("function");
    expect(mod.NOTES).toEqual([
      "ast-only",
      "no-import-execution",
      "pep420-namespace-packages",
      "python>=3.11",
    ]);
  });

  test("every truth module in the directory is reachable through the registry", async () => {
    const onDisk = (await readdir(TRUTH_DIR))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.slice(0, -3))
      // Not truth generators: the registry itself, and the two TypeScript helper modules
      // `truth/ts.ts` splits its work across.
      .filter((name) => !["registry", "ts-calls", "ts-workspace"].includes(name))
      .sort();
    expect(onDisk).toEqual([...TARGETS].sort());
  });

  test("the yaml dispatcher groups files by flavour", async () => {
    const { flavourOf, groupByFlavour } = await import("../src/truth/yaml.ts");
    expect(flavourOf(".github/workflows/ci.yml")).toBe("yaml-actions");
    expect(flavourOf("charts/app/Chart.yaml")).toBe("yaml-helm");
    expect(flavourOf("charts/app/templates/deploy.yaml")).toBe("yaml-helm");
    expect(flavourOf("manifests/deploy.yaml")).toBe("yaml-k8s");
    expect(groupByFlavour([".github/workflows/ci.yml", "deploy.yaml"])).toEqual([
      ["yaml-actions", [".github/workflows/ci.yml"]],
      ["yaml-k8s", ["deploy.yaml"]],
    ]);
  });
});

describe("missing module error", () => {
  test("names the module it expected instead of a bare module-not-found", async () => {
    await expect(loadTruth("ruby" as unknown as Lang)).rejects.toThrow(
      /greplost: no truth generator for "ruby" \(expected bench\/src\/truth\/ruby\.ts\)/,
    );
  });

  test("a module without a generator is reported by name", async () => {
    // `truth/ts-calls.ts` exists but is a helper, not an oracle: importing it succeeds and
    // the missing export is what must be reported.
    await expect(loadTruth("ts-calls" as unknown as Lang)).rejects.toThrow(
      /does not export generateTruth \(nor the build-1 name generateTsCallsTruth\)/,
    );
  });
});

describe("fixtures table", () => {
  test("has all 13 build-2 fixtures", () => {
    expect(fixtureNames()).toEqual(
      [
        "tiny-actions",
        "tiny-docker",
        "tiny-go",
        "tiny-helm",
        "tiny-java",
        "tiny-k8s",
        "tiny-kotlin",
        "tiny-pulumi-go",
        "tiny-python",
        "tiny-rust",
        "tiny-signals-ts",
        "tiny-terraform",
        "tiny-ts",
      ].sort(),
    );
  });

  test("every fixture has a language and a directory under fixtures/", () => {
    const langs = new Set<Lang>([
      "ts",
      "tsx",
      "js",
      "jsx",
      "go",
      "python",
      "rust",
      "java",
      "kotlin",
      "hcl",
      "yaml",
      "dockerfile",
    ]);
    for (const [name, entry] of Object.entries(FIXTURES)) {
      expect(langs.has(entry.lang), `${name} lang ${entry.lang}`).toBe(true);
      expect(entry.root.endsWith(path.join("fixtures", name)), `${name} root ${entry.root}`).toBe(true);
      expect(path.isAbsolute(entry.root), `${name} root is absolute`).toBe(true);
    }
  });

  test("every fixture has a truth generator it can be scored against", async () => {
    for (const [name, entry] of Object.entries(FIXTURES)) {
      const target: TruthTarget = ["ts", "tsx", "js", "jsx"].includes(entry.lang) ? "ts" : entry.lang;
      const mod = await loadTruth(target);
      expect(typeof mod.generateTruth, `${name} -> ${target}`).toBe("function");
    }
  });

  test("the build-1 fixtures exist on disk", () => {
    // Only these two: the build-2 fixture directories arrive with their language leaves, and
    // this table names them before they exist on purpose.
    for (const name of ["tiny-ts", "tiny-go"]) {
      expect(existsSync((FIXTURES[name] as { root: string }).root), name).toBe(true);
    }
  });
});
