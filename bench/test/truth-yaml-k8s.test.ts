/**
 * Kubernetes and Helm truth generator tests (leaf 2.8, gates G6 and G7).
 *
 * Everything in `js-yaml oracle` is read off `fixtures/tiny-k8s` by hand and pinned: these are
 * the numbers the Kubernetes structure layer is scored against, so they are written out in full
 * rather than recomputed from the thing under test.
 *
 * `helm render` is the other half of the Helm gate, and the one place `helm template` actually
 * decides something: greplost's templated nodes are checked against the kinds, the apiVersions
 * and the per-file document count `helm` produces for `fixtures/tiny-helm`. Names are never
 * compared: a rendered name is a value and greplost's is a template, which is exactly what
 * the `names-not-compared-for-templates` note publishes.
 *
 * `oracle independence` is the integrity check of tech spec 10.1 principle 2: neither oracle
 * may be able to agree with greplost by construction.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type GreplostConfig } from "@greplost/core/schema";
import { NOTES as K8S_NOTES, generateExtra, generateTruth } from "../src/truth/yaml-k8s.ts";
import {
  NOTES as HELM_NOTES,
  chartsOf,
  generateExtra as generateHelmExtra,
  generateTruth as generateHelmTruth,
  helmBinary,
  helmRender,
} from "../src/truth/yaml-helm.ts";
import { generateExtra as generateYamlExtra, generateTruth as generateYamlTruth } from "../src/truth/yaml.ts";
import { edgeKey, exportKeys, scoreSet } from "../src/score.ts";
import { loadTruth } from "../src/truth/registry.ts";
import { FIXTURES } from "../src/fixtures.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const k8sRoot = path.join(repoRoot, "fixtures", "tiny-k8s");
const helmRoot = path.join(repoRoot, "fixtures", "tiny-helm");

const K8S_FILES = ["configmap.yaml", "deploy.yaml", "worker.yaml"];
const HELM_FILES = ["Chart.yaml", "templates/deployment.yaml", "templates/service.yaml", "values.yaml"];

const YAML_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["yaml"] };

const truth = generateTruth(k8sRoot, K8S_FILES);
const extra = generateExtra(k8sRoot, K8S_FILES);

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

const keys = (edges: ReadonlyArray<{ from: string; to: string }>): string[] => edges.map(edgeKey);

// ---------------------------------------------------------------------------

describe("js-yaml oracle", () => {
  test("the truth registry finds both flavours by convention and they declare their oracles", async () => {
    const k8s = await loadTruth("yaml-k8s");
    expect(typeof k8s.generateTruth).toBe("function");
    expect(typeof k8s.generateExtra).toBe("function");
    expect(k8s.NOTES).toEqual(K8S_NOTES);
    expect(K8S_NOTES).toEqual(["js-yaml-oracle"]);

    const helm = await loadTruth("yaml-helm");
    expect(typeof helm.generateTruth).toBe("function");
    expect(typeof helm.generateExtra).toBe("function");
    expect(HELM_NOTES).toEqual([
      "js-yaml-oracle",
      "helm-template-render",
      "names-not-compared-for-templates",
      // The `.Values` set is one regular expression written twice, so S5 witnesses agreement
      // and not correctness; only S2 is independently witnessed for a chart (fix round 1).
      "same-regex-both-sides",
      // Both arms of an `if`/`else` survive the pre-pass, so a template that writes one key in
      // each leaves a duplicate key and is read only as far as the grammar recovers.
      "if-else-arms-both-kept",
    ]);

    // The `yaml` dispatcher is what `structural.ts` actually asks, so it has to offer both.
    const yaml = await loadTruth("yaml");
    expect(typeof yaml.generateExtra).toBe("function");
    expect(FIXTURES["tiny-k8s"]?.lang).toBe("yaml");
    expect(FIXTURES["tiny-helm"]?.lang).toBe("yaml");
  });

  test("truth covers exactly the indexed manifests, and neither imports nor calls exist", () => {
    expect(truth.files).toEqual(K8S_FILES);
    expect(truth.imports).toEqual([]);
    expect(truth.calls).toEqual([]);
    expect(truth.cycles).toEqual([]);
    expect(truth.notes).toContain("unsupported:S3");
    expect(truth.notes).toContain("js-yaml-oracle");
  });

  test("exports are each file's sorted node names, and every covered file is a key", () => {
    expect(truth.exports).toEqual({
      "configmap.yaml": ["ConfigMap.web-config"],
      "deploy.yaml": ["Deployment.web", "Service.web", "app"],
      "worker.yaml": ["Deployment.worker", "queue", "sidecar"],
    });
  });

  test("the node set is every resource and image the fixture declares", () => {
    expect(extra.nodes).toEqual([
      "configmap.yaml#resource.ConfigMap.web-config",
      "deploy.yaml#image.app",
      "deploy.yaml#resource.Deployment.web",
      "deploy.yaml#resource.Service.web",
      "worker.yaml#image.queue",
      "worker.yaml#image.sidecar",
      "worker.yaml#resource.Deployment.worker",
    ]);
  });

  test("the reference set carries the selector, the config refs and the images", () => {
    expect(keys(extra.references)).toEqual([
      "deploy.yaml#image.app -> ext:image/nginx:1.27",
      "deploy.yaml#resource.Service.web -> deploy.yaml#resource.Deployment.web",
      "worker.yaml#image.queue -> ext:image/redis:7.2",
      "worker.yaml#image.sidecar -> ext:image/busybox:1.36",
      "worker.yaml#resource.Deployment.worker -> configmap.yaml#resource.ConfigMap.web-config",
    ]);
    // Every edge carries its `refKind`, which is what makes the S5 key (from, to, refKind).
    expect(extra.references.every((edge) => typeof (edge as { refKind?: string }).refKind === "string")).toBe(true);
  });

  test("two documents with one name are one export name and no config-ref candidate", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-k8s-dup-"));
    temporaryDirs.push(dir);
    writeFileSync(
      path.join(dir, "cm.yaml"),
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config\n  namespace: a\n---\n" +
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config\n  namespace: b\n",
    );
    writeFileSync(
      path.join(dir, "deploy.yaml"),
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  template:\n    spec:\n" +
        "      containers:\n        - name: app\n          image: nginx:1.27\n          envFrom:\n" +
        "            - configMapRef:\n                name: web-config\n",
    );
    const files = ["cm.yaml", "deploy.yaml"];
    // The suffix is on the id, never on the name.
    expect(generateTruth(dir, files).exports["cm.yaml"]).toEqual(["ConfigMap.web-config"]);
    const dup = generateExtra(dir, files);
    expect(dup.nodes).toContain("cm.yaml#resource.ConfigMap.web-config");
    expect(dup.nodes).toContain("cm.yaml#resource.ConfigMap.web-config~2");
    // Two candidates for one written name: spec 2.3 drops the edge rather than guessing.
    expect(dup.references.filter((edge) => (edge as { refKind?: string }).refKind === "config-ref")).toEqual([]);
  });

  test("a scalar YAML types as a number is still a name and a label on both sides", async () => {
    // greplost reads the text a scalar was written with; js-yaml types it. An oracle that
    // refused everything non-string dropped `version: 2` out of a selector and out of a pod's
    // labels, so the two workloads below looked identical to it, its selector matched both and
    // it drew nothing, scoring greplost's correct, unique edge as a false positive. The same
    // refusal skipped a whole document whose `metadata.name` was a number (fix round 1).
    const workload = (name: string, version: string): string =>
      `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\nspec:\n  template:\n    metadata:\n` +
      `      labels:\n        app: api\n        version: ${version}\n    spec:\n      containers:\n` +
      `        - name: app\n          image: nginx:1.27\n`;
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-k8s-scalars-"));
    temporaryDirs.push(dir);
    writeFileSync(
      path.join(dir, "n.yaml"),
      `${workload("old", "1")}---\n${workload("new", "2")}---\n` +
        "apiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  selector:\n    app: api\n    version: 2\n" +
        "---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: 2024\n",
    );
    const files = ["n.yaml"];
    const numeric = generateExtra(dir, files);
    // The numeric label picks exactly one of the two workloads.
    expect(keys(numeric.references)).toContain("n.yaml#resource.Service.api -> n.yaml#resource.Deployment.new");
    // The numeric name is a name.
    expect(numeric.nodes).toContain("n.yaml#resource.ConfigMap.2024");
    expect(generateTruth(dir, files).exports["n.yaml"]).toContain("ConfigMap.2024");

    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: dir, config: YAML_CONFIG });
    const key = (edge: { from: string; to: string; refKind?: string }): string =>
      `${edge.from} -${edge.refKind ?? ""}-> ${edge.to}`;
    const S5 = scoreSet((snapshot.references ?? []).map(key), numeric.references.map((e) => key(e as never)));
    expect([S5.fp, S5.fn]).toEqual([0, 0]);
    const S6 = scoreSet(snapshot.symbols.map((decl) => decl.id), numeric.nodes);
    expect([S6.fp, S6.fn]).toEqual([0, 0]);
  });

  test("an empty truth is an error, never a score", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "greplost-k8s-empty-"));
    temporaryDirs.push(empty);
    expect(() => generateTruth(empty, ["deploy.yaml"])).toThrow(/yaml-k8s truth is empty/);
  });

  test("a file js-yaml refuses is not covered, so neither side is scored on it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-k8s-bad-"));
    temporaryDirs.push(dir);
    cpSync(k8sRoot, dir, { recursive: true });
    // A duplicate mapping key: js-yaml refuses the document, tree-sitter reads part of it.
    writeFileSync(path.join(dir, "bad.yaml"), "apiVersion: v1\nkind: ConfigMap\nkind: Secret\nmetadata:\n  name: x\n");
    const files = [...K8S_FILES, "bad.yaml"].sort();
    expect(generateTruth(dir, files).files).toEqual(K8S_FILES);
  });

  test("greplost's manifest exports and node set match the oracle (S2, S6)", async () => {
    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: k8sRoot, config: YAML_CONFIG });

    const predicted: Record<string, string[]> = {};
    for (const file of truth.files) predicted[file] = snapshot.manifest.files[file]?.exports ?? [];
    const S2 = scoreSet(exportKeys(predicted), exportKeys(truth.exports));
    expect(S2.precision).toBe(1);
    expect(S2.recall).toBe(1);

    const S6 = scoreSet(
      snapshot.symbols.map((decl) => decl.id),
      extra.nodes,
    );
    expect(S6.precision).toBe(1);
    expect(S6.recall).toBe(1);
  });

  test("greplost's reference edges score above the S5 gate against the oracle", async () => {
    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: k8sRoot, config: YAML_CONFIG });

    const key = (edge: { from: string; to: string; refKind?: string }): string =>
      `${edge.from} -${edge.refKind ?? ""}-> ${edge.to}`;
    const S5 = scoreSet((snapshot.references ?? []).map(key), extra.references.map((e) => key(e as never)));
    // `gates/leaf-2.8.md` states: precision >= 0.95, recall reported.
    expect(S5.precision).toBeGreaterThanOrEqual(0.95);
    expect(S5.falsePositives).toEqual([]);
    expect(S5.recall).toBe(1);
    expect(S5.tp).toBe(extra.references.length);
  });
});

// ---------------------------------------------------------------------------

describe("helm render", () => {
  test("helm is on the PATH, and its absence would be a clear greplost error", () => {
    expect(helmBinary()).toBe("helm");
    expect(helmRender.length).toBe(1);
  });

  test("the chart grouping finds the chart root, its values file and its templates", () => {
    expect(chartsOf(HELM_FILES)).toEqual([
      {
        dir: "",
        chartFile: "Chart.yaml",
        valuesFile: "values.yaml",
        templates: ["templates/deployment.yaml", "templates/service.yaml"],
      },
    ]);
  });

  test("greplost's templated nodes match helm's kinds, apiVersions and per-file counts", async () => {
    const rendered = helmRender(helmRoot);
    expect(rendered).not.toBeNull();
    // The oracle's own answer, from `helm template` alone: what each template renders.
    const byFile = new Map<string, string[]>();
    for (const document of rendered ?? []) {
      const bucket = byFile.get(document.source) ?? [];
      bucket.push(`${document.kind}/${document.apiVersion}`);
      byFile.set(document.source, bucket);
    }
    expect([...byFile.entries()].sort()).toEqual([
      ["templates/deployment.yaml", ["Deployment/apps/v1"]],
      ["templates/service.yaml", ["Service/v1"]],
    ]);

    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: helmRoot, config: YAML_CONFIG });
    const predicted = new Map<string, string[]>();
    for (const decl of snapshot.symbols) {
      if (decl.kind !== "resource") continue;
      const bucket = predicted.get(decl.file) ?? [];
      bucket.push(`${decl.meta?.["kind"] ?? ""}/${decl.meta?.["apiVersion"] ?? ""}`);
      predicted.set(decl.file, bucket);
    }
    // Kinds, apiVersions and counts, never a name, which is the whole point of the note.
    expect([...predicted.entries()].sort()).toEqual([...byFile.entries()].sort());
    for (const decl of snapshot.symbols) {
      if (decl.kind === "resource" && decl.file.startsWith("templates/")) {
        expect(decl.meta?.["templated"]).toBe("1");
        expect(decl.name).toMatch(/\.~\d+$/u);
      }
    }
  });

  test("chart truth covers the chart files with names and the templates with nothing", () => {
    const helmTruth = generateHelmTruth(helmRoot, HELM_FILES);
    expect(helmTruth.files).toEqual(HELM_FILES);
    expect(helmTruth.exports).toEqual({
      "Chart.yaml": ["tiny"],
      "templates/deployment.yaml": [],
      "templates/service.yaml": [],
      "values.yaml": ["image", "replicaCount", "service"],
    });
    // S6 is no longer switched off target-wide: `nodeFiles` restricts it to the chart's own
    // files instead, so a repo holding manifests beside a chart still scores its manifests.
    expect(helmTruth.notes).not.toContain("unsupported:S6");
    expect(helmTruth.notes).toContain("unsupported:S3");
    expect(helmTruth.notes).toContain("names-not-compared-for-templates");
  });

  test("the chart's helm-values edges are the S5 truth and greplost matches them", async () => {
    const helmExtra = generateHelmExtra(helmRoot, HELM_FILES);
    // One edge per distinct `.Values.<path>`: `image.repository` and `image.tag` are two
    // different reasons for the same dependency, and both carry their own `symbols`.
    expect(helmExtra.references.map((edge) => `${edge.from} -> ${edge.to} ${(edge.symbols ?? []).join(",")}`)).toEqual([
      "templates/deployment.yaml -> values.yaml#variable.image .Values.image.repository",
      "templates/deployment.yaml -> values.yaml#variable.image .Values.image.tag",
      "templates/deployment.yaml -> values.yaml#variable.replicaCount .Values.replicaCount",
      "templates/deployment.yaml -> values.yaml#variable.service .Values.service.port",
      // A literal image in a template is fully rendered text, so the oracle states it too.
      "templates/deployment.yaml#image.wait -> ext:image/busybox:1.36 busybox:1.36",
      "templates/service.yaml -> values.yaml#variable.service .Values.service.port",
    ]);
    // S6 is scored over the chart's own files, never its templates.
    expect(helmExtra.nodeFiles).toEqual(["Chart.yaml", "values.yaml"]);
    expect(helmExtra.nodes).toEqual([
      "Chart.yaml#module.tiny",
      "values.yaml#variable.image",
      "values.yaml#variable.replicaCount",
      "values.yaml#variable.service",
    ]);

    const { buildSnapshot } = await import("@greplost/core");
    const snapshot = await buildSnapshot({ root: helmRoot, config: YAML_CONFIG });
    const predicted = new Set(keys(snapshot.references ?? []));
    for (const edge of keys(helmExtra.references)) expect(predicted.has(edge)).toBe(true);
    // A chart draws two kinds of reference and no more: `helm-values`, and `from-image` for an
    // image literal enough to name itself. Everything else in a chart is a value, not a name.
    const kinds = new Set((snapshot.references ?? []).map((edge) => edge.refKind));
    expect([...kinds].sort()).toEqual(["from-image", "helm-values"]);
  });

  test("the yaml dispatcher merges both flavours without losing either", () => {
    const merged = generateYamlTruth(helmRoot, HELM_FILES);
    expect(merged.files).toEqual(HELM_FILES);
    const mergedExtra = generateYamlExtra(helmRoot, HELM_FILES);
    expect(keys(mergedExtra.references)).toEqual(keys(generateHelmExtra(helmRoot, HELM_FILES).references));
  });

  test("a repo of manifests beside a chart still scores its manifest nodes", async () => {
    // The regression `nodeFiles` replaced `unsupported:S6` to fix: a note is published
    // target-wide, so one chart used to switch S6 off for every manifest in the repo.
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-yaml-mixed-"));
    temporaryDirs.push(dir);
    cpSync(k8sRoot, dir, { recursive: true });
    cpSync(helmRoot, dir, { recursive: true });

    const files = [...K8S_FILES, ...HELM_FILES].sort();
    const mixed = generateYamlTruth(dir, files);
    expect(mixed.files).toEqual(files);
    expect(mixed.notes).not.toContain("unsupported:S6");

    const mixedExtra = generateYamlExtra(dir, files);
    // Every manifest is scored; the chart contributes its own two files and not its templates.
    expect(mixedExtra.nodeFiles).toEqual(["Chart.yaml", ...K8S_FILES, "values.yaml"].sort());
    expect(mixedExtra.nodes.filter((id) => K8S_FILES.some((file) => id.startsWith(`${file}#`)))).toEqual(extra.nodes);

    const { buildSnapshot } = await import("@greplost/core");
    const { scoreAgainstTruth } = await import("../src/structural.ts");
    const snapshot = await buildSnapshot({ root: dir, config: YAML_CONFIG });
    const scores = scoreAgainstTruth("mixed", snapshot, mixed, "yaml", mixedExtra);
    expect(scores.S6).not.toBeNull();
    // The 7 manifest nodes plus the chart's module node and its three values keys.
    expect([scores.S6?.tp, scores.S6?.fp, scores.S6?.fn]).toEqual([11, 0, 0]);
  });
});

// ---------------------------------------------------------------------------

describe("oracle independence", () => {
  test("neither truth generator reads greplost's extractor, resolver or tree-sitter", () => {
    for (const name of ["yaml-k8s.ts", "yaml-helm.ts"]) {
      const source = readFileSync(path.join(repoRoot, "bench", "src", "truth", name), "utf8");
      // Prose is not a dependency, so the check reads the import specifiers rather than the text.
      const specifiers = [...source.matchAll(/^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/gmu)].map(
        (match) => match[1] as string,
      );
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(/tree-sitter|^@greplost\/core$|\/(?:extract|resolve|references|signals)\//u);
      }
      // The schema (ids and sorting) is the shared vocabulary, and is allowed.
      expect(specifiers).toContain("@greplost/core/schema");
      // Nothing here ever builds a greplost snapshot.
      expect(source).not.toContain("buildSnapshot(");
    }
  });

  test("the manifest oracle's answer tracks the fixture: change a manifest, change the truth", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-k8s-copy-"));
    temporaryDirs.push(dir);
    cpSync(k8sRoot, dir, { recursive: true });

    const before = generateTruth(dir, K8S_FILES);
    expect(before.exports).toEqual(truth.exports);
    expect(generateExtra(dir, K8S_FILES).nodes).toEqual(extra.nodes);

    // One more manifest: a Secret, and a Pod that mounts it and selects nothing. An oracle that
    // echoed greplost, or that cached its answer, would not move.
    const changed = mkdtempSync(path.join(tmpdir(), "greplost-k8s-changed-"));
    temporaryDirs.push(changed);
    cpSync(k8sRoot, changed, { recursive: true });
    writeFileSync(
      path.join(changed, "extra.yaml"),
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: creds\n---\n" +
        "apiVersion: v1\nkind: Pod\nmetadata:\n  name: runner\nspec:\n  containers:\n    - name: run\n" +
        "      image: alpine:3.20\n      envFrom:\n        - secretRef:\n            name: creds\n",
    );

    const files = [...K8S_FILES, "extra.yaml"].sort();
    const after = generateTruth(changed, files);
    const afterExtra = generateExtra(changed, files);

    expect(after.files).toEqual(files);
    expect(after.exports["extra.yaml"]).toEqual(["Pod.runner", "Secret.creds", "run"]);
    expect(afterExtra.nodes).toContain("extra.yaml#resource.Secret.creds");
    expect(afterExtra.nodes.length).toBe(extra.nodes.length + 3);
    expect(keys(afterExtra.references)).toContain("extra.yaml#resource.Pod.runner -> extra.yaml#resource.Secret.creds");
  });

  test("the chart oracle's answer tracks the chart: add a values key and a use of it", () => {
    const changed = mkdtempSync(path.join(tmpdir(), "greplost-helm-changed-"));
    temporaryDirs.push(changed);
    cpSync(helmRoot, changed, { recursive: true });
    writeFileSync(
      path.join(changed, "values.yaml"),
      "replicaCount: 1\nimage:\n  repository: nginx\n  tag: \"1.27\"\nservice:\n  port: 80\nextra: \"on\"\n",
    );
    writeFileSync(
      path.join(changed, "templates", "cm.yaml"),
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}\ndata:\n  x: {{ .Values.extra }}\n",
    );

    const files = [...HELM_FILES, "templates/cm.yaml"].sort();
    const after = generateHelmTruth(changed, files);
    expect(after.exports["values.yaml"]).toEqual(["extra", "image", "replicaCount", "service"]);
    expect(after.exports["templates/cm.yaml"]).toEqual([]);
    const afterExtra = generateHelmExtra(changed, files);
    expect(keys(afterExtra.references)).toContain("templates/cm.yaml -> values.yaml#variable.extra");
    expect(afterExtra.references.length).toBe(generateHelmExtra(helmRoot, HELM_FILES).references.length + 1);
    // The chart still renders, so the render cross-check is still available for it.
    expect(helmRender(changed)?.map((document) => document.kind).sort()).toEqual([
      "ConfigMap",
      "Deployment",
      "Service",
    ]);
  });
});
