/**
 * tsconfig `baseUrl` / `paths` lookup (core-extract spec, "Resolution rules", step 2).
 *
 * Pure: every read goes through the caller's `readFile`, so an in-memory repo
 * behaves exactly like a checkout. The resolver caches the result per directory.
 *
 * Semantics follow tsc:
 *  - the nearest `tsconfig.json` upward from the importing file wins;
 *  - `extends` is followed first, so a derived option overrides the base one, and
 *    an object option (`paths`) replaces the base object rather than merging into it;
 *  - `baseUrl` is resolved against the directory of the file that declares it;
 *  - `paths` declared without any `baseUrl` in the chain are resolved against the
 *    directory of the file that declares them.
 */

export interface TsPaths {
  /** Repo-relative directory the `paths` mappings are resolved against ("" = repo root). */
  baseUrl: string;
  /**
   * `paths` as written, except that a `${configDir}` mapping is already substituted
   * and rewritten to a repo-root-relative form (a leading "/"), since such a mapping
   * is deliberately independent of `baseUrl`.
   */
  paths: Record<string, string[]>;
}

/** tsconfig 5.5 template variable: the directory of the config actually in use. */
const CONFIG_DIR = "${configDir}";

type ReadFile = (rel: string) => string | null;

interface Declared<T> {
  /** Directory of the tsconfig file that declared the value. */
  dir: string;
  value: T;
}

interface Options {
  baseUrl?: Declared<string>;
  paths?: Declared<Record<string, string[]>>;
}

/**
 * `baseUrl`/`paths` in force for `fromFile`, or null when no tsconfig up the tree
 * declares either. `root` is accepted for symmetry with the other resolve entry
 * points; all reads are repo-relative and go through `readFile`.
 */
export function loadTsconfigPaths(root: string, fromFile: string, readFile: ReadFile): TsPaths | null {
  void root;
  let dir = parentDir(normalizeRelative(fromFile));
  for (;;) {
    const configPath = joinRelative(dir, "tsconfig.json");
    if (readFile(configPath) !== null) return compile(configPath, readFile);
    if (dir === "") return null;
    dir = parentDir(dir);
  }
}

function compile(configPath: string, readFile: ReadFile): TsPaths | null {
  const options = loadOptions(configPath, readFile, new Set<string>());
  if (!options.baseUrl && !options.paths) return null;

  // `${configDir}` names the directory of the config the compiler loaded, not of
  // the (possibly extended) file that spelled the option out.
  const configDir = parentDir(configPath);
  const baseUrl = options.baseUrl
    ? resolveDeclared(options.baseUrl, configDir)
    : (options.paths?.dir ?? "");
  if (baseUrl === null) return null;

  const paths: Record<string, string[]> = {};
  for (const [key, mappings] of Object.entries(options.paths?.value ?? {})) {
    paths[key] = mappings.map((mapping) => {
      if (!mapping.includes(CONFIG_DIR)) return mapping;
      const substituted = normalizeJoin("", mapping.replaceAll(CONFIG_DIR, configDir || "."));
      return substituted === null ? mapping : `/${substituted}`;
    });
  }
  return { baseUrl, paths };
}

/** A declared directory option, resolved against its declaring file or `${configDir}`. */
function resolveDeclared(declared: Declared<string>, configDir: string): string | null {
  if (declared.value.includes(CONFIG_DIR)) {
    return normalizeJoin("", declared.value.replaceAll(CONFIG_DIR, configDir || "."));
  }
  return normalizeJoin(declared.dir, declared.value);
}

function loadOptions(configPath: string, readFile: ReadFile, visited: Set<string>): Options {
  if (visited.has(configPath)) return {};
  visited.add(configPath);

  const text = readFile(configPath);
  if (text === null) return {};
  const json = parseJsonc(text);
  if (!json) return {};

  const dir = parentDir(configPath);
  const options: Options = {};

  // Bases first: a derived option overrides the one it inherits.
  for (const spec of extendsList(json["extends"])) {
    const basePath = resolveExtends(dir, spec, readFile);
    if (basePath === null) continue; // an unreadable package extends is ignored
    const base = loadOptions(basePath, readFile, visited);
    if (base.baseUrl) options.baseUrl = base.baseUrl;
    if (base.paths) options.paths = base.paths;
  }

  const compilerOptions = asObject(json["compilerOptions"]);
  if (compilerOptions) {
    const baseUrl = compilerOptions["baseUrl"];
    if (typeof baseUrl === "string") options.baseUrl = { dir, value: baseUrl };
    const paths = normalizePaths(compilerOptions["paths"]);
    if (paths) options.paths = { dir, value: paths };
  }
  return options;
}

function extendsList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return [];
}

/** Repo-relative path of an `extends` target, or null when it cannot be read. */
function resolveExtends(dir: string, spec: string, readFile: ReadFile): string | null {
  const specifier = spec.replace(/\\/g, "/");

  if (/^\.\.?(\/|$)/.test(specifier) || specifier.startsWith("/")) {
    const base = specifier.startsWith("/")
      ? normalizeJoin("", specifier.slice(1))
      : normalizeJoin(dir, specifier);
    if (base === null) return null;
    for (const candidate of fileCandidates(base, specifier)) {
      if (readFile(candidate) !== null) return candidate;
    }
    return null;
  }

  // A package extends: search node_modules upward from the declaring file.
  let current = dir;
  for (;;) {
    const nodeModules = joinRelative(current, "node_modules");
    for (const suffix of packageCandidates(specifier)) {
      const candidate = joinRelative(nodeModules, suffix);
      if (readFile(candidate) !== null) return candidate;
    }
    if (current === "") return null;
    current = parentDir(current);
  }
}

function fileCandidates(base: string, specifier: string): string[] {
  if (specifier.endsWith(".json")) return [base];
  return [base, `${base}.json`, joinRelative(base, "tsconfig.json")];
}

function packageCandidates(specifier: string): string[] {
  if (specifier.endsWith(".json")) return [specifier];
  return [specifier, `${specifier}.json`, `${specifier}/tsconfig.json`];
}

function normalizePaths(value: unknown): Record<string, string[]> | null {
  const object = asObject(value);
  if (!object) return null;
  const out: Record<string, string[]> = {};
  for (const [key, mappings] of Object.entries(object)) {
    if (typeof mappings === "string") out[key] = [mappings];
    else if (Array.isArray(mappings)) out[key] = mappings.filter((m): m is string => typeof m === "string");
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/** Parse a tsconfig: comments and trailing commas are common and must not throw. */
export function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stripTrailingCommas(stripJsonComments(stripBom(text))));
    return asObject(value);
  } catch {
    return null;
  }
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          out += next;
          i++;
        }
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // land on "/" so the loop's i++ moves past it
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          out += next;
          i++;
        }
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      const next = text[j];
      if (next === "}" || next === "]") continue; // drop the comma
    }
    out += ch;
  }
  return out;
}

/** A tsconfig written on Windows often starts with a byte order mark. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// path helpers (repo-relative, "" is the repo root)
// ---------------------------------------------------------------------------

function normalizeRelative(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function parentDir(p: string): string {
  const index = p.lastIndexOf("/");
  return index === -1 ? "" : p.slice(0, index);
}

function joinRelative(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** Join and normalise, returning null when the result escapes the repo root. */
function normalizeJoin(dir: string, rest: string): string | null {
  const segments: string[] = [];
  for (const segment of `${dir}/${rest}`.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}
