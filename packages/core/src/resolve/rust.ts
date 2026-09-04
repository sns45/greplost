/**
 * Rust resolution and Rust call linking (spec 2026-09-04 section 1.3).
 *
 * Two jobs, both Rust-only:
 *
 *  1. `createRustResolver` turns a `use` path or a `mod` item into a **file**. Rust's module
 *     tree is a filesystem tree: the crate root is `src/lib.rs` or `src/main.rs` under the
 *     nearest `Cargo.toml` (plus every `[lib]`, `[[bin]]`, `[[example]]`, `[[bench]]` and
 *     `[[test]]` target path, and the auto-discovered `src/bin/*.rs`, `examples/*.rs`,
 *     `tests/*.rs`, `benches/*.rs`), and a module path walks from there to `<seg>.rs` or
 *     `<seg>/mod.rs`. `use <workspace member>::…` crosses to that member's crate root - crate
 *     names are matched with `-` normalised to `_`, because Cargo spells a name one way and
 *     Rust code spells it the other. Everything else is `ext:crate/<first segment>`.
 *
 *     A path is resolved by walking it as far as the filesystem goes and then falling back:
 *     `crate::store::Store` tries `store/Store` first and lands on `store`, because the tail of
 *     a `use` path names an item, not a module, and only the file system can say where the
 *     module part stops. A path that walks off the tree entirely lands on the crate root, which
 *     is where an item declared in an inline `mod` actually lives.
 *
 *  2. `buildRustCallIndex` / `resolveRustCall` implement spec 1.3's call rules. Everything
 *     ambiguous is dropped, never guessed; trait-dispatched calls (a method on a generic or
 *     `dyn` receiver) never reach here at all, because `extract/rust.ts` refuses to write down
 *     a callee whose receiver it cannot type.
 */

import type { CallSite, Confidence, FileRecord, ImportEdge } from "../schema.ts";
import { compareStrings, symbolId } from "../schema.ts";
import type { RepoContext, ResolvedTarget } from "./resolver.ts";

const UNRESOLVED: ResolvedTarget = { type: "unresolved" };
const MODULE_SEPARATOR = "::";
/** Externals are namespaced so a crate name can never collide with an npm package (spec 0.2). */
const CRATE_PREFIX = "crate/";

/** Directories cargo auto-discovers targets in, relative to a crate directory. */
const AUTO_TARGET_DIRS = ["src/bin", "examples", "tests", "benches"] as const;

// ---------------------------------------------------------------------------
// Cargo.toml
// ---------------------------------------------------------------------------

/** The handful of Cargo.toml facts the module tree needs. */
interface CargoManifest {
  /** `[package] name`, `-` normalised to `_`; "" when the manifest declares none. */
  name: string;
  /** `[lib] path`, `[[bin]] path`, `[[example]] path`, … relative to the manifest's directory. */
  targetPaths: string[];
  /** `[workspace] members`, as written (globs included). */
  members: string[];
}

/** Strip a `#` comment that is not inside a string. */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

/** Every quoted string in an array literal fragment. */
function arrayStrings(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'/gu)) out.push(match[1] ?? match[2] ?? "");
  return out;
}

/**
 * A deliberately small Cargo.toml reader: table headers plus `name`, `path` and `members`.
 *
 * A full TOML parser would be a dependency and a liability; every key this resolver reads is a
 * bare string or a string array, and a manifest it cannot understand degrades to "no crate
 * name, no explicit targets", which falls back on the conventional layout rather than guessing.
 */
function parseCargoManifest(text: string | null): CargoManifest {
  const manifest: CargoManifest = { name: "", targetPaths: [], members: [] };
  if (text === null) return manifest;

  let table = "";
  let membersOpen = false;
  let membersText = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (line === "") continue;

    if (membersOpen) {
      membersText += line;
      if (line.includes("]")) {
        manifest.members.push(...arrayStrings(membersText));
        membersOpen = false;
        membersText = "";
      }
      continue;
    }

    const header = /^\[\[?([^\]]+)\]\]?$/u.exec(line);
    if (header) {
      table = (header[1] ?? "").trim();
      continue;
    }

    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();

    if (table === "package" && key === "name") {
      manifest.name = unquote(value).replace(/-/gu, "_");
      continue;
    }
    if (table === "workspace" && key === "members") {
      if (value.includes("]")) manifest.members.push(...arrayStrings(value));
      else {
        membersOpen = true;
        membersText = value;
      }
      continue;
    }
    if (key !== "path") continue;
    if (table === "lib" || table === "bin" || table === "example" || table === "bench" || table === "test") {
      const path = unquote(value);
      if (path !== "") manifest.targetPaths.push(path);
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function join(dir: string, rest: string): string {
  if (rest === "") return dir;
  return dir === "" ? rest : `${dir}/${rest}`;
}

/** `a/b/c.rs` under `a` -> `b/c.rs`; null when `path` is not under `dir`. */
function relativeTo(dir: string, path: string): string | null {
  if (dir === "") return path;
  if (path === dir) return "";
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
}

/** The module name a file contributes: `a/b.rs` -> `b`, `a/b/mod.rs` -> `b`. */
function rustModuleName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.rs$/u, "");
  if (base !== "mod") return base;
  const dir = parentDir(path);
  return dir.slice(dir.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// the crate index
// ---------------------------------------------------------------------------

interface Crate {
  /** Directory holding the Cargo.toml; "" at the repo root. */
  dir: string;
  /** `[package] name` with `-` normalised to `_`; "" when absent. */
  name: string;
  /** Indexed crate-root files, sorted. */
  roots: string[];
}

interface CrateIndex {
  /** Crate directory -> crate. */
  byDir: Map<string, Crate>;
  /** Underscored crate name -> crate. */
  byName: Map<string, Crate>;
  /** Every crate directory, longest first, so the nearest manifest wins. */
  dirs: string[];
}

export function createRustResolver(ctx: RepoContext): (fromFile: string, specifier: string) => ResolvedTarget {
  let index: CrateIndex | null = null;
  const rootByFile = new Map<string, string | null>();

  function manifestAt(dir: string): CargoManifest | null {
    const text = ctx.readFile(join(dir, "Cargo.toml"));
    return text === null ? null : parseCargoManifest(text);
  }

  function crateAt(dir: string, manifest: CargoManifest, files: readonly string[]): Crate {
    const roots = new Set<string>();
    for (const target of manifest.targetPaths) {
      const path = join(dir, target.replace(/^\.\//u, ""));
      if (ctx.files.has(path)) roots.add(path);
    }
    for (const conventional of ["src/lib.rs", "src/main.rs"]) {
      const path = join(dir, conventional);
      if (ctx.files.has(path)) roots.add(path);
    }
    // Cargo auto-discovers a target per file in these directories; each is its own crate root,
    // so a module path inside one of them is walked from there and not from `src/`.
    const prefixes = AUTO_TARGET_DIRS.map((auto) => `${join(dir, auto)}/`);
    for (const file of files) {
      for (const prefix of prefixes) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf("/");
        // `examples/foo.rs` and `examples/foo/main.rs`; nothing deeper is a target.
        if (slash === -1 || rest.slice(slash) === "/main.rs") roots.add(file);
        break;
      }
    }
    return { dir, name: manifest.name, roots: [...roots].sort(compareStrings) };
  }

  function build(): CrateIndex {
    if (index !== null) return index;
    const files = [...ctx.files].filter((file) => file.endsWith(".rs")).sort(compareStrings);
    const byDir = new Map<string, Crate>();
    const byName = new Map<string, Crate>();
    const seen = new Set<string>();
    const pending: string[] = [];

    const consider = (dir: string): void => {
      if (seen.has(dir)) return;
      seen.add(dir);
      const manifest = manifestAt(dir);
      if (manifest === null) return;
      const crate = crateAt(dir, manifest, files);
      byDir.set(dir, crate);
      if (crate.name !== "" && !byName.has(crate.name)) byName.set(crate.name, crate);
      // `[workspace] members` may name a crate that holds no indexed file of its own; probing
      // it costs one read and is what makes `use <member>::…` resolve (spec 1.3).
      for (const member of manifest.members) {
        if (member.includes("*")) continue;
        pending.push(join(dir, member.replace(/\/$/u, "")));
      }
    };

    for (const file of files) {
      let current = parentDir(file);
      for (;;) {
        consider(current);
        if (current === "") break;
        current = parentDir(current);
      }
    }
    while (pending.length > 0) consider(pending.pop() ?? "");

    index = { byDir, byName, dirs: [...byDir.keys()].sort((a, b) => b.length - a.length || compareStrings(a, b)) };
    return index;
  }

  /** The crate whose Cargo.toml is nearest above `file`. */
  function crateOf(file: string): Crate | null {
    const crates = build();
    for (const dir of crates.dirs) {
      if (relativeTo(dir, file) !== null) return crates.byDir.get(dir) ?? null;
    }
    return null;
  }

  /** The crate root `file` belongs to: the root whose directory is its longest prefix. */
  function rootOf(file: string): string | null {
    const cached = rootByFile.get(file);
    if (cached !== undefined) return cached;
    const crate = crateOf(file);
    let best: string | null = null;
    if (crate !== null) {
      let bestLength = -1;
      for (const root of crate.roots) {
        if (root === file) {
          best = root;
          bestLength = Number.MAX_SAFE_INTEGER;
          break;
        }
        const dir = parentDir(root);
        if (relativeTo(dir, file) === null) continue;
        if (dir.length > bestLength) {
          best = root;
          bestLength = dir.length;
        }
      }
      if (best === null) best = crate.roots[0] ?? null;
    }
    rootByFile.set(file, best);
    return best;
  }

  /** Module path of `file` inside its crate: `src/a/b.rs` -> `["a","b"]`, `src/lib.rs` -> `[]`. */
  function modulePathOf(file: string, root: string): string[] {
    if (file === root) return [];
    const rest = relativeTo(parentDir(root), file);
    if (rest === null) return [];
    const segments = rest.replace(/\.rs$/u, "").split("/");
    if (segments[segments.length - 1] === "mod") segments.pop();
    return segments;
  }

  /** The file a module path names, walking from a crate root. */
  function moduleFile(root: string, segments: readonly string[]): string | null {
    if (segments.length === 0) return root;
    const base = join(parentDir(root), segments.join("/"));
    if (ctx.files.has(`${base}.rs`)) return `${base}.rs`;
    if (ctx.files.has(`${base}/mod.rs`)) return `${base}/mod.rs`;
    return null;
  }

  /** Walk a path as far as the module tree goes; the tail names an item, not a module. */
  function walkDown(root: string, segments: readonly string[]): string | null {
    for (let length = segments.length; length >= 0; length--) {
      const hit = moduleFile(root, segments.slice(0, length));
      if (hit !== null) return hit;
    }
    return null;
  }

  return (fromFile: string, specifier: string): ResolvedTarget => {
    if (specifier === "") return UNRESOLVED;
    const segments = specifier.split(MODULE_SEPARATOR).filter((segment) => segment !== "");
    const head = segments[0];
    if (head === undefined) return UNRESOLVED;

    const root = rootOf(fromFile);
    if (root === null) return { type: "external", pkg: `${CRATE_PREFIX}${head}` };

    if (head === "crate") {
      const hit = walkDown(root, segments.slice(1));
      return hit === null ? UNRESOLVED : { type: "file", path: hit };
    }

    if (head === "self" || head === "super") {
      let up = 0;
      while (segments[up] === "super") up += 1;
      const base = modulePathOf(fromFile, root);
      if (up > base.length) return UNRESOLVED;
      const start = head === "self" ? 1 : up;
      const prefix = head === "self" ? base : base.slice(0, base.length - up);
      const hit = walkDown(root, [...prefix, ...segments.slice(start)]);
      return hit === null ? UNRESOLVED : { type: "file", path: hit };
    }

    // A crate name, this crate's own included: `use grep_matcher::Matcher` crosses to the
    // member's crate root. Cargo spells the name with `-`, Rust code with `_`.
    const crate = build().byName.get(head);
    if (crate !== undefined) {
      const target = crate.roots[0] ?? null;
      if (target !== null) {
        const hit = walkDown(target, segments.slice(1));
        if (hit !== null) return { type: "file", path: hit };
      }
      return { type: "external", pkg: `${CRATE_PREFIX}${head}` };
    }

    // A uniform path (Rust 2018): `use store::Store` names a module of the file's own module.
    const base = modulePathOf(fromFile, root);
    if (moduleFile(root, [...base, head]) !== null) {
      const hit = walkDown(root, [...base, ...segments]);
      if (hit !== null) return { type: "file", path: hit };
    }

    return { type: "external", pkg: `${CRATE_PREFIX}${head}` };
  };
}

// ---------------------------------------------------------------------------
// call linking
// ---------------------------------------------------------------------------

/** Where a name imported into a file actually comes from. */
interface Binding {
  /** Repo file the name is imported from. */
  module: string;
  /** Exported name in that module. */
  name: string;
}

export interface RustCallIndex {
  /** file -> top-level item name -> kind. */
  items: Map<string, Map<string, string>>;
  /** file -> `<Type>.<member>` -> kind, for every method and associated item. */
  members: Map<string, Map<string, string>>;
  /**
   * file -> local name -> every plain `use` that binds it.
   *
   * A list, not one entry, because a name is routinely written twice in one file: a top-level
   * `use grep_matcher::LineTerminator`, and `use super::LineTerminator` again inside
   * `mod tests`. Spec 1.3's rule is "a name imported by exactly one `use` **whose target
   * declares it**", so the choice is made at resolution time, when the wanted member is known -
   * dropping the name the moment two `use` items mention it would throw away the one that is
   * actually right.
   */
  bindings: Map<string, Map<string, Binding[]>>;
  /** file -> local module name -> the files that module could be. */
  modules: Map<string, Map<string, string[]>>;
  /** file -> re-exported name -> every `pub use` that supplies it. */
  reexports: Map<string, Map<string, Binding[]>>;
  /**
   * file -> the repo files a `use …::*` glob brings into scope, other than the file itself.
   *
   * A glob of one's own file (`mod tests { use super::*; }`) adds nothing the same-file rule
   * does not already cover, so it never counts towards "exactly one glob in scope".
   */
  globs: Map<string, string[]>;
}

/**
 * The index a repo with no Rust file gets. Frozen, because it is shared by every such call and a
 * consumer that wrote into it would poison the next one.
 */
const EMPTY_INDEX: RustCallIndex = Object.freeze({
  items: Object.freeze(new Map()),
  members: Object.freeze(new Map()),
  bindings: Object.freeze(new Map()),
  modules: Object.freeze(new Map()),
  reexports: Object.freeze(new Map()),
  globs: Object.freeze(new Map()),
});

function nest<V>(map: Map<string, Map<string, V>>, key: string): Map<string, V> {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<string, V>();
  map.set(key, created);
  return created;
}

/** Append to a keyed list, skipping an exact duplicate. */
function push<V>(map: Map<string, V[]>, key: string, value: V, same: (a: V, b: V) => boolean): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
    return;
  }
  if (!list.some((existing) => same(existing, value))) list.push(value);
}

function sameBinding(a: Binding, b: Binding): boolean {
  return a.module === b.module && a.name === b.name;
}

/**
 * The one declaration every candidate agrees on, or null when they disagree or none resolves.
 *
 * This is "exactly one" as spec 1.3 means it: the candidates that resolve are counted, not the
 * `use` items that were written. Two `use` items naming the same declaration are one answer.
 */
function agreed(
  candidates: ReadonlyArray<{ to: string; confidence: Confidence } | null>,
): { to: string; confidence: Confidence } | null {
  let answer: { to: string; confidence: Confidence } | null = null;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    if (answer === null) {
      answer = candidate;
      continue;
    }
    if (answer.to !== candidate.to) return null;
    if (candidate.confidence === "high") answer = candidate;
  }
  return answer;
}

/**
 * Everything Rust call resolution needs, gathered in one pass over the Rust files and one pass
 * over the resolved import edges. A repo with no Rust file gets the shared empty index.
 */
export function buildRustCallIndex(files: readonly FileRecord[], imports: readonly ImportEdge[]): RustCallIndex {
  const rustFiles = files.filter((file) => file.lang === "rust");
  if (rustFiles.length === 0) return EMPTY_INDEX;

  const index: RustCallIndex = {
    items: new Map(),
    members: new Map(),
    bindings: new Map(),
    modules: new Map(),
    reexports: new Map(),
    globs: new Map(),
  };
  const paths = new Set(rustFiles.map((file) => file.path));

  for (const file of rustFiles) {
    const items = nest(index.items, file.path);
    const members = nest(index.members, file.path);
    // A member name two impls both declare (two traits each with a `go` for one type) is
    // ambiguous: `extract` gives the second declaration the id `<Type>.go~2`, and the *name*
    // now points at two of them, so it resolves to **nothing** rather than to whichever
    // happened to come first (driver ruling 2026-09-04).
    const ambiguous = new Set<string>();
    for (const decl of file.decls) {
      if (decl.parent === undefined) {
        if (!items.has(decl.name)) items.set(decl.name, decl.kind);
        continue;
      }
      if (!decl.name.includes(".")) continue;
      if (members.has(decl.name)) ambiguous.add(decl.name);
      else members.set(decl.name, decl.kind);
    }
    for (const name of ambiguous) members.delete(name);
  }

  // file -> specifier -> the repo file it resolved to. Only a repo file can carry a call.
  const targets = new Map<string, Map<string, string>>();
  const kinds = new Map<string, Map<string, ImportEdge["kind"]>>();
  for (const edge of imports) {
    if (!paths.has(edge.from) || !paths.has(edge.to)) continue;
    const bySpecifier = nest(targets, edge.from);
    if (!bySpecifier.has(edge.specifier)) bySpecifier.set(edge.specifier, edge.to);
    nest(kinds, edge.from).set(edge.specifier, edge.kind);
  }

  for (const file of rustFiles) {
    const bySpecifier = targets.get(file.path);
    if (bySpecifier === undefined) continue;
    const bindings = nest(index.bindings, file.path);
    const modules = nest(index.modules, file.path);
    const reexports = nest(index.reexports, file.path);

    for (const record of file.imports) {
      const target = bySpecifier.get(record.specifier);
      if (target === undefined) continue;
      const last = record.specifier.split(MODULE_SEPARATOR).pop() ?? "";

      if (record.symbols.length === 0) {
        // A `mod foo;` item: the module's own name binds the module's file.
        if (last !== "") push(modules, last, target, (a, b) => a === b);
        continue;
      }
      for (const symbol of record.symbols) {
        if (symbol.name === "*") {
          if (target !== file.path) push(index.globs, file.path, target, (a, b) => a === b);
          continue;
        }
        // `use crate::retry;` binds a module, not a name inside one.
        if (symbol.name === last && rustModuleName(target) === last) {
          push(modules, symbol.local, target, (a, b) => a === b);
        }
        const into = record.reexport ? reexports : bindings;
        push(into, symbol.local, { module: target, name: symbol.name }, sameBinding);
      }
    }
  }

  return index;
}

/** A top-level item that a call can actually land on. A `type` alias never declares a body. */
function callable(kind: string | undefined): boolean {
  return kind !== undefined && kind !== "type";
}

/**
 * One Rust call site resolved to a declaration, or null when nothing is certain (spec 1.3).
 *
 * `high`: a same-file item; a name imported by exactly one `use` whose target declares it;
 * `Type::method` where the impl declaring `method` is reachable; `this.method` inside an impl;
 * a module-qualified `module::function`.
 * `med`: a name reached through exactly one `pub use`.
 *
 * A bare name no `use` supplies falls through to the glob rule: exactly one `use …::*` in scope
 * and exactly one target declaring the name is a unique resolution, so it is `high` too.
 */
export function resolveRustCall(
  file: FileRecord,
  site: CallSite,
  index: RustCallIndex,
): { to: string; confidence: Confidence } | null {
  const callee = site.callee;
  if (callee === "") return null;
  const items = index.items.get(file.path);
  const dot = callee.indexOf(".");

  if (dot === -1) {
    // 1. An item of this very file.
    if (callable(items?.get(callee))) return { to: symbolId(file.path, callee), confidence: "high" };
    // 2. A name imported by exactly one `use` **whose target declares it**.
    const candidates = index.bindings.get(file.path)?.get(callee) ?? [];
    const imported = agreed(candidates.map((binding) => declared(index, binding.module, binding.name)));
    if (imported !== null) return imported;
    // 6. A glob: `use crate::a::*` then `go()`. Only when exactly one glob is in scope and its
    // target declares the name, so nothing is guessed between two `*`s.
    const globs = index.globs.get(file.path) ?? [];
    const only = globs.length === 1 ? globs[0] : undefined;
    if (only === undefined) return null;
    return callable(index.items.get(only)?.get(callee)) ? { to: symbolId(only, callee), confidence: "high" } : null;
  }

  const object = callee.slice(0, dot);
  const member = callee.slice(dot + 1);
  if (object === "" || member === "" || member.includes(".")) return null;

  // 4. `this.method`: the enclosing type owns it. The caller's path splits type from member.
  if (object === "this") {
    const owner = site.caller.slice(0, site.caller.lastIndexOf("."));
    if (owner === "") return null;
    const name = `${owner}.${member}`;
    return index.members.get(file.path)?.has(name) === true
      ? { to: symbolId(file.path, name), confidence: "high" }
      : null;
  }

  // 5. `module::function`, through a `mod` item or a `use` of the module itself.
  const modules = index.modules.get(file.path)?.get(object) ?? [];
  if (modules.length > 0) return agreed(modules.map((module) => declared(index, module, member)));

  // 3. `Type::method`, where `Type` is declared here or imported by exactly one `use`.
  const name = `${object}.${member}`;
  if (items?.has(object) === true) {
    return index.members.get(file.path)?.has(name) === true
      ? { to: symbolId(file.path, name), confidence: "high" }
      : null;
  }
  const candidates = index.bindings.get(file.path)?.get(object) ?? [];
  return agreed(candidates.map((binding) => throughType(index, binding, member)));
}

/** `Type::method` through one import binding: the impl in that file, else one `pub use` hop. */
function throughType(
  index: RustCallIndex,
  binding: Binding,
  member: string,
): { to: string; confidence: Confidence } | null {
  const target = `${binding.name}.${member}`;
  if (index.members.get(binding.module)?.has(target) === true) {
    return { to: symbolId(binding.module, target), confidence: "high" };
  }
  const hops = index.reexports.get(binding.module)?.get(binding.name) ?? [];
  return agreed(
    hops.map((hop) => {
      const through = `${hop.name}.${member}`;
      return index.members.get(hop.module)?.has(through) === true
        ? { to: symbolId(hop.module, through), confidence: "med" as Confidence }
        : null;
    }),
  );
}

/** A name in one file: declared there (high), or reached through exactly one `pub use` (med). */
function declared(index: RustCallIndex, module: string, name: string): { to: string; confidence: Confidence } | null {
  if (callable(index.items.get(module)?.get(name))) return { to: symbolId(module, name), confidence: "high" };
  const hops = index.reexports.get(module)?.get(name) ?? [];
  return agreed(
    hops.map((hop) =>
      callable(index.items.get(hop.module)?.get(hop.name))
        ? { to: symbolId(hop.module, hop.name), confidence: "med" as Confidence }
        : null,
    ),
  );
}
