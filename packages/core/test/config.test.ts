import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, validateConfig } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "greplost-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(dir: string, contents: string): void {
  mkdirSync(join(dir, ".greplost"), { recursive: true });
  writeFileSync(join(dir, ".greplost", "config.json"), contents);
}

describe("loadConfig", () => {
  test("returns DEFAULT_CONFIG when no config file exists", () => {
    const dir = tempDir();
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  test("does not return a shared reference to DEFAULT_CONFIG", () => {
    const dir = tempDir();
    const loaded = loadConfig(dir);
    loaded.include.push("mutated/**");
    expect(DEFAULT_CONFIG.include).not.toContain("mutated/**");
  });

  test("merges provided fields over DEFAULT_CONFIG; a provided array replaces the default array", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify({ include: ["src/**"], languages: ["go"] }));

    const cfg = loadConfig(dir);
    expect(cfg.include).toEqual(["src/**"]);
    expect(cfg.languages).toEqual(["go"]);
    expect(cfg.exclude).toEqual(DEFAULT_CONFIG.exclude);
    expect(cfg.diagram).toEqual(DEFAULT_CONFIG.diagram);
    expect(cfg.packages).toEqual(DEFAULT_CONFIG.packages);
    expect(cfg.semantic).toEqual(DEFAULT_CONFIG.semantic);
  });

  test("merges nested diagram/packages/semantic fields individually", () => {
    const dir = tempDir();
    writeConfig(
      dir,
      JSON.stringify({
        diagram: { maxNodes: 10 },
        packages: { roots: ["libs/*"] },
        semantic: { enabled: false },
      }),
    );

    const cfg = loadConfig(dir);
    expect(cfg.diagram).toEqual({ maxNodes: 10, splitBy: "directory" });
    expect(cfg.packages).toEqual({ roots: ["libs/*"] });
    expect(cfg.semantic).toEqual({ enabled: false, model: DEFAULT_CONFIG.semantic.model });
  });

  test("strips a UTF-8 BOM before parsing", () => {
    const dir = tempDir();
    writeConfig(dir, "﻿" + JSON.stringify({ include: ["only/**"] }));

    const cfg = loadConfig(dir);
    expect(cfg.include).toEqual(["only/**"]);
  });

  test("throws greplost: invalid config: ... on malformed JSON", () => {
    const dir = tempDir();
    writeConfig(dir, "{ not valid json");

    expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
  });

  test("throws on a non-object top-level value", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify(["not", "an", "object"]));

    expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
  });

  test("throws on a primitive top-level value", () => {
    for (const value of ['"hello"', "42", "true"]) {
      const dir = tempDir();
      writeConfig(dir, value);
      expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
    }
  });

  test("throws when diagram/packages/semantic are null instead of an object", () => {
    for (const field of ["diagram", "packages", "semantic"]) {
      const dir = tempDir();
      writeConfig(dir, JSON.stringify({ [field]: null }));
      expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
    }
  });

  test("throws when include/exclude are not arrays of strings", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify({ include: "src/**" }));
    expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
  });

  test("throws when include contains a non-string element", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify({ include: ["src/**", 42] }));
    expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
  });

  test("throws when languages contains an unknown value", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify({ languages: ["ts", "cobol"] }));
    expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
  });

  test("accepts every known Lang value in languages", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify({ languages: ["ts", "tsx", "js", "jsx", "go"] }));
    const cfg = loadConfig(dir);
    expect(cfg.languages).toEqual(["ts", "tsx", "js", "jsx", "go"]);
  });

  test("throws when diagram.maxNodes is not a positive integer", () => {
    const dir = tempDir();
    for (const bad of [0, -1, 1.5, "10", null]) {
      const dir2 = tempDir();
      writeConfig(dir2, JSON.stringify({ diagram: { maxNodes: bad } }));
      expect(() => loadConfig(dir2)).toThrow(/^greplost: invalid config: /);
    }
    // also verify a valid positive integer is accepted
    writeConfig(dir, JSON.stringify({ diagram: { maxNodes: 5 } }));
    expect(loadConfig(dir).diagram.maxNodes).toBe(5);
  });

  test("throws when diagram.splitBy is not 'directory'", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify({ diagram: { splitBy: "package" } }));
    expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
  });

  test("throws when semantic.enabled is not a boolean", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify({ semantic: { enabled: "yes" } }));
    expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
  });

  test("throws when semantic.model is not a string", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify({ semantic: { model: 42 } }));
    expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
  });

  test("throws when packages.roots is not an array of strings", () => {
    const dir = tempDir();
    writeConfig(dir, JSON.stringify({ packages: { roots: [1, 2] } }));
    expect(() => loadConfig(dir)).toThrow(/^greplost: invalid config: /);
  });

  test("validateConfig(undefined) returns the default config", () => {
    expect(validateConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  test("validateConfig validates and merges a plain object directly, without touching the filesystem", () => {
    const cfg = validateConfig({ languages: ["js"] });
    expect(cfg.languages).toEqual(["js"]);
    expect(cfg.include).toEqual(DEFAULT_CONFIG.include);
  });

  test("validateConfig rejects a non-object value", () => {
    expect(() => validateConfig("nope")).toThrow(/^greplost: invalid config: /);
    expect(() => validateConfig(null)).not.toThrow();
    expect(validateConfig(null)).toEqual(DEFAULT_CONFIG);
  });
});

describe("signals", () => {
  test("a signals list is read from the config, deduplicated and sorted", () => {
    const config = validateConfig({ signals: ["tanstack", "react", "react"] });
    expect(config.signals).toEqual(["react", "tanstack"]);
  });

  test("absent signals stays undefined so every applicable pass runs", () => {
    expect(validateConfig({}).signals).toBeUndefined();
  });

  test("an unknown signal pass is rejected by name", () => {
    expect(() => validateConfig({ signals: ["angular"] })).toThrow(/unknown signal pass "angular"/);
  });
});
