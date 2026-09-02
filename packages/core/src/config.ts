/**
 * .greplost/config.json loading and validation (tech spec Appendix B).
 *
 * `loadConfig` reads the file (if present), strips a UTF-8 BOM, parses it as
 * JSON, and delegates shape validation and defaulting to `validateConfig`.
 * Every field is optional in the file; anything omitted falls back to
 * `DEFAULT_CONFIG` field by field. A provided array replaces the default
 * array wholesale (arrays are never merged element-wise).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS, DEFAULT_CONFIG } from "./schema.ts";
import type { DiagramConfig, GreplostConfig, Lang } from "./schema.ts";

const KNOWN_LANGS: ReadonlySet<string> = new Set<Lang>(["ts", "tsx", "js", "jsx", "go"]);

function invalid(what: string): never {
  throw new Error(`greplost: invalid config: ${what}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig(config: GreplostConfig): GreplostConfig {
  return {
    include: [...config.include],
    exclude: [...config.exclude],
    languages: [...config.languages],
    diagram: { ...config.diagram },
    packages: { roots: [...config.packages.roots] },
    semantic: { ...config.semantic },
  };
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    invalid(`"${field}" must be an array of strings`);
  }
  return value as string[];
}

function validateLanguages(value: unknown): Lang[] {
  const arr = validateStringArray(value, "languages");
  for (const lang of arr) {
    if (!KNOWN_LANGS.has(lang)) invalid(`"languages" contains unknown language "${lang}"`);
  }
  return arr as Lang[];
}

function validateDiagram(value: unknown, base: DiagramConfig): DiagramConfig {
  if (!isPlainObject(value)) invalid('"diagram" must be an object');
  const result = { ...base };
  if ("maxNodes" in value) {
    const maxNodes = value.maxNodes;
    if (typeof maxNodes !== "number" || !Number.isInteger(maxNodes) || maxNodes <= 0) {
      invalid('"diagram.maxNodes" must be a positive integer');
    }
    result.maxNodes = maxNodes;
  }
  if ("splitBy" in value) {
    if (value.splitBy !== "directory") invalid('"diagram.splitBy" must be "directory"');
    result.splitBy = value.splitBy;
  }
  return result;
}

function validatePackages(value: unknown, base: { roots: string[] }): { roots: string[] } {
  if (!isPlainObject(value)) invalid('"packages" must be an object');
  const result = { roots: [...base.roots] };
  if ("roots" in value) result.roots = validateStringArray(value.roots, "packages.roots");
  return result;
}

function validateSemantic(
  value: unknown,
  base: { enabled: boolean; model: string },
): { enabled: boolean; model: string } {
  if (!isPlainObject(value)) invalid('"semantic" must be an object');
  const result = { ...base };
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") invalid('"semantic.enabled" must be a boolean');
    result.enabled = value.enabled;
  }
  if ("model" in value) {
    if (typeof value.model !== "string") invalid('"semantic.model" must be a string');
    result.model = value.model;
  }
  return result;
}

/**
 * Validate an arbitrary parsed value against the GreplostConfig shape and
 * merge it over DEFAULT_CONFIG field by field. `undefined` and `null` mean
 * "no overrides" and return a fresh copy of DEFAULT_CONFIG. Throws
 * `Error("greplost: invalid config: <what>")` on any other bad shape.
 */
export function validateConfig(value: unknown): GreplostConfig {
  if (value === undefined || value === null) return cloneConfig(DEFAULT_CONFIG);
  if (!isPlainObject(value)) invalid("config must be a JSON object");

  const result = cloneConfig(DEFAULT_CONFIG);

  if ("include" in value) result.include = validateStringArray(value.include, "include");
  if ("exclude" in value) result.exclude = validateStringArray(value.exclude, "exclude");
  if ("languages" in value) result.languages = validateLanguages(value.languages);
  if ("diagram" in value) result.diagram = validateDiagram(value.diagram, DEFAULT_CONFIG.diagram);
  if ("packages" in value) result.packages = validatePackages(value.packages, DEFAULT_CONFIG.packages);
  if ("semantic" in value) result.semantic = validateSemantic(value.semantic, DEFAULT_CONFIG.semantic);

  return result;
}

/**
 * Load `<root>/.greplost/config.json` (JSON only, a leading UTF-8 BOM is
 * stripped) and merge it over DEFAULT_CONFIG. Returns a fresh copy of
 * DEFAULT_CONFIG when the file is absent.
 */
export function loadConfig(root: string): GreplostConfig {
  const configPath = join(root, ARTIFACT_DIR, ARTIFACT_PATHS.config);
  if (!existsSync(configPath)) return validateConfig(undefined);

  let raw = readFileSync(configPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid(`${ARTIFACT_DIR}/${ARTIFACT_PATHS.config} is not valid JSON`);
  }

  return validateConfig(parsed);
}
