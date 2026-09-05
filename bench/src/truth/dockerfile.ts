/**
 * Dockerfile truth for Eval 1 (spec 2026-09-04 section 2.5, bench spec 5.2).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2), so nothing
 * here imports greplost's extractor, resolver or tree-sitter. The oracle is **dockerfile-ast**,
 * the parser behind Microsoft's Docker language server: `DockerfileParser.parse(source)` hands
 * back the instruction list with its ranges, and everything below is computed from that.
 *
 * That makes it an *independent implementation of the same documented rules*, which is the most
 * an oracle can be for a format whose semantics are "what the file says" — the
 * `same-rules-different-parser` note states the residual plainly. Where the two parsers really
 * do disagree, and it matters:
 *
 *  - tree-sitter-dockerfile v0.2.0 cannot read the legacy `ENV NAME a b c` form (a value with
 *    spaces and no `=`) and turns the rest of the file into one `ERROR`; dockerfile-ast reads
 *    it. Such a file is a genuine difference and is scored as one, which is what makes the
 *    grammar's limit visible instead of invisible.
 *  - dockerfile-ast resolves the escape directive (`# escape=\``) and line continuations from
 *    the document itself; greplost's grammar has its own rules for both.
 *  - `Copy.getFromFlag()` is unreliable in dockerfile-ast 0.7.1 when an instruction carries
 *    more than one flag, so the `--from` value is read off `getFlags()` instead.
 *
 * What it produces, in greplost's id vocabulary:
 *
 *   files       the Dockerfiles it could read; the harness intersects both sides with this;
 *   imports     always empty: a Dockerfile has no import statement at all;
 *   exports     each file's sorted stage names — a Dockerfile's public surface is its stages,
 *               reachable by alias with `COPY --from=<name>` and by position with
 *               `COPY --from=<index>`;
 *   calls       always empty, which is why S3 is `n/a` for Dockerfiles and never 0;
 *   references  the S5 truth: `from-image`, `copy-from` and `config` resolved the same way;
 *   nodes       every `stage` and `image` node id, so the node set is scored alongside the
 *               edges (S6).
 *
 * Two things it deliberately does not state. `meta.entrypoint`/`meta.cmd` are declaration
 * *attributes*, and nothing scores an attribute — S6 compares node ids — so reading `ENTRYPOINT`
 * and `CMD` here would be a derivation no gate could ever check. And the exec form of
 * `COPY`/`ADD` (`COPY ["a", "b", "/d/"]`) is a JSON array rather than a list of path arguments:
 * neither this module nor `packages/core/src/extract/dockerfile.ts` takes sources out of one, so
 * such an instruction produces no `config` reference on either side.
 *
 * An empty result is an error, never a score: a run where the parser loaded nothing would
 * otherwise report vacuous 1.000s and pass the gate.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { DockerfileParser } from "dockerfile-ast";
import { compareEdges, compareStrings, type Edge } from "@greplost/core/schema";
import type { Truth } from "./ts.ts";

/**
 * Oracle choices this generator applies, for `RESULTS.md` to disclose.
 *
 * `same-rules-different-parser` is the honest residual: dockerfile-ast is a different parser,
 * written by different people, but spec 2.5's rules are re-implemented over its instruction
 * list here, so these numbers measure "does the tree-sitter extractor see what the Docker
 * language server sees" rather than "are spec 2.5's rules the right rules".
 */
export const NOTES: readonly string[] = ["dockerfile-ast-oracle", "same-rules-different-parser"];

/**
 * Three metrics are not misses for a Dockerfile, they are unmeasurable, and saying so is not
 * the same as scoring 1.000 by finding nothing (driver ruling 2026-09-05, applied to the YAML
 * oracles too). The format has no call site (S3), no import statement (S1) and therefore no
 * import cycle (S4); `structural.ts` reads this spelling out of the notes and prints `n/a`
 * (leaf 2.0 ruling R10), and nothing is inferred. S2, S5 and S6 stay measured and gated: they
 * are the stage names, the reference edges and the node ids, which is everything this format
 * actually says.
 */
const UNSUPPORTED = ["unsupported:S1", "unsupported:S3", "unsupported:S4"] as const;

/** Characters that make a `COPY` source a pattern rather than a name. */
const GLOB_CHARACTERS = /[*?[\]{}]/u;

/** A `--from=<n>` that names a stage by its position rather than by an alias. */
const STAGE_INDEX = /^\d+$/u;

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** A name `nodeId` would accept (spec 0.2, "Name characters"). */
function usableName(value: string | null): value is string {
  return value !== null && value !== "" && !/[#\n\0]/u.test(value);
}

/** A value only the builder can compute is not a literal. */
function isLiteral(text: string): boolean {
  return !text.includes("$");
}

/** Directory of a repo-relative path; `""` for a file at the repo root. */
function directoryOf(file: string): string {
  const index = file.lastIndexOf("/");
  return index === -1 ? "" : file.slice(0, index);
}

/** Join and normalise, returning null when the result escapes the repo root. */
function normalizeJoin(dir: string, rest: string): string | null {
  const segments: string[] = [];
  for (const segment of `${dir}/${rest}`.replace(/\\/gu, "/").split("/")) {
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

/** A `COPY`/`ADD` source that could name exactly one file in the build context. */
function isContextPath(source: string): boolean {
  if (source === "" || source === "." || source === "..") return false;
  if (source.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(source)) return false;
  if (source.includes("://")) return false;
  if (source.includes("$") || GLOB_CHARACTERS.test(source)) return false;
  if (source.endsWith("/")) return false;
  return !/[\n\0]/u.test(source);
}

/** The value of a named flag, read off `getFlags()` because `getFromFlag()` misses (see above). */
function flagValue(instruction: { getFlags(): Array<{ getName(): string; getValue(): string | null }> }, name: string): string | null {
  for (const flag of instruction.getFlags()) {
    if (flag.getName().toLowerCase() === name) return flag.getValue();
  }
  return null;
}

// ---------------------------------------------------------------------------
// the node and edge sets
// ---------------------------------------------------------------------------

/** One `FROM` and what the instructions under it said. */
interface OracleStage {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly base: string;
}

/** A build-time or run-time constant: `ARG`/`ENV`, which spec 2.5 makes a `const`. */
export interface OracleConstant {
  readonly id: string;
  readonly name: string;
  /** The literal default, or null when the value is absent or built from a variable. */
  readonly value: string | null;
}

/** A reference before resolution: what the instruction asked for, and who asked. */
interface OracleRequest {
  readonly from: string;
  /** The index of the stage that asked, so a base can only name an earlier one. */
  readonly fromIndex: number;
  readonly text: string;
  readonly refKind: "from-image" | "copy-from" | "config";
}

interface FileReading {
  readonly stages: OracleStage[];
  readonly constants: OracleConstant[];
  /** Stage and image node ids, in source order. */
  readonly nodes: string[];
  readonly requests: OracleRequest[];
}

/** One file's Dockerfile, or null when it could not be read at all. */
function sourceOf(root: string, file: string): string | null {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return null;
  }
}

/** Everything one Dockerfile declares and asks for, by the rules of spec 2.5. */
function readFile(root: string, file: string): FileReading | null {
  const source = sourceOf(root, file);
  if (source === null) return null;

  const instructions = DockerfileParser.parse(source).getInstructions();
  const used = new Set<string>();
  /** The uniqueness suffix rule, restated: `build`, then `build~2` (driver ruling 2026-09-04). */
  const unique = (kind: string, name: string): string => {
    let candidate = `${file}#${kind}.${name}`;
    for (let n = 2; used.has(candidate); n += 1) candidate = `${file}#${kind}.${name}~${n}`;
    used.add(candidate);
    return candidate;
  };

  const stages: OracleStage[] = [];
  const constants: OracleConstant[] = [];
  const nodes: string[] = [];
  const requests: OracleRequest[] = [];

  for (const instruction of instructions) {
    const keyword = instruction.getKeyword().toUpperCase();
    switch (keyword) {
      case "FROM": {
        const from = instruction as unknown as {
          getImage(): string | null;
          getBuildStage(): string | null;
          getFlags(): Array<{ getName(): string; getValue(): string | null }>;
        };
        const index = stages.length;
        const alias = from.getBuildStage();
        const name = usableName(alias) ? alias : `~${index}`;
        const base = from.getImage() ?? "";
        const id = unique("stage", name);
        stages.push({ id, name, index, base });
        nodes.push(id);
        if (base !== "") requests.push({ from: id, fromIndex: index, text: base, refKind: "from-image" });
        break;
      }
      case "ARG":
      case "ENV": {
        const owner = keyword === "ARG" ? "arg" : "env";
        const properties = (instruction as unknown as {
          getProperties?: () => Array<{ getName(): string; getValue(): string | null }>;
          getProperty?: () => { getName(): string; getValue(): string | null } | null;
        });
        const list =
          properties.getProperties !== undefined
            ? properties.getProperties()
            : [properties.getProperty?.() ?? null].filter((p): p is { getName(): string; getValue(): string | null } => p !== null);
        for (const property of list) {
          const name = property.getName();
          if (!usableName(name)) continue;
          const value = property.getValue();
          constants.push({
            id: `${file}#${owner}.${name}`,
            name: `${owner}.${name}`,
            value: value !== null && value !== "" && isLiteral(value) ? value : null,
          });
        }
        break;
      }
      case "COPY":
      case "ADD": {
        const stage = stages[stages.length - 1];
        if (stage === undefined) break;
        const copy = instruction as unknown as {
          getArguments(): Array<{ getValue(): string }>;
          getFlags(): Array<{ getName(): string; getValue(): string | null }>;
        };
        const from = flagValue(copy, "from");
        if (from !== null && from !== "") {
          requests.push({ from: stage.id, fromIndex: stage.index, text: from, refKind: "copy-from" });
          break;
        }
        const args = copy.getArguments().map((argument) => argument.getValue());
        if (args.length < 2) break;
        for (const src of args.slice(0, -1)) {
          requests.push({ from: stage.id, fromIndex: stage.index, text: src, refKind: "config" });
        }
        break;
      }
      default:
        break;
    }
  }

  // One `image` node for the final stage: a Dockerfile builds exactly one image, and every
  // earlier stage is an intermediate the build throws away.
  const final = stages[stages.length - 1];
  if (final !== undefined) nodes.push(unique("image", final.name));

  return { stages, constants, nodes, requests };
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
      `greplost: dockerfile truth is empty for ${absRoot} ` +
        `(dockerfile-ast read none of the ${files.length} requested file(s))`,
    );
  }
  // A Dockerfile without a `FROM` is not a Dockerfile: a whole target with no stage anywhere
  // means the parser produced nothing, and a silent zero would score as a perfect run.
  let stages = 0;
  for (const reading of readings.values()) stages += reading.stages.length;
  if (files.length > 0 && stages === 0) {
    throw new Error(
      `greplost: dockerfile truth is empty for ${absRoot} ` +
        `(dockerfile-ast found no FROM in any of the ${readings.size} file(s) it read)`,
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
 * Dockerfile truth for `files` (repo-relative posix paths) under `root`.
 *
 * `exports` is each covered file's sorted stage names; `imports`, `calls` and `cycles` are all
 * empty, because a Dockerfile has none of them and saying so is not the same as failing to
 * find any.
 */
export function generateTruth(root: string, files: string[]): Truth {
  const { covered, readings } = coveredRun(root, files);
  const exports: Record<string, string[]> = {};
  for (const file of covered) {
    const reading = readings.get(file) as FileReading;
    exports[file] = [...new Set(reading.stages.map((stage) => stage.name))].sort(compareStrings);
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
 * Resolution is per file and unique, exactly as spec 2.5 states it: a base naming exactly one
 * earlier stage, a `--from` naming exactly one stage by alias or by position, a `COPY` source
 * naming exactly one file of the scored set. Anything ambiguous produces no edge on this side
 * either, so an oracle can never demand a guess.
 */
export function generateExtra(root: string, files: string[]): { references: Edge[]; nodes: string[] } {
  const { covered, readings } = coveredRun(root, files);
  const indexed = new Set(covered);

  const nodes: string[] = [];
  const references: ReferenceTruth[] = [];

  for (const file of covered) {
    const reading = readings.get(file) as FileReading;
    for (const id of reading.nodes) nodes.push(id);

    for (const request of reading.requests) {
      if (request.refKind === "config") {
        const target = resolveContextPath(file, request.text, indexed);
        if (target !== null) references.push(edge(request.from, target, "config", request.text));
        continue;
      }
      if (request.refKind === "copy-from" && STAGE_INDEX.test(request.text)) {
        const position = Number.parseInt(request.text, 10);
        const found = reading.stages.filter((stage) => stage.index === position && stage.id !== request.from);
        if (found.length === 1) {
          references.push(edge(request.from, (found[0] as OracleStage).id, "copy-from", request.text));
        }
        continue;
      }
      const limit = request.refKind === "from-image" ? request.fromIndex : Number.POSITIVE_INFINITY;
      const wanted = request.text.toLowerCase();
      const named = reading.stages.filter((stage) => stage.name.toLowerCase() === wanted && stage.index < limit);
      if (named.length === 1 && (named[0] as OracleStage).id !== request.from) {
        references.push(edge(request.from, (named[0] as OracleStage).id, request.refKind, request.text));
        continue;
      }
      // A text naming a stage of this file names a stage — ambiguously when two carry the
      // alias, and itself when the stage copies from itself, which is a file docker refuses.
      // Either way it is dropped rather than turned into an image reference nobody wrote.
      if (named.length > 0) continue;
      // An image reference built from a build variable is not an image reference.
      if (request.text.includes("$")) continue;
      references.push(edge(request.from, `ext:image/${request.text}`, request.refKind, request.text));
    }
  }

  references.sort(compareEdges);
  return { references: dedupe(references), nodes: nodes.sort(compareStrings) };
}

/**
 * A `COPY`/`ADD` source resolved against the two contexts a build plausibly uses — the
 * Dockerfile's own directory and the repository root — or null when they do not agree on one
 * scored file.
 */
function resolveContextPath(file: string, source: string, indexed: ReadonlySet<string>): string | null {
  if (!isContextPath(source)) return null;
  const candidates = new Set<string>();
  for (const base of [directoryOf(file), ""]) {
    const candidate = normalizeJoin(base, source);
    if (candidate !== null && indexed.has(candidate)) candidates.add(candidate);
  }
  return candidates.size === 1 ? ([...candidates][0] as string) : null;
}

/**
 * Every `ARG` and `ENV` the oracle read, by file: the constants spec 2.5 makes `const`
 * declarations.
 *
 * They are not node ids, so S6 never scores them and `generateExtra` leaves them out. This is
 * how the derivation stays exercised rather than written and forgotten — `truth-dockerfile.
 * test.ts` pins it against the fixture.
 */
export function constantsOf(root: string, files: string[]): Record<string, OracleConstant[]> {
  const { covered, readings } = coveredRun(root, files);
  const out: Record<string, OracleConstant[]> = {};
  for (const file of covered) out[file] = [...(readings.get(file) as FileReading).constants];
  return out;
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
