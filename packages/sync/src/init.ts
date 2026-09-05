/**
 * `greplost init` (tech spec 7.2, 9; sync spec "Init").
 *
 * One command has to leave a repository in the state every other command
 * assumes: a config to build with, a gitignore so the machine-local files
 * never reach a diff, a complete map on disk, and the git hooks that keep it
 * that way. Running it twice must be safe, because it is the command people
 * re-run when they are not sure what state they are in.
 *
 * So nothing here overwrites. A config the user has already edited is theirs;
 * a gitignore they have added lines to keeps those lines and gains only what
 * is missing; the map is written by `update`, which compares bytes before it
 * writes; the hooks append and skip on their marker. `created` therefore says
 * what this call actually brought into existence, not what happens to exist.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";

import { discoverCandidates } from "@greplost/core";
import type { GreplostConfig, Lang } from "@greplost/core/schema";
import {
  ARTIFACT_DIR,
  ARTIFACT_PATHS,
  DEFAULT_CONFIG,
  DOCKERFILE_PREFIX,
  compareStrings,
  stableStringify,
} from "@greplost/core/schema";

import { installGitHooks } from "./githooks.ts";
import { update } from "./incremental.ts";
import type { UpdateResult } from "./incremental.ts";
import { PARSE_CACHE_PATH } from "./parse-cache.ts";
import { safeWrite } from "./write.ts";

export interface InitOptions {
  /** `false` skips hook installation; anything else installs them. */
  hooks?: boolean;
  /** Suppress the update's one-line summary. */
  quiet?: boolean;
}

export interface InitResult {
  /** Repo-relative paths this call created, in the order it created them. */
  created: string[];
  /** The full build it ran. */
  update: UpdateResult;
  /** Hooks newly installed; empty outside a git repository or when hooks were declined. */
  hooks: string[];
}

/**
 * Everything the runtime writes and nothing anyone should commit: the dirty
 * queue, the lock, the last-indexed commit, and the parse cache. The rest of
 * `.greplost/` — the map itself, `config.json`, the semantic summaries — is
 * meant to be in the repository; that is the whole point of it being there.
 */
const GITIGNORE_ENTRIES: readonly string[] = [
  // A glob, not the bare name: the queue is consumed by renaming it aside, and
  // a run killed at that instant leaves `.dirty.taken` behind. It is swept up
  // by the next update, but it must never show in anyone's `git status`.
  `${ARTIFACT_PATHS.dirty}*`,
  ARTIFACT_PATHS.lock,
  ARTIFACT_PATHS.state,
  PARSE_CACHE_PATH,
  // Sibling temporaries from an atomic replace. `update` sweeps the ones a
  // killed writer left behind, but a hook firing while a build is mid-rename
  // must not make them show up in someone's status either.
  "*.tmp",
];

export async function init(root: string, opts: InitOptions = {}): Promise<InitResult> {
  const absoluteRoot = path.resolve(root);
  const artifactDir = path.join(absoluteRoot, ARTIFACT_DIR);

  try {
    mkdirSync(artifactDir, { recursive: true });
  } catch (cause) {
    throw new Error(`greplost: cannot create ${ARTIFACT_DIR}/: ${reasonOf(cause)}`);
  }

  const created: string[] = [];
  if (await createConfig(absoluteRoot, artifactDir)) created.push(`${ARTIFACT_DIR}/${ARTIFACT_PATHS.config}`);
  if (ensureGitignore(absoluteRoot, artifactDir)) created.push(`${ARTIFACT_DIR}/.gitignore`);

  // Full, not incremental: there is nothing to be incremental against, and a
  // first run must not depend on a state file that may be left over from an
  // older, differently configured build.
  const result = await update(absoluteRoot, {
    mode: "full",
    ...(opts.quiet === undefined ? {} : { quiet: opts.quiet }),
  });

  // After the build, so the first commit a user makes is the one that fires a
  // hook, rather than the hook racing the build that is still running.
  const hooks = opts.hooks === false ? [] : installGitHooks(absoluteRoot).installed;

  return { created, update: result, hooks };
}

/** Write `config.json` from the defaults unless the repo already has one. */
async function createConfig(root: string, artifactDir: string): Promise<boolean> {
  const file = path.join(artifactDir, ARTIFACT_PATHS.config);
  if (existsSync(file)) return false;
  write(root, ARTIFACT_PATHS.config, `${stableStringify(await initialConfig(root), 2)}\n`);
  return true;
}

/** A framework signal pass, exactly as `config.json` spells it. */
type SignalPass = NonNullable<GreplostConfig["signals"]>[number];

/** What the marker table found: the languages to index and the passes to run. */
export interface MarkedLanguages {
  /** `DEFAULT_CONFIG.languages` first, then every marked language, sorted. */
  languages: Lang[];
  /** The signal passes whose framework the repository actually depends on, sorted. */
  signals: SignalPass[];
}

/** How much of a marker file is read to decide what it is. */
const MARKER_PROBE_BYTES = 4096;

/** `.github/workflows/<name>.yml`, at the root or under any directory. */
const WORKFLOW_PATH = /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

/** Package names that turn on a TypeScript signal pass (spec 3.2 to 3.5). */
const SIGNAL_PACKAGES: readonly { pass: SignalPass; packages: readonly string[] }[] = [
  { pass: "next", packages: ["next"] },
  { pass: "pulumi-ts", packages: ["@pulumi/pulumi"] },
  { pass: "react", packages: ["react"] },
  { pass: "tanstack", packages: ["@tanstack/react-router", "@tanstack/react-start"] },
];

/** The module path a Pulumi Go program requires (spec 3.6). */
const PULUMI_GO_MODULE = "github.com/pulumi/pulumi/sdk";

/**
 * The marker table (spec 0.6, extended with signal passes by the ruling of
 * 2026-09-05).
 *
 * `DEFAULT_CONFIG.languages` is the TypeScript family and stays that way, so
 * adding a language to greplost cannot change an existing repository's map. The
 * price is that every other language is opt-in, and a Terraform repository used
 * to get a config that matched nothing: `init` reported a successful build, exit
 * 0, and an empty map. This closes that for the languages build 2 added, on the
 * crudest rule that cannot be wrong (a filename, or for a manifest one first
 * key), and it *adds* rather than replaces, because a repository with both a
 * `go.mod` and a `tsconfig.json` is ordinary and dropping either half would be
 * the same bug with the arguments swapped.
 *
 * Nothing here parses a file. `readText` returns the first few kilobytes of one,
 * or `undefined` when it cannot be read, and an unreadable marker is simply not
 * a marker: `init` must never fail because a file it was curious about was
 * unreadable. Everything after `init` is the user's; this config is written once
 * and never rewritten.
 */
export function markedLanguages(
  files: readonly string[],
  readText: (rel: string) => string | undefined,
): MarkedLanguages {
  const marked = new Set<Lang>();
  const manifests: string[] = [];
  const goModules: string[] = [];

  for (const file of files) {
    const base = file.slice(file.lastIndexOf("/") + 1);

    if (base === "go.mod") {
      marked.add("go");
      goModules.push(file);
    }
    if (base === "package.json") manifests.push(file);

    if (base === "pyproject.toml" || base === "setup.py" || file.endsWith(".py")) marked.add("python");
    if (base === "Cargo.toml") marked.add("rust");
    if (base === "pom.xml" || base === "build.gradle" || base === "build.gradle.kts") marked.add("java");
    if (file.endsWith(".kt") || file.endsWith(".kts")) marked.add("kotlin");
    if (file.endsWith(".tf")) marked.add("hcl");
    if (base === "Dockerfile" || base === "Containerfile" || base.startsWith(DOCKERFILE_PREFIX)) {
      marked.add("dockerfile");
    }
    if (isYamlMarker(file, base, readText)) marked.add("yaml");
  }

  const signals = new Set<SignalPass>();
  for (const manifest of manifests) {
    for (const name of dependencyNames(readText(manifest))) {
      for (const entry of SIGNAL_PACKAGES) {
        if (entry.packages.includes(name)) signals.add(entry.pass);
      }
    }
  }
  for (const goModule of goModules) {
    if ((readText(goModule) ?? "").includes(PULUMI_GO_MODULE)) signals.add("pulumi-go");
  }

  const added = [...marked]
    .filter((lang) => !DEFAULT_CONFIG.languages.includes(lang))
    .sort(compareStrings);
  return {
    languages: [...DEFAULT_CONFIG.languages, ...added],
    signals: [...signals].sort(compareStrings),
  };
}

/**
 * True when a YAML file is one greplost knows how to read: a Helm chart, an
 * Actions workflow, or a manifest whose first key is `apiVersion`.
 *
 * The first-key test is what keeps the marker honest. Almost every repository
 * has YAML in it (lockfiles, CI for other systems, application settings), and
 * marking `yaml` on the extension alone would start indexing all of it as if it
 * were Kubernetes.
 */
function isYamlMarker(file: string, base: string, readText: (rel: string) => string | undefined): boolean {
  if (base === "Chart.yaml" || base === "Chart.yml") return true;
  if (WORKFLOW_PATH.test(file)) return true;
  if (!file.endsWith(".yaml") && !file.endsWith(".yml")) return false;
  const text = readText(file);
  if (text === undefined) return false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // Comments, blank lines and a document marker come before the first key.
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed === "---") continue;
    return trimmed.startsWith("apiVersion:");
  }
  return false;
}

/** Every dependency name a `package.json` declares, in any of the four blocks. */
function dependencyNames(text: string | undefined): string[] {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A manifest that is not JSON declares nothing; `update` reports the repo's
    // real problems, and `init` must not fail on one.
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const manifest = parsed as Record<string, unknown>;
  const names: string[] = [];
  for (const block of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const found = manifest[block];
    if (typeof found === "object" && found !== null) names.push(...Object.keys(found as Record<string, unknown>));
  }
  return names;
}

/** The first few kilobytes of a repo file, or `undefined` when it cannot be read. */
function probe(root: string, rel: string): string | undefined {
  let handle: number | undefined;
  try {
    handle = openSync(path.join(root, rel), "r");
    const buffer = Buffer.alloc(MARKER_PROBE_BYTES);
    const read = readSync(handle, buffer, 0, MARKER_PROBE_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Already closed, or never opened: nothing to report and nothing to do.
      }
    }
  }
}

/**
 * The defaults, plus every language and signal pass the marker table finds.
 *
 * `DEFAULT_CONFIG` itself is returned unchanged when nothing was marked, so a
 * plain TypeScript repository writes exactly the config it always did.
 */
async function initialConfig(root: string): Promise<GreplostConfig> {
  let candidates: string[];
  try {
    candidates = await discoverCandidates(root, DEFAULT_CONFIG);
  } catch {
    // Discovery is `update`'s job to report; a config written from the plain
    // defaults is the right answer when nothing can be seen from here.
    return DEFAULT_CONFIG;
  }

  const marked = markedLanguages(candidates, (rel) => probe(root, rel));
  const sameLanguages =
    marked.languages.length === DEFAULT_CONFIG.languages.length &&
    marked.languages.every((lang, index) => lang === DEFAULT_CONFIG.languages[index]);
  if (sameLanguages && marked.signals.length === 0) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    languages: marked.languages,
    ...(marked.signals.length === 0 ? {} : { signals: marked.signals }),
  };
}

/**
 * Make sure `.greplost/.gitignore` covers the runtime files, adding only what
 * is missing. Returns true when the file did not exist.
 *
 * Appending rather than rewriting matters more than it looks: a repository
 * that has chosen to ignore its whole map (a huge monorepo that regenerates it
 * in CI) will have added lines here, and a "fix" that replaced the file would
 * silently start committing thousands of artifacts.
 */
function ensureGitignore(root: string, artifactDir: string): boolean {
  const file = path.join(artifactDir, ".gitignore");

  let existing: string | undefined;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = undefined;
  }

  if (existing === undefined) {
    write(root, ".gitignore", `${GITIGNORE_ENTRIES.join("\n")}\n`);
    return true;
  }

  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length > 0) {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    write(root, ".gitignore", `${existing}${separator}${missing.join("\n")}\n`);
  }
  return false;
}

/**
 * Through `safeWrite`, like every other writer under `.greplost/`: `init` is
 * the one command that runs *before* anyone has looked at the directory, and a
 * committed `.greplost/config.json -> anywhere` would otherwise be followed.
 */
function write(root: string, rel: string, contents: string): void {
  try {
    safeWrite(root, rel, contents);
  } catch (cause) {
    const message = reasonOf(cause);
    if (message.startsWith("greplost: ")) throw cause;
    throw new Error(`greplost: cannot write ${ARTIFACT_DIR}/${rel}: ${message}`);
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
