/**
 * GitHub Actions workflow truth for Eval 1 (spec 2026-09-04 section 2.4, bench spec 5.2).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2), so nothing
 * here imports greplost's extractor, resolver or tree-sitter. The oracle is **js-yaml 4**, a
 * different YAML implementation with a different parser, reading the same bytes: `loadAll`
 * gives the document list and everything below is computed from the plain JavaScript objects it
 * hands back, by a second reading of the documented workflow schema.
 *
 * **Which oracle ran, and why (leaf 2.9 ruling).** Spec 2.4 asks for `@actions/workflow-parser`
 * first. It publishes (0.3.61) and it would install, but adding it means editing
 * `bench/package.json`, and the build-2 contract is explicit that a leaf adds no dependency and
 * reports one it needs. It is also less of an oracle than it looks: its public entry point
 * still parses the file with a YAML reader and then applies GitHub's schema, so what it would
 * add over this module is schema *validation*, not an independent reading of the shapes S1 to
 * S6 are scored on. The note is therefore `js-yaml-oracle`, which is what actually ran.
 *
 * Where it can disagree with greplost, and does:
 *
 *  - js-yaml resolves anchors, aliases and merge keys (`<<:`); greplost reads the text as
 *    written and never expands one. A workflow that uses them is a real difference, scored.
 *  - js-yaml refuses a document greplost's error-recovering parser reads part of (a duplicate
 *    job id, a tab in indentation). Such a file is **not covered**, so neither side is scored
 *    on a document only one of them could see.
 *  - js-yaml types scalars; `on:` is the string `on` under YAML 1.2 core, which is what makes
 *    the classification rule below readable at all, and every name is compared as text.
 *
 * What it produces, in greplost's id vocabulary:
 *
 *   files       the workflow and action files it could read;
 *   imports     always empty: a workflow has no import statement, and `resolve/yaml.ts` says
 *               the same thing on greplost's side;
 *   exports     each file's sorted job ids — a workflow's public surface is the jobs another
 *               job, or another workflow, reaches for by name;
 *   calls       always empty, which is why S3 is `n/a` for YAML and never 0;
 *   references  the S5 truth: `needs`, `uses` and `config` resolved by the same documented
 *               rules, restated here;
 *   nodes       every node id, so the node set is scored alongside the edges (S6).
 *
 * An empty result is an error, never a score: a run where the reader loaded nothing would
 * otherwise report vacuous 1.000s and pass the gate.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { loadAll } from "js-yaml";
import { compareEdges, compareStrings, type Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

/**
 * Oracle choices this generator applies, for `RESULTS.md` to disclose.
 *
 *  - `js-yaml-oracle`               — which reader actually ran (see the module docstring).
 *  - `anchors-not-expanded`         — js-yaml resolves anchors, aliases and merge keys (`<<:`)
 *    and greplost reads the text as written; a workflow that uses one is a real divergence and
 *    is scored as one rather than papered over.
 *  - `config-precision-unmeasured`  — the `config` refKind has no corpus-scale measurement. A
 *    YAML target is indexed with `languages: ["yaml"]`, so a `run:` body naming `scripts/x.ts`
 *    resolves to nothing on either side, and even the fixture's two `config` edges fall outside
 *    S5 because their targets are not scored YAML files. Leaf 2.12 discloses this.
 */
export const NOTES: readonly string[] = ["js-yaml-oracle", "anchors-not-expanded", "config-precision-unmeasured"];

/**
 * Metrics a workflow oracle cannot measure, because a workflow has none of the things they
 * count. `structural.ts` reads these out of the notes and prints `n/a` (leaf 2.0 ruling R10);
 * nothing is inferred.
 *
 * S3 (calls) and S1 (imports) are both structurally absent — spec 2.4 gives a workflow neither,
 * and `resolve/yaml.ts` says the same on greplost's side — and S4 is the cycle set over an
 * import graph that does not exist. Reporting them as a measured 1.000 over an empty universe
 * on both sides is the vacuous pass tech spec 10.1 principle 2 exists to stop. S2, S5 and S6
 * stay measured and gated, so `--gate` is never left with nothing to fail (leaf 2.9 fix
 * round 1).
 */
const UNSUPPORTED = ["unsupported:S1", "unsupported:S3", "unsupported:S4"] as const;

/** The synthetic job id a composite action's steps hang from (spec 2.4). */
const COMPOSITE_JOB_ID = "runs";

/** `${{ … }}`: a value chosen when the workflow runs, so never a name in the map. */
const EXPRESSION = /\$\{\{/u;

/** A `run:` token that could be a repo path. Restated from spec 2.4, not shared with greplost. */
const PATH_TOKEN = /^(?:\.\/)?[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u;

/** Characters that end a shell word. */
const SHELL_SEPARATORS = /[\s;&|()<>"'`=,]+/u;

/** The two file names GitHub reads a local action's definition from, in the order it tries them. */
const ACTION_FILES: readonly string[] = ["action.yml", "action.yaml"];

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A scalar as the text a name would have been written with; anything else is not one. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** One file's documents, or null when js-yaml could not read it at all. */
function documentsOf(root: string, file: string): unknown[] | null {
  let source: string;
  try {
    source = readFileSync(path.join(root, file), "utf8");
  } catch {
    return null;
  }
  const documents: unknown[] = [];
  try {
    loadAll(source, (document) => {
      documents.push(document);
    });
  } catch {
    return null;
  }
  return documents;
}

function basename(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? file : file.slice(slash + 1);
}

/** True for `action.yml` and `action.yaml`. */
function isActionDefinitionName(file: string): boolean {
  const base = basename(file);
  return base === "action.yml" || base === "action.yaml";
}

/** Chart files that mark a directory as a Helm chart, whatever else is in it. */
const CHART_FILES: ReadonlySet<string> = new Set(["Chart.yaml", "Chart.yml", "values.yaml", "values.yml"]);

/** True for `.github/workflows/<name>.yml` and `.yaml`, at any repo depth. */
function isWorkflowPathName(file: string): boolean {
  const index = file.indexOf(".github/workflows/");
  if (index === -1) return false;
  if (index !== 0 && file[index - 1] !== "/") return false;
  const rest = file.slice(index + ".github/workflows/".length);
  if (rest.includes("/") || rest === "") return false;
  return rest.endsWith(".yml") || rest.endsWith(".yaml");
}

/** True for a chart file or anything under a chart's `templates/` directory. */
function isHelmPathName(file: string): boolean {
  if (CHART_FILES.has(basename(file))) return true;
  return file.startsWith("templates/") || file.includes("/templates/");
}

/** The four flavours `packages/core/src/extract/yaml.ts` tells apart. */
type Flavour = "actions" | "helm" | "k8s" | "plain";

/**
 * One document's flavour: `classifyYamlDocument` restated, in order, on js-yaml's objects.
 *
 * Restated and not shared — that is what makes a flavour disagreement between the two programs
 * show up as a score rather than as silence. The order is the extractor's, including the two
 * facts the review turned up: a file under `.github/workflows/` with **no `on` key** is not a
 * workflow (GitHub will not run it, and greplost classifies it `plain`), and the content rules
 * sit below `apiVersion`+`kind` so a manifest stays a manifest.
 */
function classifyDocument(file: string, document: unknown): Flavour {
  if (!isPlain(document)) return isHelmPathName(file) ? "helm" : "plain";
  if (isWorkflowPathName(file) && "on" in document) return "actions";
  if (isHelmPathName(file)) return "helm";
  if ("apiVersion" in document && "kind" in document) return "k8s";
  if ("on" in document && "jobs" in document) return "actions";
  if (isActionDefinitionName(file) && "runs" in document) return "actions";
  return "plain";
}

/**
 * True when this file is one the Actions oracle owns: the first of its documents that is not
 * `plain` is a workflow or an action definition.
 *
 * `bench/src/truth/yaml.ts` asks this so its flavour split matches the one
 * `packages/core/src/extract/yaml.ts` makes. A file js-yaml cannot read at all falls back to the
 * path rule, which is all the seam's own `flavourOf(file)` ever had; such a file is covered by
 * no oracle and drops out of `truth.files`, so it is scored on neither side either way.
 */
export function isActionsFile(root: string, file: string): boolean {
  const documents = documentsOf(root, file);
  if (documents === null) return isWorkflowPathName(file);
  for (const document of documents) {
    const flavour = classifyDocument(file, document);
    if (flavour !== "plain") return flavour === "actions";
  }
  return false;
}

/**
 * A `run:` body with every `${{ … }}` span replaced by spaces of the same length.
 *
 * Restated from spec 2.4's "literal token", not shared with greplost: a path *inside* an
 * expression is an argument to `hashFiles` or `format`, not a file the step runs, and blanking
 * the span (rather than the line) keeps a real path written beside one.
 */
function blankExpressions(body: string): string {
  let out = "";
  let index = 0;
  for (;;) {
    const start = body.indexOf("${{", index);
    if (start === -1) return out + body.slice(index);
    const end = body.indexOf("}}", start + 3);
    out += body.slice(index, start);
    if (end === -1) return out + " ".repeat(body.length - start);
    out += " ".repeat(end + 2 - start);
    index = end + 2;
  }
}

/**
 * The path-shaped tokens of a `run:` body, in source order and without repeats.
 *
 * The rule of spec 2.4, restated: a word that could spell a repo-relative path, with no
 * expansion, no glob, no absolute root and no `..`, and with either a separator or an extension
 * so a bare command (`make`, `bun`) is never a candidate, read from a body whose expression
 * spans have been blanked.
 */
function runPathTokens(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of blankExpressions(body).split(SHELL_SEPARATORS)) {
    if (raw === "" || raw.includes("$") || raw.includes("*") || raw.includes("?")) continue;
    const token = raw.startsWith("./") ? raw.slice(2) : raw;
    if (token === "" || token.startsWith("/") || token.includes("..")) continue;
    if (!PATH_TOKEN.test(raw)) continue;
    if (!token.includes("/") && !token.includes(".")) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** A name greplost's `nodeId` would accept. */
function usableName(value: string | null): value is string {
  return value !== null && value !== "" && !/[#\n\0]/u.test(value);
}

/** A scalar that is a literal: present, non-empty and free of `${{ … }}`. */
function literal(value: string | null): value is string {
  return value !== null && value !== "" && !EXPRESSION.test(value);
}

/** A value that is one string or a list of strings, as a list. */
function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

// ---------------------------------------------------------------------------
// the node and edge sets
// ---------------------------------------------------------------------------

interface FileReading {
  /** Every node id this file declares, in source order. */
  readonly nodes: string[];
  /** The job ids this file declares, in source order and each one once (the file's exports). */
  readonly jobIds: Set<string>;
  /** `job`/`task` node ids by job id, for the `needs` lookup inside this file. */
  readonly jobsById: Map<string, string[]>;
  /** Requests, before resolution. */
  readonly needs: Array<{ readonly from: string; readonly job: string }>;
  readonly uses: Array<{ readonly from: string; readonly uses: string }>;
  readonly config: Array<{ readonly from: string; readonly token: string }>;
}

function emptyReading(): FileReading {
  return {
    nodes: [],
    jobIds: new Set<string>(),
    jobsById: new Map<string, string[]>(),
    needs: [],
    uses: [],
    config: [],
  };
}

/** Everything one workflow or action file declares and asks for, by the rules of spec 2.4. */
function readFile(root: string, file: string): FileReading | null {
  const documents = documentsOf(root, file);
  if (documents === null) return null;

  const reading = emptyReading();
  const used = new Set<string>();
  /**
   * The uniqueness suffix rule, restated: the suffix lands on the **id** and nowhere else, so
   * two jobs called `build` are `…#job.build` and `…#job.build~2` and both are *named* `build`
   * (driver ruling 2026-09-04).
   *
   * One rule covers a step under a duplicated job, the same one `extract/yaml-actions.ts`
   * states: the step's name is always `<jobId as written>.~<stepIndex>`, so the second job's
   * first step is `step.build.~0` and its id takes the suffix (`…#step.build.~0~2`). Spelling a
   * job id nobody wrote inside a step name is the alternative, and it is worse.
   */
  const add = (kind: string, rawName: string): string => {
    let id = `${file}#${kind}.${rawName}`;
    for (let n = 2; used.has(id); n += 1) id = `${file}#${kind}.${rawName}~${n}`;
    used.add(id);
    reading.nodes.push(id);
    return id;
  };

  const readStep = (jobId: string, index: number, step: unknown): void => {
    if (!isPlain(step)) return;
    const id = add("step", `${jobId}.~${index}`);
    const uses = text(step["uses"]);
    if (literal(uses)) reading.uses.push({ from: id, uses });
    const run = text(step["run"]);
    if (run !== null) for (const token of runPathTokens(run)) reading.config.push({ from: id, token });
  };

  const readNeeds = (from: string, body: Plain): void => {
    for (const needed of stringList(body["needs"])) {
      if (literal(needed)) reading.needs.push({ from, job: needed });
    }
  };

  for (const document of documents) {
    if (!isPlain(document)) continue;

    const jobs = document["jobs"];
    if (isPlain(jobs)) {
      for (const jobId of Object.keys(jobs)) {
        const body = jobs[jobId];
        if (!isPlain(body) || !usableName(jobId)) continue;
        const uses = text(body["uses"]);
        if (uses !== null) {
          const id = add("task", jobId);
          reading.jobIds.add(jobId);
          const bucket = reading.jobsById.get(jobId);
          if (bucket === undefined) reading.jobsById.set(jobId, [id]);
          else bucket.push(id);
          if (literal(uses)) reading.uses.push({ from: id, uses });
          readNeeds(id, body);
          continue;
        }
        const id = add("job", jobId);
        reading.jobIds.add(jobId);
        const bucket = reading.jobsById.get(jobId);
        if (bucket === undefined) reading.jobsById.set(jobId, [id]);
        else bucket.push(id);
        readNeeds(id, body);
        const steps = body["steps"];
        if (Array.isArray(steps)) {
          for (let index = 0; index < steps.length; index += 1) readStep(jobId, index, steps[index]);
        }
      }
      continue;
    }

    // A composite action: the steps of `runs.steps`, under the synthetic job id `runs`.
    if (!isActionDefinitionName(file)) continue;
    const steps = isPlain(document["runs"]) ? (document["runs"] as Plain)["steps"] : undefined;
    if (!Array.isArray(steps)) continue;
    for (let index = 0; index < steps.length; index += 1) readStep(COMPOSITE_JOB_ID, index, steps[index]);
  }
  return reading;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/** Join a `./`-prefixed path against the repository root, or null when it escapes it. */
function fromRepoRoot(relative: string): string | null {
  const segments: string[] = [];
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/** A repo-local `uses`: the reusable workflow file, or the `action.yml` of the directory. */
function localUsesTarget(uses: string, universe: ReadonlySet<string>): string | null {
  const root = fromRepoRoot(uses);
  if (root === null) return null;
  if (root.endsWith(".yml") || root.endsWith(".yaml")) return universe.has(root) ? root : null;
  for (const base of ACTION_FILES) {
    const candidate = `${root}/${base}`;
    if (universe.has(candidate)) return candidate;
  }
  return null;
}

/**
 * An external `uses`: `ext:action/<owner>/<repo>[/<subpath>]`, the `@ref` left out of the id.
 *
 * The ref is a version, not an identity (driver ruling 2026-09-04); the subpath stays, because
 * `github/codeql-action/init` and `github/codeql-action/analyze` are two different actions.
 */
function externalUsesTarget(uses: string): string | null {
  const at = uses.lastIndexOf("@");
  const address = at <= 0 ? uses : uses.slice(0, at);
  if (address.includes("://") || address.startsWith(".") || address.startsWith("/")) return null;
  const segments = address.split("/");
  if (segments.length < 2) return null;
  for (const segment of segments) if (segment === "" || segment === "." || segment === "..") return null;
  return `ext:action/${address}`;
}

/**
 * Every indexed path by the tokens that could name it: the whole path and each proper suffix at
 * a segment boundary. A suffix two files share is the ambiguity spec 2.4 says to drop.
 */
function pathsByToken(universe: readonly string[]): Map<string, string[]> {
  const byToken = new Map<string, string[]>();
  const add = (token: string, file: string): void => {
    const bucket = byToken.get(token);
    if (bucket === undefined) byToken.set(token, [file]);
    else if (!bucket.includes(file)) bucket.push(file);
  };
  for (const file of universe) {
    add(file, file);
    let slash = file.indexOf("/");
    while (slash !== -1) {
      add(file.slice(slash + 1), file);
      slash = file.indexOf("/", slash + 1);
    }
  }
  return byToken;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

interface Run {
  readonly covered: string[];
  readonly readings: Map<string, FileReading>;
}

/**
 * Read every requested file, with the integrity guard that stops an empty truth from scoring as
 * a perfect one (tech spec 10.1, principle 2).
 */
function coveredRun(root: string, files: string[]): Run {
  const absRoot = path.resolve(root);
  const readings = new Map<string, FileReading>();
  for (const file of [...files].sort(compareStrings)) {
    const reading = readFile(absRoot, file);
    if (reading === null) continue;
    readings.set(file, reading);
  }
  if (files.length > 0 && readings.size === 0) {
    throw new Error(
      `greplost: yaml-actions truth is empty for ${absRoot} (js-yaml read none of the ${files.length} requested files)`,
    );
  }
  return { covered: [...readings.keys()].sort(compareStrings), readings };
}

/**
 * A reference edge as the S5 scorer wants it: an `Edge` plus the `refKind` that makes its
 * identity `(from, to, refKind)` rather than `(from, to)` (driver ruling 2026-09-04).
 */
export type ReferenceTruth = Edge & { readonly refKind: string };

function edge(from: string, to: string, refKind: string, symbol: string): ReferenceTruth {
  return { from, to, kind: "reference", refKind, symbols: [symbol], confidence: "high" };
}

/**
 * Workflow truth for `files` (repo-relative posix paths) under `root`.
 *
 * `exports` is each covered file's sorted job ids; `imports`, `calls` and `cycles` are all
 * empty, because a workflow has none of them and saying so is not the same as failing to find
 * any.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const { covered, readings } = coveredRun(root, files);
  const exports: Record<string, string[]> = {};
  for (const file of covered) {
    // One entry per job *name*: two documents that both declare `build` publish one export, and
    // never a `build~2` nobody wrote (driver ruling 2026-09-04; leaf 2.9 fix round 1).
    exports[file] = [...(readings.get(file) as FileReading).jobIds].sort(compareStrings);
  }
  return {
    files: covered,
    imports: [],
    exports,
    calls: [],
    cycles: [],
    notes: [...NOTES, ...UNSUPPORTED],
  };
}

/**
 * The reference and node sets S5 and S6 are scored on (`TruthModule.generateExtra`).
 *
 * `universe` is the whole file set the target was indexed with, when the caller has it; a
 * `uses` or a `run:` token can name a file that is not itself a workflow (a chart's
 * `values.yaml`, a manifest), and resolving against the workflow group alone would report an
 * edge greplost drew as a false positive. It defaults to the workflow group, so the generator
 * still answers the two-argument `TruthModule.generateExtra` contract.
 */
export function generateExtra(
  root: string,
  files: string[],
  universe: string[] = files,
): { references: Edge[]; nodes: string[] } {
  const { covered, readings } = coveredRun(root, files);
  const fileSet = new Set(universe);
  const byToken = pathsByToken(universe);

  const nodes: string[] = [];
  const references: ReferenceTruth[] = [];
  for (const file of covered) {
    const reading = readings.get(file) as FileReading;
    nodes.push(...reading.nodes);

    // `needs` is scoped to one workflow by the format itself: only this file's jobs answer it.
    for (const need of reading.needs) {
      const found = reading.jobsById.get(need.job);
      if (found === undefined || found.length !== 1) continue;
      const target = found[0] as string;
      if (target === need.from) continue;
      references.push(edge(need.from, target, "needs", need.job));
    }

    for (const use of reading.uses) {
      const target =
        use.uses.startsWith("./") || use.uses.startsWith("../")
          ? localUsesTarget(use.uses, fileSet)
          : externalUsesTarget(use.uses);
      if (target === null) continue;
      references.push(edge(use.from, target, "uses", use.uses));
    }

    for (const config of reading.config) {
      const found = byToken.get(config.token);
      if (found === undefined || found.length !== 1) continue;
      const target = found[0] as string;
      if (target === file) continue;
      references.push(edge(config.from, target, "config", config.token));
    }
  }

  references.sort(compareEdges);
  return { references: dedupe(references), nodes: nodes.sort(compareStrings) };
}

/** Adjacent duplicates only: the list is already sorted by every field that identifies an edge. */
function dedupe(edges: readonly ReferenceTruth[]): ReferenceTruth[] {
  const out: ReferenceTruth[] = [];
  for (const candidate of edges) {
    const previous = out[out.length - 1];
    if (previous !== undefined && compareEdges(previous, candidate) === 0) continue;
    out.push(candidate);
  }
  return out;
}
