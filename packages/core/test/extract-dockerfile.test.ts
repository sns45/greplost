/**
 * Leaf 2.10: Dockerfile extraction, resolution and reference linking.
 *
 * Three layers, each tested on inline sources first and then pinned against
 * `fixtures/tiny-docker` end to end:
 *   - `extractDockerfile`, what one Dockerfile says about itself (spec 2.5,
 *                                     "Declarations"): one `stage` node per `FROM`, one `image`
 *                                     node for the final stage, `const`s for `ARG` and `ENV`;
 *   - `createDockerfileResolver`, a `COPY`/`ADD` source resolved to the one indexed repo
 *                                     file it names, and to nothing at all when it names none
 *                                     or more than one;
 *   - `resolveDockerfileReferences`, `from-image`, `copy-from` and `config` resolved to the
 *                                     node they name, at the confidence spec 0.3 fixes, or
 *                                     dropped rather than guessed.
 *
 * The `describe` names are fixed by spec section 2.6: `stages`, `base images`, `copy from`,
 * `args`, `tiny-docker`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractFile } from "../src/extract/index.ts";
import { buildSnapshot } from "../src/build.ts";
import { createDockerfileResolver, resolveDockerfileCall } from "../src/resolve/dockerfile.ts";
import { parseJsonl, serializeSnapshot } from "../src/serialize/index.ts";
import type { Confidence, Declaration, FileRecord, GreplostConfig, Snapshot } from "../src/schema.ts";
import { ARTIFACT_PATHS, DEFAULT_CONFIG, splitNodeId } from "../src/schema.ts";

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_DOCKER = path.join(REPO_ROOT, "fixtures", "tiny-docker");
const DOCKER_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["dockerfile"] };
/** The multi-language shape a real repo has: a Dockerfile beside the code it copies. */
const DOCKER_AND_TS_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["dockerfile", "ts"] };

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

function run(file: string, source: string): FileRecord {
  return extractFile({ path: file, lang: "dockerfile", source, sha256: ZERO_SHA }, parser);
}

function byId(record: FileRecord, id: string): Declaration {
  const found = record.decls.find((d) => d.id === id);
  if (!found) throw new Error(`no declaration with id ${id} in [${record.decls.map((d) => d.id).join(", ")}]`);
  return found;
}

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

/** Build a snapshot over a throwaway repo written from `files` (repo-relative path -> text). */
async function snapshotOf(
  files: Readonly<Record<string, string>>,
  config: GreplostConfig = DOCKER_CONFIG,
): Promise<Snapshot> {
  const dir = mkdtempSync(path.join(tmpdir(), "greplost-docker-"));
  temporaryDirs.push(dir);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  }
  return buildSnapshot({ root: dir, config });
}

/** `[to, symbol, confidence]` for every reference leaving `from`, in artifact order. */
function edgesFrom(snapshot: Snapshot, from: string): Array<[string, string, Confidence]> {
  return (snapshot.references ?? [])
    .filter((edge) => edge.from === from)
    .map((edge) => [edge.to, (edge.symbols ?? [])[0] ?? "", edge.confidence] as [string, string, Confidence]);
}

/** `<from> -<refKind>-> <to>` for every reference edge, in artifact order. */
function referenceKeys(snapshot: Snapshot): string[] {
  return (snapshot.references ?? []).map((edge) => `${edge.from} -${edge.refKind}-> ${edge.to}`);
}

// ---------------------------------------------------------------------------

describe("stages", () => {
  test("named and unnamed stages both get stable ids with meta.index", () => {
    const out = run("Dockerfile", "FROM node:20 AS build\nFROM scratch\n");
    expect(
      out.decls.filter((d) => d.kind === "stage").map((d) => [d.id, d.meta?.["base"], d.meta?.["index"]]),
    ).toEqual([
      ["Dockerfile#stage.build", "node:20", "0"],
      ["Dockerfile#stage.~1", "scratch", "1"],
    ]);
    // The index is a position written into the *name*, never a `#`: `nodeId` refuses a `#`
    // and `splitNodeId` must read every id back (spec 0.2, "Name characters").
    for (const decl of out.decls.filter((d) => d.kind === "stage")) {
      expect(splitNodeId(decl.id)).not.toBeNull();
      expect(decl.name).not.toContain("#");
    }
  });

  test("a duplicate stage name takes the ~<n> suffix in the id and never in the name", () => {
    const out = run("Dockerfile", "FROM a AS x\nFROM b AS x\nFROM c AS x\n");
    expect(out.decls.filter((d) => d.kind === "stage").map((d) => d.id)).toEqual([
      "Dockerfile#stage.x",
      "Dockerfile#stage.x~2",
      "Dockerfile#stage.x~3",
    ]);
    expect(out.decls.filter((d) => d.kind === "stage").map((d) => d.name)).toEqual(["x", "x", "x"]);
  });

  test("--platform lands in meta.platform and the base keeps its tag or digest", () => {
    const out = run(
      "Dockerfile",
      "FROM --platform=$BUILDPLATFORM node:20@sha256:abc AS build\nFROM alpine:3.20\n",
    );
    expect(byId(out, "Dockerfile#stage.build").meta).toEqual({
      base: "node:20@sha256:abc",
      index: "0",
      platform: "$BUILDPLATFORM",
    });
    expect(byId(out, "Dockerfile#stage.~1").meta).toEqual({ base: "alpine:3.20", index: "1" });
  });

  test("exported is true for a named stage and false for an unnamed one", () => {
    const out = run("Dockerfile", "FROM a AS build\nFROM b\n");
    expect(byId(out, "Dockerfile#stage.build").exported).toBe(true);
    expect(byId(out, "Dockerfile#stage.~1").exported).toBe(false);
    // Every stage is part of the file's surface, named or not: `Truth.exports` is the file's
    // sorted stage names (spec 2.5), and `COPY --from=1` addresses the unnamed one by index.
    expect(out.exports.map((e) => e.name)).toEqual(["build", "~1"]);
  });

  test("a stage spans its own instructions, and the final stage also yields the image node", () => {
    const out = run("Dockerfile", "FROM a AS build\nRUN x\n\nFROM b AS run\nENTRYPOINT [\"/s\"]\nCMD [\"-p\"]\n");
    expect(byId(out, "Dockerfile#stage.build").span).toEqual([1, 2]);
    expect(byId(out, "Dockerfile#stage.run").span).toEqual([4, 6]);
    const image = byId(out, "Dockerfile#image.run");
    expect(image.kind).toBe("image");
    expect(image.exported).toBe(false);
    expect(image.meta).toEqual({ cmd: '["-p"]', entrypoint: '["/s"]' });
    // Exactly one image node: the final stage is the one the build produces.
    expect(out.decls.filter((d) => d.kind === "image").map((d) => d.id)).toEqual(["Dockerfile#image.run"]);
  });

  test("a file with no FROM has no stage, no image node and no references", () => {
    const out = run("Dockerfile", "# nothing but a comment\n");
    expect(out.decls).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.imports).toEqual([]);
    expect(out.calls).toEqual([]);
  });

  test("nothing recovered from an ERROR region is published as if it had been read", () => {
    // tree-sitter-dockerfile v0.2.0 cannot read the legacy `ENV NAME a b c` form and wraps it,
    // and every instruction after it, in one `ERROR`. What the walk recovers from inside that
    // region is a fragment, so it is published as a fragment: the stage before it is real, the
    // constant is real but its value is not, and the final stage, the only thing an `image`
    // node can be named after, was never seen at all.
    const out = run("Dockerfile", "FROM alpine AS one\nENV NOTE a b c\nFROM alpine AS two\n");
    expect(out.decls.filter((d) => d.kind === "stage").map((d) => d.id)).toEqual(["Dockerfile#stage.one"]);
    // The real value is `a b c`; the grammar saw `a`. A default it cannot vouch for is dropped.
    expect(byId(out, "Dockerfile#env.NOTE").meta).toBeUndefined();
    // The real final stage is `two`. `image.one` would be a guess, so there is no image node.
    expect(out.decls.filter((d) => d.kind === "image")).toEqual([]);
  });

  test("an ERROR anywhere suppresses the image node, even for a stage read cleanly", () => {
    const out = run("Dockerfile", "FROM alpine AS one\nENV NOTE a b c\n");
    expect(out.decls.filter((d) => d.kind === "image")).toEqual([]);
    // A file the grammar reads whole still gets its image node, so the rule is the ERROR and
    // not the shape of the file.
    const clean = run("Dockerfile", "FROM alpine AS one\nENV NOTE=abc\n");
    expect(clean.decls.filter((d) => d.kind === "image").map((d) => d.id)).toEqual(["Dockerfile#image.one"]);
    expect(byId(clean, "Dockerfile#env.NOTE").meta).toEqual({ default: "abc" });
  });

  test("an entrypoint or cmd longer than 120 characters is clipped", () => {
    const long = "x".repeat(400);
    const out = run("Dockerfile", `FROM a\nCMD ${long}\n`);
    const cmd = byId(out, "Dockerfile#image.~0").meta?.["cmd"] ?? "";
    expect(cmd.length).toBe(120);
    expect(cmd.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("base images", () => {
  test("an external base image resolves to ext:image/<ref>", async () => {
    const snapshot = await snapshotOf({ Dockerfile: "FROM node:20 AS build\n" });
    expect(snapshot.references ?? []).toContainEqual({
      from: "Dockerfile#stage.build",
      to: "ext:image/node:20",
      kind: "reference",
      refKind: "from-image",
      symbols: ["node:20"],
      confidence: "high",
    });
  });

  test("a base that names an earlier stage in the same file points at that stage node", async () => {
    const snapshot = await snapshotOf({
      Dockerfile: "FROM node:20 AS build\nFROM build AS test\n",
    });
    expect(edgesFrom(snapshot, "Dockerfile#stage.test")).toEqual([
      ["Dockerfile#stage.build", "build", "high"],
    ]);
    // The earlier stage still points outward at the image it really pulls.
    expect(edgesFrom(snapshot, "Dockerfile#stage.build")).toEqual([["ext:image/node:20", "node:20", "high"]]);
  });

  test("a base built from a variable is not an image reference, so no edge is invented", async () => {
    const snapshot = await snapshotOf({
      Dockerfile: "ARG BASE=node:20\nFROM $BASE AS build\n",
    });
    expect(edgesFrom(snapshot, "Dockerfile#stage.build")).toEqual([]);
    // The text is still recorded, so the card can show what the file wrote.
    expect(snapshot.symbols.find((d) => d.id === "Dockerfile#stage.build")?.meta?.["base"]).toBe("$BASE");
  });

  test("an ambiguous stage name is dropped rather than guessed", async () => {
    const snapshot = await snapshotOf({
      Dockerfile: "FROM a AS dup\nFROM b AS dup\nFROM dup AS third\n",
    });
    expect(edgesFrom(snapshot, "Dockerfile#stage.third")).toEqual([]);
  });

  test("a stage name is matched the way docker matches it, ignoring case", async () => {
    const snapshot = await snapshotOf({ Dockerfile: "FROM node:20 AS Build\nFROM build AS run\n" });
    expect(edgesFrom(snapshot, "Dockerfile#stage.run")).toEqual([["Dockerfile#stage.Build", "build", "high"]]);
  });
});

// ---------------------------------------------------------------------------

describe("copy from", () => {
  test("COPY --from a sibling stage is a high-confidence copy-from edge", async () => {
    const snapshot = await snapshotOf({
      Dockerfile: "FROM node:20 AS build\nFROM scratch AS run\nCOPY --from=build /app /app\n",
    });
    expect(snapshot.references ?? []).toContainEqual({
      from: "Dockerfile#stage.run",
      to: "Dockerfile#stage.build",
      kind: "reference",
      refKind: "copy-from",
      symbols: ["build"],
      confidence: "high",
    });
  });

  test("COPY --from=<index> names the stage at that position", async () => {
    const snapshot = await snapshotOf({
      Dockerfile: "FROM node:20 AS build\nFROM scratch\nCOPY --from=0 /a /b\n",
    });
    expect(edgesFrom(snapshot, "Dockerfile#stage.~1")).toEqual([
      ["Dockerfile#stage.build", "0", "high"],
      ["ext:image/scratch", "scratch", "high"],
    ]);
  });

  test("COPY --from an image that is not a stage is an external image", async () => {
    const snapshot = await snapshotOf({
      Dockerfile: "FROM scratch AS run\nCOPY --from=alpine:3.20 /bin/busybox /bin/busybox\n",
    });
    expect(edgesFrom(snapshot, "Dockerfile#stage.run")).toEqual([
      ["ext:image/alpine:3.20", "alpine:3.20", "high"],
      ["ext:image/scratch", "scratch", "high"],
    ]);
  });

  test("a COPY --from copies out of another stage, so its sources are never repo paths", async () => {
    const snapshot = await snapshotOf({
      Dockerfile: "FROM scratch AS build\nFROM scratch AS run\nCOPY --from=build Dockerfile /d\n",
      // The source names an indexed file, and must still not become a `config` edge.
    });
    expect(referenceKeys(snapshot).filter((key) => key.includes("-config->"))).toEqual([]);
  });

  test("a stage cannot copy from itself: the self reference is dropped, never an image", async () => {
    // `COPY --from=build` inside stage `build` names a stage, so it is not an image reference;
    // `ext:image/build` would publish an external image nobody wrote.
    const snapshot = await snapshotOf({ Dockerfile: "FROM node:20 AS build\nCOPY --from=build /a /b\n" });
    expect(edgesFrom(snapshot, "Dockerfile#stage.build")).toEqual([["ext:image/node:20", "node:20", "high"]]);
    // The same for the positional form.
    const byIndex = await snapshotOf({ Dockerfile: "FROM node:20 AS build\nCOPY --from=0 /a /b\n" });
    expect(edgesFrom(byIndex, "Dockerfile#stage.build")).toEqual([["ext:image/node:20", "node:20", "high"]]);
  });

  test("an ambiguous or absent stage index is dropped rather than guessed", async () => {
    const snapshot = await snapshotOf({
      Dockerfile: "FROM scratch AS run\nCOPY --from=7 /a /b\n",
    });
    expect(edgesFrom(snapshot, "Dockerfile#stage.run")).toEqual([["ext:image/scratch", "scratch", "high"]]);
  });
});

// ---------------------------------------------------------------------------

describe("args", () => {
  test("top-level ARG and ENV become arg.<N> and env.<N> constants with literal defaults", () => {
    const out = run("Dockerfile", 'ARG NODE_VERSION=20\nFROM a\nENV NODE_ENV=production PORT="80"\n');
    expect(
      out.decls.filter((d) => d.kind === "const").map((d) => [d.id, d.name, d.meta?.["default"]]),
    ).toEqual([
      ["Dockerfile#arg.NODE_VERSION", "arg.NODE_VERSION", "20"],
      ["Dockerfile#env.NODE_ENV", "env.NODE_ENV", "production"],
      ["Dockerfile#env.PORT", "env.PORT", "80"],
    ]);
    // A `const` is a symbol, not a node: `splitNodeId` must refuse every one of them.
    for (const decl of out.decls.filter((d) => d.kind === "const")) {
      expect(splitNodeId(decl.id)).toBeNull();
      expect(decl.exported).toBe(false);
    }
  });

  test("the legacy space-separated ENV form is still a constant", () => {
    const out = run("Dockerfile", "FROM a\nENV LANG C.UTF-8\n");
    expect(byId(out, "Dockerfile#env.LANG").meta).toEqual({ default: "C.UTF-8" });
  });

  test("an ARG with no default, and a value built from a variable, carry no meta.default", () => {
    const out = run("Dockerfile", "ARG BARE\nFROM a\nENV PATH /usr/local/bin:$PATH\n");
    expect(byId(out, "Dockerfile#arg.BARE").meta).toBeUndefined();
    expect(byId(out, "Dockerfile#env.PATH").meta).toBeUndefined();
  });

  test("the same name declared twice takes the ~<n> suffix in the id only", () => {
    const out = run("Dockerfile", "FROM a AS one\nARG V=1\nFROM b AS two\nARG V=2\n");
    expect(out.decls.filter((d) => d.kind === "const").map((d) => [d.id, d.name])).toEqual([
      ["Dockerfile#arg.V", "arg.V"],
      ["Dockerfile#arg.V~2", "arg.V"],
    ]);
  });

  test("a constant is never an export and never a reference source", () => {
    const out = run("Dockerfile", "FROM a AS one\nARG V=1\n");
    expect(out.exports.map((e) => e.name)).toEqual(["one"]);
    expect((out.refs ?? []).map((r) => r.from)).toEqual(["stage.one"]);
  });
});

// ---------------------------------------------------------------------------

describe("tiny-docker", () => {
  let snapshot: Snapshot;
  let withTs: Snapshot;

  beforeAll(async () => {
    snapshot = await buildSnapshot({ root: TINY_DOCKER, config: DOCKER_CONFIG });
    withTs = await buildSnapshot({ root: TINY_DOCKER, config: DOCKER_AND_TS_CONFIG });
  });

  test("the basename rule indexes both Dockerfiles and nothing else", () => {
    expect(snapshot.files.map((f) => f.path)).toEqual(["Dockerfile", "Dockerfile.dev"]);
    expect(snapshot.files.every((f) => f.lang === "dockerfile")).toBe(true);
  });

  test("every stage, the final image node and the constants are declared", () => {
    // Sorted by (file, span start, id): the image node opens where its stage's `FROM` does.
    expect(snapshot.symbols.map((d) => `${d.kind} ${d.id}`)).toEqual([
      "const Dockerfile#arg.NODE_VERSION",
      "stage Dockerfile#stage.build",
      "const Dockerfile#env.NODE_ENV",
      "image Dockerfile#image.run",
      "stage Dockerfile#stage.run",
      "const Dockerfile#env.PORT",
      "image Dockerfile.dev#image.~0",
      "stage Dockerfile.dev#stage.~0",
      "const Dockerfile.dev#env.NODE_ENV",
    ]);
    expect(snapshot.symbols.find((d) => d.id === "Dockerfile#image.run")?.meta).toEqual({
      cmd: '["--enable-source-maps"]',
      entrypoint: '["/nodejs/bin/node", "/app/server.js"]',
    });
  });

  test("the manifest publishes each file's stage names", () => {
    expect(snapshot.manifest.files["Dockerfile"]?.exports).toEqual(["build", "run"]);
    expect(snapshot.manifest.files["Dockerfile.dev"]?.exports).toEqual(["~0"]);
  });

  test("every reference kind the fixture can resolve is an edge, and nothing else is", () => {
    expect(referenceKeys(snapshot)).toEqual([
      "Dockerfile#stage.build -from-image-> ext:image/node:20",
      "Dockerfile#stage.run -copy-from-> Dockerfile#stage.build",
      "Dockerfile#stage.run -from-image-> ext:image/gcr.io/distroless/nodejs20",
      "Dockerfile.dev#stage.~0 -from-image-> ext:image/node:20",
    ]);
  });

  test("a COPY source resolves to the one indexed file it names, at high confidence", () => {
    // `package.json` is a real file the fixture ships, but no language greplost indexes: with
    // only the source it does index in scope, `app/server.ts` is the one target there is.
    expect(referenceKeys(withTs)).toContain("Dockerfile#stage.build -config-> app/server.ts");
    expect(edgesFrom(withTs, "Dockerfile#stage.build")).toContainEqual([
      "app/server.ts",
      "app/server.ts",
      "high",
    ]);
    // A source that names nothing indexed is dropped, never guessed at.
    expect(referenceKeys(withTs).filter((key) => key.includes("package.json"))).toEqual([]);
  });

  test("references are written to graph/references.jsonl and node ids to graph/symbols.jsonl", () => {
    const artifacts = serializeSnapshot(snapshot);
    const references = parseJsonl(artifacts.get(ARTIFACT_PATHS.references) ?? "");
    expect(references.map((edge) => (edge as { to: string }).to)).toEqual([
      "ext:image/node:20",
      "Dockerfile#stage.build",
      "ext:image/gcr.io/distroless/nodejs20",
      "ext:image/node:20",
    ]);
    const symbols = parseJsonl(artifacts.get(ARTIFACT_PATHS.symbols) ?? "");
    const ids = symbols.map((decl) => (decl as { id: string }).id);
    expect(ids).toContain("Dockerfile#stage.build");
    expect(ids).toContain("Dockerfile#image.run");
    expect(ids).toContain("Dockerfile.dev#stage.~0");
  });

  test("the build is deterministic: the same repo twice gives byte-identical artifacts", async () => {
    const again = await buildSnapshot({ root: TINY_DOCKER, config: DOCKER_CONFIG });
    expect(serializeSnapshot(again)).toEqual(serializeSnapshot(snapshot));
  });

  test("the resolver answers for every specifier and never throws", () => {
    const ctx = {
      root: TINY_DOCKER,
      files: new Set(["Dockerfile", "app/server.ts"]),
      packages: [],
      readFile: () => null,
    };
    const resolve = createDockerfileResolver(ctx);
    expect(resolve("Dockerfile", "app/server.ts")).toEqual({ type: "file", path: "app/server.ts" });
    expect(resolve("Dockerfile", "./app/server.ts")).toEqual({ type: "file", path: "app/server.ts" });
    expect(resolve("Dockerfile", "app/*.ts")).toEqual({ type: "unresolved" });
    expect(resolve("Dockerfile", "/etc/passwd")).toEqual({ type: "unresolved" });
    expect(resolve("Dockerfile", "https://example.com/x.tar")).toEqual({ type: "unresolved" });
    expect(resolve("Dockerfile", ".")).toEqual({ type: "unresolved" });
    expect(resolve("Dockerfile", "$THING")).toEqual({ type: "unresolved" });
    // A Dockerfile has no calls at all, so the call hook is unreachable and says so.
    expect(() => resolveDockerfileCall(snapshot.files[0] as FileRecord, { caller: "", callee: "x", line: 1 }, {})).toThrow(
      /no call edges/,
    );
  });
});
