/**
 * GitHub Actions workflow extraction (build 2, spec 2026-09-04 section 2.4).
 *
 * A workflow file declares *work*, not types: jobs, the steps inside them, and the reusable
 * workflows a job delegates to. Like a Kubernetes manifest and a Terraform module it has no
 * calls and no imports at all — `resolve/yaml.ts` says so in as many words — so everything a
 * workflow says about its neighbours is a `ReferenceRecord` that `references/yaml-actions.ts`
 * resolves. Reached through the flavour dispatcher in `extract/yaml.ts`, never from
 * `extractFile` directly.
 *
 * Three kinds of node, and the rule that decides each:
 *
 *  - **`job`** — one per `jobs.<id>`, named by the job id, with `meta.name` (the display name),
 *    `meta.runsOn` and `meta.if`. The id is the name: it is what `needs` spells, what the
 *    Actions API reports, and what a person greps for.
 *  - **`step`** — one per step of a job, named `<jobId>.~<index>` with a 0-based index, carrying
 *    `meta.uses` or `meta.run` (the run body clipped to 80 characters with its whitespace
 *    collapsed) and `meta.name`. A step has no identity of its own in the format — two steps
 *    may be byte-identical — so the index is a *position*, which is why renaming one job never
 *    renumbers another's steps.
 *  - **`task`** — one per job whose body is a reusable-workflow call (`jobs.<id>.uses`), named
 *    by the job id. Such a job has no steps and no runner; it is a delegation, and calling it a
 *    `job` would put a node in the map that has none of a job's parts.
 *
 * Spec 0.2 sketches the index suffix as `#<index>`; `nodeId` refuses `#` in a name and the
 * driver's 2026-09-04 ruling replaced it with `~`, which is what leaf 2.8 already writes for
 * the same reason. `~` is not a character a job id may contain (`[A-Za-z_][A-Za-z0-9_-]*`), so
 * a suffixed name can never be mistaken for one somebody wrote.
 *
 * Three reference kinds leave here as language-native text, resolved by
 * `references/yaml-actions.ts` and never here:
 *
 *  - `needs` — the job id a job waits for, as written;
 *  - `uses`  — the action or workflow reference as written (`actions/checkout@v4`,
 *              `./.github/actions/setup`, `./.github/workflows/ci.yml`);
 *  - `config` — every literal path-shaped token of a `run:` body. The extractor cannot know
 *              which of them is a file (tech spec 5.1: a `FileRecord` is what one file can say
 *              about itself), so it offers the candidates and the reference layer keeps the
 *              ones that name exactly one indexed path.
 *
 * A composite action's `action.yml` is the same shape with the job id spelled `runs`: its steps
 * are steps, and it declares no job because it has none.
 */

import type { Node, Tree } from "web-tree-sitter";
import type {
  DeclKind,
  Declaration,
  ExportRecord,
  FileRecord,
  Lang,
  ReferenceRecord,
} from "../schema.ts";
import { compareStrings, nodeId, splitNodeId } from "../schema.ts";
import { clip, lineOf } from "./ts-signature.ts";
import type { YamlValue } from "./yaml-doc.ts";
import { documentValue, mapGet, mapPath, scalarAt, seqItems, yamlDocuments } from "./yaml-doc.ts";

/** The synthetic job id a composite action's steps hang from (spec 2.4). */
export const COMPOSITE_JOB_ID = "runs";

/** How much of a `run:` body a step node carries in `meta.run` (spec 2.4). */
const MAX_RUN_META = 80;

/**
 * An expression span: `${{ … }}`. A value holding one is chosen when the workflow runs and is
 * not a name anything in the repository could be reached by, so it never becomes a reference.
 */
const EXPRESSION = /\$\{\{/u;

/**
 * A token of a `run:` body that could be a repo path.
 *
 * Deliberately narrow: one or more path segments of ordinary file characters, optionally
 * prefixed `./`, with no expansion, no glob, no absolute root and no `..`. Everything it lets
 * through is then held to the only test that matters — being an indexed repo path — so the
 * cost of a token that is not one is nothing, while the cost of a *wrong* one would be an
 * invented edge.
 */
const PATH_TOKEN = /^(?:\.\/)?[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u;

/** Characters that end a shell word, so a `run:` body splits into candidate tokens. */
const SHELL_SEPARATORS = /[\s;&|()<>"'`=,]+/u;

/** What a step node is built from: one entry of a `steps:` sequence. */
interface StepInput {
  readonly jobId: string;
  readonly index: number;
  readonly value: YamlValue;
}

interface ActionsState {
  readonly path: string;
  readonly decls: Declaration[];
  readonly exports: ExportRecord[];
  readonly refs: ReferenceRecord[];
  /** Declaration ids already used in this file, so a duplicate name can take a `~<n>` suffix. */
  readonly usedIds: Set<string>;
  /** Names already exported, so two jobs with one id publish one export and not two. */
  readonly exportedNames: Set<string>;
}

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

/**
 * A declaration id made unique within the file: `…#job.build`, then `…#job.build~2`.
 *
 * Duplicate job ids cannot occur in a YAML mapping a human wrote, but tree-sitter's
 * error-recovering parse reads a duplicated key as two entries, and two declarations with one
 * id would collide in `graph/symbols.jsonl`. The suffix lives in the **id and nowhere else**
 * (driver ruling 2026-09-04, the rule `extract/hcl.ts` and `extract/yaml-k8s.ts` both follow):
 * `name` stays as the file wrote it, because the name is what a `needs:` writes when it reaches
 * for the job — `needs: build` names *both* of two jobs called `build`, and a suffixed name
 * would make the second silently distinguishable and turn an ambiguous reference into a certain
 * one. It is also what the export index publishes, and `build~2` is a name nobody wrote.
 *
 * One rule covers a step under a duplicated job, on both sides of the score: the step's name is
 * always `<jobId as written>.~<stepIndex>`, so the second `build`'s first step is named
 * `build.~0` like the first's and its *id* takes the suffix (`…#step.build.~0~2`). Putting the
 * suffix in the job segment instead would spell a job id nobody wrote inside a step name.
 */
function uniqueId(state: ActionsState, kind: DeclKind, name: string): string {
  const base = nodeId(state.path, kind, name);
  if (!state.usedIds.has(base)) {
    state.usedIds.add(base);
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}~${n}`;
    if (state.usedIds.has(candidate)) continue;
    state.usedIds.add(candidate);
    return candidate;
  }
}

/**
 * The part of a declaration's id after the `#`: what a `ReferenceRecord.from` must carry.
 *
 * Read back through `splitNodeId` rather than rebuilt from `kind` and `name`, so the suffix that
 * distinguishes two same-named jobs reaches the reference and the bare name does not.
 */
function localPath(declaration: Declaration): string {
  const parts = splitNodeId(declaration.id);
  return parts === null ? declaration.name : `${parts.kind}.${parts.name}`;
}

/** `meta` with sorted keys, dropping every absent entry; undefined when nothing was recorded. */
function metaOf(entries: ReadonlyArray<readonly [string, string | null]>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of [...entries].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (value !== null && value !== "") out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * A node's line span, with trailing blank lines cut off.
 *
 * A YAML block node runs to the start of whatever comes next, so its `endPosition` is the line
 * *after* the value — one line past the last thing anybody wrote. The same trim `yaml-k8s.ts`
 * applies, for the same reason: a card must not claim a line its node does not occupy.
 */
function trimmedSpan(source: string, node: Node): [number, number] {
  let end = node.endIndex;
  let rows = node.endPosition.row + 1;
  while (end > node.startIndex && /\s/u.test(source[end - 1] as string)) {
    if (source[end - 1] === "\n") rows -= 1;
    end -= 1;
  }
  const start = node.startPosition.row + 1;
  return [start, Math.max(start, rows)];
}

function addNode(
  state: ActionsState,
  source: string,
  kind: DeclKind,
  name: string,
  signature: string,
  node: Node,
  meta: Record<string, string> | undefined,
): Declaration {
  const declaration: Declaration = {
    id: uniqueId(state, kind, name),
    file: state.path,
    name,
    kind,
    signature: clip(signature),
    // A workflow's nodes are not importable symbols; the file record's `exports` is the channel
    // `FileEntry.exports` reads, exactly as `extract/yaml-k8s.ts` explains.
    exported: false,
    span: trimmedSpan(source, node),
    ...(meta === undefined ? {} : { meta }),
  };
  state.decls.push(declaration);
  return declaration;
}

function addReference(
  state: ActionsState,
  from: string,
  to: string,
  refKind: ReferenceRecord["refKind"],
  line: number,
): void {
  state.refs.push({ from, to, refKind, line });
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

/** A name `nodeId` will accept: no `#`, newline or NUL, and not empty. */
function usableName(text: string | null): text is string {
  return text !== null && text !== "" && !/[#\n\0]/u.test(text);
}

/** A scalar that is a literal: present, non-empty and free of `${{ … }}`. */
function literal(text: string | null): text is string {
  return text !== null && text !== "" && !EXPRESSION.test(text);
}

/**
 * A scalar, or a sequence of scalars, as one comma-joined string.
 *
 * `runs-on` is written all three ways — `ubuntu-latest`, `[self-hosted, linux]`, and a
 * `group`/`labels` mapping — and `meta.runsOn` is evidence rather than an id, so the two shapes
 * that are plainly a list of labels are recorded and the mapping form is left out.
 */
function scalarOrList(value: YamlValue | null): string | null {
  if (value === null) return null;
  if (value.shape === "scalar") return value.text;
  if (value.shape !== "seq") return null;
  const parts: string[] = [];
  for (const item of value.items) {
    if (item.shape !== "scalar") return null;
    parts.push(item.text);
  }
  return parts.length === 0 ? null : parts.join(",");
}

/** The scalars of a value that is either one scalar or a sequence of them, in source order. */
function scalarList(value: YamlValue | null): Array<{ text: string; node: Node }> {
  if (value === null) return [];
  if (value.shape === "scalar") return [{ text: value.text, node: value.node }];
  const out: Array<{ text: string; node: Node }> = [];
  for (const item of seqItems(value)) {
    if (item.shape === "scalar") out.push({ text: item.text, node: item.node });
  }
  return out;
}

/**
 * A `run:` body with every `${{ … }}` span replaced by spaces of the same length.
 *
 * The pre-pass leaf 2.8 applies to a Helm template, for the same reason and with the same
 * equal-length rule so offsets stay truthful. Without it a path *inside* an expression looks
 * like a path the step runs: `echo ${{ hashFiles('scripts/x.ts') }}` splits on the quote and
 * offers `scripts/x.ts`, which is a file the workflow never executes. `hashFiles`, `format`,
 * `fromJSON` and `inputs` all take path-shaped arguments, and 207 of the pinned corpus's
 * candidate tokens came from expression interiors (leaf 2.9 fix round 1).
 *
 * An unterminated `${{` blanks to the end of the body: whatever follows is inside an expression
 * as far as anyone can tell, and guessing otherwise is how a fragment becomes an edge.
 */
export function blankExpressions(body: string): string {
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
 * A `run:` body is shell, and shell is not a language greplost parses. What it does instead is
 * the one thing that cannot go wrong: offer every word that *could* spell a repo-relative path
 * and let the reference layer keep the ones that name exactly one indexed file. A word holding
 * an expression, a glob or a `..` is not a literal path and never becomes a candidate, and the
 * interior of an expression is blanked before the split so it cannot contribute one either.
 */
export function runPathTokens(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of blankExpressions(body).split(SHELL_SEPARATORS)) {
    if (raw === "" || raw.includes("$") || raw.includes("*") || raw.includes("?")) continue;
    const token = raw.startsWith("./") ? raw.slice(2) : raw;
    if (token === "" || token.startsWith("/") || token.includes("..")) continue;
    if (!PATH_TOKEN.test(raw)) continue;
    // A bare word with neither a separator nor an extension is a command (`make`, `bun`), not a
    // path. Requiring one of the two is what keeps `run: make release` from reaching for a file.
    if (!token.includes("/") && !token.includes(".")) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

function collectStep(state: ActionsState, source: string, step: StepInput): void {
  if (step.value.shape !== "map") return;
  const name = scalarAt(step.value, "name");
  const uses = scalarAt(step.value, "uses");
  const runValue = mapGet(step.value, "run");
  const run = runValue !== null && runValue.shape === "scalar" ? runValue.text : null;

  const declaration = addNode(
    state,
    source,
    "step",
    `${step.jobId}.~${step.index}`,
    uses !== null ? `uses: ${uses}` : run !== null ? `run: ${run}` : (name ?? ""),
    step.value.node,
    metaOf([
      ["flavour", "actions"],
      ["if", scalarAt(step.value, "if")],
      ["name", name],
      ["run", run === null ? null : clipRun(run)],
      ["uses", uses],
      ["usesRef", uses === null ? null : refOf(uses)],
    ]),
  );
  const owner = localPath(declaration);

  if (literal(uses)) {
    addReference(state, owner, uses, "uses", lineOf(mapGet(step.value, "uses")?.node ?? step.value.node));
  }
  if (run !== null && runValue !== null) {
    for (const token of runPathTokens(run)) {
      addReference(state, owner, token, "config", lineOf(runValue.node));
    }
  }
}

/** A `run:` body as `meta.run`: whitespace collapsed, then the first 80 characters. */
function clipRun(body: string): string {
  return body.replace(/\s+/gu, " ").trim().slice(0, MAX_RUN_META);
}

/** The `@<ref>` of an action reference, without the `@`; null when it carries none. */
export function refOf(uses: string): string | null {
  const at = uses.lastIndexOf("@");
  return at <= 0 ? null : uses.slice(at + 1);
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

function collectJob(state: ActionsState, source: string, id: string, body: YamlValue): void {
  if (body.shape !== "map" || !usableName(id)) return;

  const uses = scalarAt(body, "uses");
  if (uses !== null) {
    // A job that delegates: no runner, no steps, and a name that is the job id.
    const task = addNode(
      state,
      source,
      "task",
      id,
      `uses: ${uses}`,
      body.node,
      metaOf([
        ["flavour", "actions"],
        ["if", scalarAt(body, "if")],
        ["name", scalarAt(body, "name")],
        ["uses", uses],
        ["usesRef", refOf(uses)],
      ]),
    );
    addExport(state, task.name);
    const owner = localPath(task);
    if (literal(uses)) {
      addReference(state, owner, uses, "uses", lineOf(mapGet(body, "uses")?.node ?? body.node));
    }
    collectNeeds(state, owner, body);
    return;
  }

  const job = addNode(
    state,
    source,
    "job",
    id,
    `job ${id}`,
    body.node,
    metaOf([
      ["flavour", "actions"],
      ["if", scalarAt(body, "if")],
      ["name", scalarAt(body, "name")],
      ["runsOn", scalarOrList(mapGet(body, "runs-on"))],
    ]),
  );
  addExport(state, job.name);
  const owner = localPath(job);
  collectNeeds(state, owner, body);

  const steps = mapGet(body, "steps");
  const items = seqItems(steps);
  for (let index = 0; index < items.length; index += 1) {
    // `job.name`, not the id's name segment: a step is named after the job id as written, and a
    // collision between two same-named jobs' steps is settled by `uniqueId` like any other.
    collectStep(state, source, { jobId: job.name, index, value: items[index] as YamlValue });
  }
}

/**
 * One export record per job *name*, in source order.
 *
 * Called as each job is walked rather than from a sweep of `state.decls`, so a file holding two
 * workflow documents does not re-publish the first document's jobs when the second is read.
 */
function addExport(state: ActionsState, name: string): void {
  if (state.exportedNames.has(name)) return;
  state.exportedNames.add(name);
  state.exports.push({ name, kind: "named" });
}

/** `needs: build` and `needs: [build, lint]`, one reference per named job. */
function collectNeeds(state: ActionsState, owner: string, body: YamlValue): void {
  for (const needed of scalarList(mapGet(body, "needs"))) {
    if (!literal(needed.text)) continue;
    addReference(state, owner, needed.text, "needs", lineOf(needed.node));
  }
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/** True for `action.yml` and `action.yaml`, the two names GitHub reads an action definition from. */
export function isActionDefinitionPath(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  return base === "action.yml" || base === "action.yaml";
}

function collectDocument(state: ActionsState, source: string, document: Node): void {
  const value = documentValue(document);
  if (value.shape !== "map") return;

  const jobs = mapGet(value, "jobs");
  if (jobs !== null && jobs.shape === "map") {
    for (const entry of jobs.entries) collectJob(state, source, entry.key, entry.value);
    return;
  }

  // A composite action: the steps of `runs.steps`, under the synthetic job id `runs`.
  if (!isActionDefinitionPath(state.path)) return;
  const steps = mapPath(value, "runs", "steps");
  const items = seqItems(steps);
  for (let index = 0; index < items.length; index += 1) {
    collectStep(state, source, { jobId: COMPOSITE_JOB_ID, index, value: items[index] as YamlValue });
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** What a flavour module gets back: everything but the file's own identity. */
type YamlParts = Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "refs">;

/**
 * Everything one GitHub Actions file says about itself. `lang` is always `"yaml"`; it is part
 * of the signature so this module mirrors `extractYamlK8s` and `extractHcl`.
 */
export function extractYamlActions(path: string, _lang: Lang, source: string, tree: Tree): YamlParts {
  const state: ActionsState = {
    path,
    decls: [],
    exports: [],
    refs: [],
    usedIds: new Set<string>(),
    exportedNames: new Set<string>(),
  };
  for (const document of yamlDocuments(tree.rootNode)) collectDocument(state, source, document);
  return {
    decls: state.decls,
    exports: state.exports,
    // A workflow has neither imports nor calls (spec 2.4 and `resolve/yaml.ts`): S3 is `n/a`
    // for every YAML target, and a stray specifier would be a bug in this file.
    imports: [],
    calls: [],
    refs: state.refs,
  };
}
