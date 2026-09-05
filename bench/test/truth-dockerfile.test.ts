/**
 * Dockerfile truth generator tests (leaf 2.10, gates G7 and G8).
 *
 * Everything in `dockerfile-ast oracle` is read off `fixtures/tiny-docker` by hand and pinned:
 * these are the numbers the Dockerfile structure layer is scored against, so they are written
 * out in full rather than recomputed from the thing under test.
 *
 * `oracle independence` is the integrity check of tech spec 10.1 principle 2: the oracle may
 * not be able to agree with greplost by construction, so it may import neither tree-sitter nor
 * any of greplost's extract/resolve/reference modules, and its answer has to move when the
 * fixture moves.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type GreplostConfig } from "@greplost/core/schema";
import { NOTES, constantsOf, generateExtra, generateTruth } from "../src/truth/dockerfile.ts";
import { edgeKey, exportKeys, scoreSet } from "../src/score.ts";
import { loadTruth } from "../src/truth/registry.ts";
import { FIXTURES } from "../src/fixtures.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const dockerRoot = path.join(repoRoot, "fixtures", "tiny-docker");

/** Exactly the files the harness scores: `langOf` maps these two and nothing else here. */
const DOCKER_FILES = ["Dockerfile", "Dockerfile.dev"];

const DOCKER_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["dockerfile"] };

const truth = generateTruth(dockerRoot, DOCKER_FILES);
const extra = generateExtra(dockerRoot, DOCKER_FILES);

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

const keys = (edges: ReadonlyArray<{ from: string; to: string }>): string[] => edges.map(edgeKey);

// ---------------------------------------------------------------------------

describe("dockerfile-ast oracle", () => {
  test("the truth registry finds the generator by convention and it declares its oracle", async () => {
    const mod = await loadTruth("dockerfile");
    expect(typeof mod.generateTruth).toBe("function");
    expect(typeof mod.generateExtra).toBe("function");
    expect(mod.NOTES).toEqual(NOTES);
    expect(NOTES).toEqual(["dockerfile-ast-oracle", "same-rules-different-parser"]);
    expect(FIXTURES["tiny-docker"]?.lang).toBe("dockerfile");
  });

  test("truth covers exactly the indexed Dockerfiles, and neither imports nor calls exist", () => {
    expect(truth.files).toEqual(DOCKER_FILES);
    expect(truth.imports).toEqual([]);
    expect(truth.calls).toEqual([]);
    expect(truth.cycles).toEqual([]);
    expect(truth.notes).toContain("unsupported:S3");
    expect(truth.notes).toContain("dockerfile-ast-oracle");
  });

  test("exports are each file's sorted stage names, and every covered file is a key", () => {
    expect(truth.exports).toEqual({
      Dockerfile: ["build", "run"],
      "Dockerfile.dev": ["~0"],
    });
  });

  test("the node set is every stage and the one image each file builds", () => {
    expect(extra.nodes).toEqual([
      "Dockerfile#image.run",
      "Dockerfile#stage.build",
      "Dockerfile#stage.run",
      "Dockerfile.dev#image.~0",
      "Dockerfile.dev#stage.~0",
    ]);
  });

  test("the reference set carries the base images and the COPY --from", () => {
    expect(keys(extra.references)).toEqual([
      "Dockerfile#stage.build -> ext:image/node:20",
      "Dockerfile#stage.run -> Dockerfile#stage.build",
      "Dockerfile#stage.run -> ext:image/gcr.io/distroless/nodejs20",
      "Dockerfile.dev#stage.~0 -> ext:image/node:20",
    ]);
    // Every edge carries its `refKind`, which is what makes the S5 key (from, to, refKind).
    expect(extra.references.every((edge) => typeof (edge as { refKind?: string }).refKind === "string")).toBe(true);
    expect(extra.references.map((edge) => (edge as unknown as { refKind: string }).refKind)).toEqual([
      "from-image",
      "copy-from",
      "from-image",
      "from-image",
    ]);
  });

  test("a COPY source resolves only against the scored file set, so package.json is not an edge", () => {
    // `app/server.ts` is a real target for `COPY app/server.ts`, but a Dockerfile-only run
    // scores Dockerfiles: neither side may claim an edge to a file it was not shown.
    expect(keys(extra.references).some((key) => key.includes("package.json"))).toBe(false);
    expect(keys(extra.references).some((key) => key.includes("server.ts"))).toBe(false);
    // Shown the source file, the same rule produces the edge.
    const withSource = generateExtra(dockerRoot, [...DOCKER_FILES, "app/server.ts"]);
    expect(keys(withSource.references)).toContain("Dockerfile#stage.build -> app/server.ts");
  });

  test("ARG and ENV are derived from the instruction list, with literal defaults only", () => {
    expect(constantsOf(dockerRoot, DOCKER_FILES)).toEqual({
      Dockerfile: [
        { id: "Dockerfile#arg.NODE_VERSION", name: "arg.NODE_VERSION", value: "20" },
        { id: "Dockerfile#env.NODE_ENV", name: "env.NODE_ENV", value: "production" },
        { id: "Dockerfile#env.PORT", name: "env.PORT", value: "8080" },
      ],
      "Dockerfile.dev": [
        { id: "Dockerfile.dev#env.NODE_ENV", name: "env.NODE_ENV", value: "development" },
      ],
    });
  });

  test("an empty truth is an error, never a score", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "greplost-docker-empty-"));
    temporaryDirs.push(empty);
    expect(() => generateTruth(empty, ["Dockerfile"])).toThrow(/dockerfile truth is empty/);
    // A file the parser reads but that declares no stage is the other empty: also an error.
    writeFileSync(path.join(empty, "Dockerfile"), "# nothing but a comment\n");
    expect(() => generateTruth(empty, ["Dockerfile"])).toThrow(/no FROM in any/);
  });

  test("greplost's manifest exports and node set match the oracle (S2, S6)", async () => {
    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: dockerRoot, config: DOCKER_CONFIG });

    const predicted: Record<string, string[]> = {};
    for (const file of truth.files) predicted[file] = snapshot.manifest.files[file]?.exports ?? [];
    const S2 = scoreSet(exportKeys(predicted), exportKeys(truth.exports));
    expect(S2.precision).toBe(1);
    expect(S2.recall).toBe(1);

    const S6 = scoreSet(
      snapshot.symbols.filter((decl) => decl.kind === "stage" || decl.kind === "image").map((decl) => decl.id),
      extra.nodes,
    );
    expect(S6.precision).toBe(1);
    expect(S6.recall).toBe(1);
  });

  test("greplost's reference edges match the oracle exactly (S5)", async () => {
    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: dockerRoot, config: DOCKER_CONFIG });

    const key = (edge: { from: string; to: string; refKind?: string }): string =>
      `${edge.from} -${edge.refKind ?? ""}-> ${edge.to}`;
    const S5 = scoreSet((snapshot.references ?? []).map(key), extra.references.map((e) => key(e as never)));
    // `gates/leaf-2.10.md` gates S5 precision at 0.95; the fixture is exact on both halves.
    expect(S5.precision).toBe(1);
    expect(S5.recall).toBe(1);
    expect(S5.falsePositives).toEqual([]);
    expect(S5.tp).toBe(extra.references.length);
  });
});

// ---------------------------------------------------------------------------

describe("oracle independence", () => {
  test("the truth generator reads greplost's extractor, resolver and tree-sitter nowhere", () => {
    const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", "dockerfile.ts"), "utf8");
    // Prose is not a dependency, so the check reads the import specifiers rather than the text.
    const specifiers = [...source.matchAll(/^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/gmu)].map(
      (match) => match[1] as string,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/tree-sitter|^@greplost\/core$|\/(?:extract|resolve|references|signals)\//u);
    }
    // The schema (ids and sorting) is the shared vocabulary, and is allowed; the parser is not
    // greplost's, and is what makes the oracle an oracle.
    expect(specifiers).toContain("@greplost/core/schema");
    expect(specifiers).toContain("dockerfile-ast");
    // Nothing here ever builds a greplost snapshot.
    expect(source).not.toContain("buildSnapshot(");
  });

  test("the oracle's answer tracks the fixture: change a Dockerfile, change the truth", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-docker-copy-"));
    temporaryDirs.push(dir);
    cpSync(dockerRoot, dir, { recursive: true });

    const before = generateTruth(dir, DOCKER_FILES);
    expect(before.exports).toEqual(truth.exports);
    expect(generateExtra(dir, DOCKER_FILES).nodes).toEqual(extra.nodes);

    // One more Dockerfile: two stages, the second copying out of the first, plus an ARG. An
    // oracle that echoed greplost, or that cached its answer, would not move.
    const changed = mkdtempSync(path.join(tmpdir(), "greplost-docker-changed-"));
    temporaryDirs.push(changed);
    cpSync(dockerRoot, changed, { recursive: true });
    writeFileSync(
      path.join(changed, "Dockerfile.ci"),
      "ARG GO_VERSION=1.25\nFROM golang:1.25 AS tools\nRUN go build ./...\n" +
        "FROM alpine:3.20 AS ci\nCOPY --from=tools /out /usr/local/bin/\nCMD [\"ci\"]\n",
    );

    const files = [...DOCKER_FILES, "Dockerfile.ci"].sort();
    const after = generateTruth(changed, files);
    const afterExtra = generateExtra(changed, files);

    expect(after.files).toEqual(files);
    expect(after.exports["Dockerfile.ci"]).toEqual(["ci", "tools"]);
    expect(afterExtra.nodes.length).toBe(extra.nodes.length + 3);
    expect(afterExtra.nodes).toContain("Dockerfile.ci#image.ci");
    expect(keys(afterExtra.references)).toContain("Dockerfile.ci#stage.ci -> Dockerfile.ci#stage.tools");
    expect(keys(afterExtra.references)).toContain("Dockerfile.ci#stage.tools -> ext:image/golang:1.25");
    expect(constantsOf(changed, files)["Dockerfile.ci"]).toEqual([
      { id: "Dockerfile.ci#arg.GO_VERSION", name: "arg.GO_VERSION", value: "1.25" },
    ]);
  });

  test("the parsers really are different: dockerfile-ast reads a form the grammar cannot", async () => {
    // `ENV NAME a b c` (a value with spaces and no `=`) is legal Docker and defeats
    // tree-sitter-dockerfile v0.2.0, which wraps it and the rest of the file in one ERROR.
    // The oracle reads it, so the difference shows up as a measured miss rather than as two
    // parsers agreeing because they share code.
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-docker-legacy-"));
    temporaryDirs.push(dir);
    writeFileSync(path.join(dir, "Dockerfile"), "FROM alpine:3.20 AS one\nENV NOTE a b c\nFROM alpine:3.20 AS two\n");

    const legacy = generateTruth(dir, ["Dockerfile"]);
    expect(legacy.exports["Dockerfile"]).toEqual(["one", "two"]);

    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: dir, config: DOCKER_CONFIG });
    // greplost sees only the first stage; the oracle sees both, and the gap is real.
    expect(snapshot.manifest.files["Dockerfile"]?.exports).toEqual(["one"]);
  });
});
