/**
 * Dockerfile extraction (build 2, spec 2026-09-04 section 2.5).
 *
 * A Dockerfile is a flat list of instructions with no nesting and no imports, so — like
 * Terraform — its graph is made of *references* rather than calls: this module produces no
 * `CallSite` at all (S3 is `n/a` for Dockerfiles, never 0) and fills `FileRecord.refs` with the
 * raw text of everything one instruction names.
 *
 * Three kinds of output, and the rules that decide each:
 *
 *  - **Declarations.** One `stage` node per `FROM`, named by its `AS <name>` alias or, when it
 *    has none, by its 0-based position; `meta.base`, `meta.index` and `meta.platform` carry
 *    what the instruction wrote. One `image` node for the **final** stage — the one the build
 *    actually produces — named after that stage, with `meta.entrypoint`/`meta.cmd` clipped to
 *    120 characters. `ARG` and `ENV` become `const` declarations named `arg.<N>`/`env.<N>`,
 *    with `meta.default` when the value is a literal.
 *  - **Exports.** Every stage name, which is the file's whole surface: another Dockerfile
 *    reaches a *named* stage with `COPY --from=<name>`, and `COPY --from=<index>` reaches an
 *    unnamed one by position. `Declaration.exported` is narrower on purpose and follows spec
 *    2.5 exactly: `true` only for a stage with an alias.
 *  - **References.** `from-image` for each stage's base, `copy-from` for a `COPY --from=…`,
 *    and `config` for each `COPY`/`ADD` source that could name a repo path. Nothing is
 *    resolved here: `references/dockerfile.ts` maps the text onto the one node it can mean, or
 *    drops it.
 *
 * The unnamed-stage name is `~<index>`, not the `#<index>` spec 0.2 sketches: `nodeId` refuses
 * a `#` in a name (it would make the id unreadable by `splitNodeId` and every card link a URL
 * fragment), and `~<index>` is the spelling `extract/yaml-k8s.ts` already uses for a document
 * with no usable name. The index is a position, never a hash, so adding a stage renumbers only
 * what comes after it.
 *
 * Two limits worth stating, because both are shared with the oracle and neither is a bug to be
 * found later:
 *
 *  - **The exec form of `COPY`/`ADD` contributes no source.** `COPY ["a", "b", "/d/"]` is a JSON
 *    array, not a list of `path` nodes, and neither this module nor `bench/src/truth/
 *    dockerfile.ts` takes sources out of it. Such an instruction produces no `config`
 *    reference on either side rather than a half-parsed one.
 *  - **Nothing recovered from an `ERROR` region is published as if it had been read.** The walk
 *    descends into an `ERROR` to keep what the grammar did recognise, but a declaration found
 *    there carries no `meta.default` (the text around it is exactly what the parser lost), and
 *    a file holding any `ERROR` gets no `image` node at all, because the final stage — the one
 *    thing an image node can be named after — may be inside the region that was lost.
 *
 * Nothing in this file reads the filesystem or knows about another file (tech spec 5.1).
 */

import type { Node, Tree } from "web-tree-sitter";
import type {
  DeclKind,
  Declaration,
  ExportRecord,
  FileRecord,
  Lang,
  RefKind,
  ReferenceRecord,
} from "../schema.ts";
import { compareStrings, nodeId, symbolId } from "../schema.ts";
import { clip, lineOf, spanOf } from "./ts-signature.ts";

/** `meta.entrypoint`/`meta.cmd` are capped here (spec 2.5). */
const MAX_COMMAND = 120;

/**
 * Instruction types the walk understands. Everything else (`RUN`, `LABEL`, `EXPOSE`, …) says
 * nothing about structure and is skipped rather than half-read.
 */
const FROM = "from_instruction";
const ARG = "arg_instruction";
const ENV = "env_instruction";
const COPY = "copy_instruction";
const ADD = "add_instruction";
const ENTRYPOINT = "entrypoint_instruction";
const CMD = "cmd_instruction";

/** The `--from` flag of a `COPY`/`ADD`, and the `--platform` flag of a `FROM`. */
const FROM_FLAG = "from";
const PLATFORM_FLAG = "platform";

// ---------------------------------------------------------------------------
// tree helpers
// ---------------------------------------------------------------------------

function namedChildOfType(node: Node, type: string): Node | null {
  for (const child of node.namedChildren) if (child.type === type) return child;
  return null;
}

function namedChildrenOfType(node: Node, type: string): Node[] {
  return node.namedChildren.filter((child) => child.type === type);
}

/**
 * A `--name=value` instruction flag, or null when the token is not one.
 *
 * The grammar hands flags back as opaque `param` nodes, so the split happens here. A flag with
 * no value (`--link`) has no value to give and yields null.
 */
function flagOf(node: Node): { name: string; value: string } | null {
  const text = node.text;
  if (!text.startsWith("--")) return null;
  const equals = text.indexOf("=");
  if (equals <= 2) return null;
  return { name: text.slice(2, equals).toLowerCase(), value: text.slice(equals + 1) };
}

/** The value of the named flag on an instruction, or null when it carries none. */
function flagValue(instruction: Node, name: string): string | null {
  for (const param of namedChildrenOfType(instruction, "param")) {
    const flag = flagOf(param);
    if (flag !== null && flag.name === name) return flag.value;
  }
  return null;
}

/** Text of a quoted or unquoted token, without its quotes. */
function tokenText(node: Node): string {
  const text = node.text;
  const quote = text[0];
  if (text.length >= 2 && (quote === '"' || quote === "'") && text.endsWith(quote)) return text.slice(1, -1);
  return text;
}

/**
 * A name that can be part of a node id.
 *
 * `nodeId` throws on `#`, a newline or NUL (spec 0.2, "Name characters"), and an extractor that
 * threw would fail the *whole build* over one file. A stage whose alias is unusable is named by
 * its index instead, which is the same answer an alias-less stage gets.
 */
function usableName(text: string): boolean {
  return text !== "" && !/[#\n\0]/u.test(text);
}

/** A value only the builder can compute is not a literal, and `meta` may not carry a guess. */
function isLiteral(text: string): boolean {
  return !text.includes("$");
}

/** Whitespace collapsed, clipped to `MAX_COMMAND` characters (spec 2.5). */
function clipCommand(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_COMMAND ? `${flat.slice(0, MAX_COMMAND - 1)}…` : flat;
}

/** `meta` with sorted keys, or undefined when nothing was recorded. */
function metaOf(entries: ReadonlyArray<readonly [string, string | null]>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of [...entries].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (value !== null) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// ---------------------------------------------------------------------------
// accumulator
// ---------------------------------------------------------------------------

/** One `FROM` and everything the instructions under it said. */
interface Stage {
  readonly declaration: Declaration;
  readonly index: number;
  entrypoint: string | null;
  cmd: string | null;
  /** Last line seen inside this stage, so the stage's span covers its own instructions. */
  lastLine: number;
}

interface DockerState {
  readonly path: string;
  readonly decls: Declaration[];
  readonly exports: ExportRecord[];
  readonly refs: ReferenceRecord[];
  readonly stages: Stage[];
  /** Declaration ids already used in this file, so a duplicate name can take a `~<n>` suffix. */
  readonly usedIds: Set<string>;
  /** Exported names already recorded, so two stages with one alias are one export. */
  readonly exportedNames: Set<string>;
  /**
   * True once the walk has seen an `ERROR` node anywhere in the file.
   *
   * The grammar's `ERROR` swallows the instruction it choked on *and every instruction after
   * it*, so a file holding one has an unknown tail: the stage the walk thinks is last may not
   * be, and an `image` node named after it would be a guess wearing an id.
   */
  sawError: boolean;
}

/**
 * A declaration id made unique within the file: `…#stage.build`, then `…#stage.build~2`.
 *
 * The suffix lives in the **id and nowhere else** (driver ruling 2026-09-04): `name` stays as
 * the file wrote it, because it is what a `COPY --from` writes and what the export index
 * publishes. Two stages with one alias are then correctly *ambiguous* to the linker rather
 * than silently distinguishable — which is right, because `docker build` refuses such a file.
 */
function uniqueId(state: DockerState, kind: DeclKind, name: string, isNode: boolean): string {
  const base = isNode ? nodeId(state.path, kind, name) : symbolId(state.path, name);
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

function addDeclaration(
  state: DockerState,
  kind: DeclKind,
  name: string,
  signature: string,
  span: [number, number],
  exported: boolean,
  meta: Record<string, string> | undefined,
): Declaration {
  const declaration: Declaration = {
    id: uniqueId(state, kind, name, kind !== "const"),
    file: state.path,
    name,
    kind,
    signature,
    exported,
    span,
    ...(meta === undefined ? {} : { meta }),
  };
  state.decls.push(declaration);
  return declaration;
}

/** The part of a declaration's id after the `#`: what a `ReferenceRecord.from` must carry. */
function localPath(state: DockerState, declaration: Declaration): string {
  return declaration.id.slice(state.path.length + 1);
}

/** The stage the instruction being read belongs to, or null before the first `FROM`. */
function currentStage(state: DockerState): Stage | null {
  return state.stages.length === 0 ? null : (state.stages[state.stages.length - 1] as Stage);
}

/** A reference from the current stage, or from the file itself before the first `FROM`. */
function addReference(state: DockerState, to: string, refKind: RefKind, line: number): void {
  if (to === "") return;
  const stage = currentStage(state);
  state.refs.push({
    from: stage === null ? "" : localPath(state, stage.declaration),
    to,
    refKind,
    line,
  });
}

// ---------------------------------------------------------------------------
// instructions
// ---------------------------------------------------------------------------

function collectFrom(state: DockerState, instruction: Node): void {
  const index = state.stages.length;
  const spec = namedChildOfType(instruction, "image_spec");
  const base = spec === null ? "" : spec.text;
  const alias = namedChildOfType(instruction, "image_alias");
  const named = alias !== null && usableName(alias.text);
  const name = named ? (alias as Node).text : `~${index}`;
  const line = lineOf(instruction);

  const declaration = addDeclaration(
    state,
    "stage",
    name,
    clip(instruction.text),
    // Widened to the whole stage once the next `FROM` (or the end of the file) says where it
    // stops: a stage is a range of instructions, not the one line that opens it.
    [line, spanOf(instruction)[1]],
    named,
    metaOf([
      ["base", base === "" ? null : base],
      ["index", String(index)],
      ["platform", flagValue(instruction, PLATFORM_FLAG)],
    ]),
  );
  state.stages.push({ declaration, index, entrypoint: null, cmd: null, lastLine: spanOf(instruction)[1] });

  // Every stage is part of the file's surface (spec 2.5, `Truth.exports`); a repeated alias is
  // one export, not two.
  if (!state.exportedNames.has(name)) {
    state.exportedNames.add(name);
    state.exports.push({ name, kind: "named" });
  }

  addReference(state, base, "from-image", line);
}

/** `ARG NAME[=default]` — one constant named `arg.<NAME>`. */
function collectArg(state: DockerState, instruction: Node, recovered: boolean): void {
  const name = instruction.childForFieldName("name");
  if (name === null || !usableName(name.text)) return;
  const value = instruction.childForFieldName("default");
  addConstant(state, "arg", name.text, value, instruction, recovered);
}

/** `ENV A=1 B=2`, and the legacy `ENV A 1` — one constant per pair, named `env.<NAME>`. */
function collectEnv(state: DockerState, instruction: Node, recovered: boolean): void {
  for (const pair of namedChildrenOfType(instruction, "env_pair")) {
    const name = pair.childForFieldName("name");
    if (name === null || !usableName(name.text)) continue;
    addConstant(state, "env", name.text, pair.childForFieldName("value"), pair, recovered);
  }
}

/**
 * One `ARG`/`ENV` constant.
 *
 * `recovered` says the declaration was found *inside* an `ERROR` region, and it is the reason
 * `meta.default` is dropped there: the grammar choked on this very instruction, so the value it
 * managed to read is a prefix of the real one (`ENV NOTE a b c` yields `a`). The name survives
 * because it is the part the parser did get right; a value it cannot vouch for does not.
 */
function addConstant(
  state: DockerState,
  prefix: "arg" | "env",
  name: string,
  value: Node | null,
  node: Node,
  recovered: boolean,
): void {
  const text = value === null || recovered ? null : tokenText(value);
  addDeclaration(
    state,
    "const",
    `${prefix}.${name}`,
    clip(node.text),
    spanOf(node),
    false,
    metaOf([["default", text !== null && isLiteral(text) ? text : null]]),
  );
}

/**
 * `COPY`/`ADD`: either one `copy-from` (the instruction copies out of another build stage or
 * image) or one `config` per source path (it copies out of the build context).
 *
 * The two are exclusive, and that is the point: with `--from`, the sources are paths inside
 * *another image's* filesystem and naming a repo file that happens to match would be a
 * fabricated edge. The last path is the destination and is never a source.
 */
function collectCopy(state: DockerState, instruction: Node): void {
  const line = lineOf(instruction);
  const from = flagValue(instruction, FROM_FLAG);
  if (from !== null) {
    addReference(state, from, "copy-from", line);
    return;
  }
  const paths = namedChildrenOfType(instruction, "path");
  if (paths.length < 2) return;
  for (const source of paths.slice(0, -1)) addReference(state, tokenText(source), "config", line);
}

/** `ENTRYPOINT`/`CMD`: the last one in a stage is the one the image runs. */
function collectCommand(state: DockerState, instruction: Node, key: "entrypoint" | "cmd"): void {
  const stage = currentStage(state);
  if (stage === null) return;
  const args = instruction.namedChildren.find((child) => child.type !== "param");
  const text = args === undefined ? "" : clipCommand(args.text);
  if (text === "") return;
  if (key === "entrypoint") stage.entrypoint = text;
  else stage.cmd = text;
}

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

function collectInstruction(state: DockerState, instruction: Node, recovered: boolean): void {
  switch (instruction.type) {
    case FROM:
      collectFrom(state, instruction);
      return;
    case ARG:
      collectArg(state, instruction, recovered);
      break;
    case ENV:
      collectEnv(state, instruction, recovered);
      break;
    case COPY:
    case ADD:
      collectCopy(state, instruction);
      break;
    case ENTRYPOINT:
      collectCommand(state, instruction, "entrypoint");
      break;
    case CMD:
      collectCommand(state, instruction, "cmd");
      break;
    default:
      break;
  }
  const stage = currentStage(state);
  if (stage !== null) stage.lastLine = Math.max(stage.lastLine, spanOf(instruction)[1]);
}

/**
 * Every instruction of the file, in source order.
 *
 * `ERROR` nodes are descended into rather than skipped: tree-sitter-dockerfile v0.2.0 cannot
 * read the legacy `ENV NAME a b c` form (a value with spaces and no `=`) and wraps it, with
 * everything that follows, in one `ERROR`. Reading the instructions it did recognise inside
 * that node recovers what can be recovered; the rest of the file is genuinely lost to the
 * grammar, and `unparsable.ts` is what reports it.
 */
function walk(state: DockerState, node: Node, recovered: boolean): void {
  for (const child of node.namedChildren) {
    if (child.type === "ERROR") {
      state.sawError = true;
      walk(state, child, true);
      continue;
    }
    collectInstruction(state, child, recovered);
  }
}

/**
 * The `image` node for the final stage, and the stage spans that could only be known at the end.
 *
 * A Dockerfile builds exactly one image — the last stage — and every earlier stage is an
 * intermediate the build throws away, which is why `image` is not one node per `FROM`.
 */
function finish(state: DockerState): void {
  for (const stage of state.stages) {
    const start = stage.declaration.span[0];
    stage.declaration.span = [start, Math.max(stage.lastLine, start)];
  }

  // A file the grammar could not read whole has an unknown tail, and the image node is named
  // after the *last* stage: `FROM a AS one` / `ENV NOTE a b c` / `FROM a AS two` really builds
  // `two`, and the walk can only see `one`. Publishing `image.one` would be a guess, so a file
  // holding any `ERROR` gets no image node — a miss the oracle can catch, never a wrong id.
  const final = state.sawError ? undefined : state.stages[state.stages.length - 1];
  if (final === undefined) return;
  addDeclaration(
    state,
    "image",
    final.declaration.name,
    final.declaration.signature,
    [...final.declaration.span],
    false,
    metaOf([
      ["cmd", final.cmd],
      ["entrypoint", final.entrypoint],
    ]),
  );
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Everything one Dockerfile says about itself. `lang` is always `"dockerfile"`; it is part of
 * the signature so this module mirrors `extractHcl` and `extractTs`.
 */
export function extractDockerfile(
  path: string,
  _lang: Lang,
  _source: string,
  tree: Tree,
): Pick<FileRecord, "decls" | "imports" | "exports" | "calls" | "refs"> {
  const state: DockerState = {
    path,
    decls: [],
    exports: [],
    refs: [],
    stages: [],
    usedIds: new Set<string>(),
    exportedNames: new Set<string>(),
    sawError: false,
  };

  walk(state, tree.rootNode, false);
  finish(state);

  return {
    decls: state.decls,
    // A Dockerfile has no import statement and no call site at all (spec 2.5): S3 is `n/a` for
    // every Dockerfile target, and S1 has nothing to be right or wrong about.
    imports: [],
    exports: state.exports,
    calls: [],
    refs: state.refs,
  };
}
