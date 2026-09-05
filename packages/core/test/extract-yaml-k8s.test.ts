/**
 * Leaf 2.8: Kubernetes and Helm YAML extraction and reference linking.
 *
 * Three layers, each tested on inline sources first and then pinned against
 * `fixtures/tiny-k8s` and `fixtures/tiny-helm` end to end:
 *   - `extractYamlK8s`, the nodes one manifest makes (spec 2.3, "Declarations");
 *   - `blankTemplates`/`extractYamlHelm`, the documented pre-pass that makes a Helm template
 *                                 parseable without running helm, and the chart nodes;
 *   - `resolveYamlK8sReferences`, a selector, a config reference or a `.Values` action resolved
 *                                 to the one node it names, or dropped rather than guessed.
 *
 * The `describe` names are fixed by spec section 2.6: `documents`, `images`, `selectors`,
 * `config refs`, `helm templates`, `values`, `tiny-k8s`, `tiny-helm`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createParser } from "../src/parser.ts";
import type { ParserHandle } from "../src/parser.ts";
import { extractFile } from "../src/extract/index.ts";
import { blankTemplates } from "../src/extract/yaml-helm.ts";
import { buildSnapshot } from "../src/build.ts";
import type { Declaration, FileRecord, GreplostConfig, ReferenceEdge, Snapshot } from "../src/schema.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";

const ZERO_SHA = "0".repeat(64);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TINY_K8S = path.join(REPO_ROOT, "fixtures", "tiny-k8s");
const TINY_HELM = path.join(REPO_ROOT, "fixtures", "tiny-helm");
const YAML_CONFIG: GreplostConfig = { ...DEFAULT_CONFIG, languages: ["yaml"] };

let parser: ParserHandle;

beforeAll(async () => {
  parser = await createParser();
});

function run(file: string, source: string): FileRecord {
  return extractFile({ path: file, lang: "yaml", source, sha256: ZERO_SHA }, parser);
}

function decl(record: FileRecord, name: string): Declaration {
  const found = record.decls.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration named ${name} in [${record.decls.map((d) => d.name).join(", ")}]`);
  return found;
}

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

/** Build a snapshot over a throwaway repo written from `files` (repo-relative path -> text). */
async function snapshotOf(files: Readonly<Record<string, string>>): Promise<Snapshot> {
  const dir = mkdtempSync(path.join(tmpdir(), "greplost-yaml-"));
  temporaryDirs.push(dir);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  }
  return buildSnapshot({ root: dir, config: YAML_CONFIG });
}

/** Reference edges as `[from, to, refKind, symbol, confidence]`, in artifact order. */
function references(snapshot: Snapshot): string[] {
  return (snapshot.references ?? []).map(
    (edge: ReferenceEdge) =>
      `${edge.from} -${edge.refKind}-> ${edge.to} [${(edge.symbols ?? []).join(",")}] ${edge.confidence}`,
  );
}

const TWO_DOCS = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: app
          image: nginx:1.27
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
`;

/** Two `ConfigMap`s with one name: the collision both halves of the ruling turn on. */
const TWO_CONFIGMAPS = `apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  namespace: a
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  namespace: b
`;

// ---------------------------------------------------------------------------

describe("documents", () => {
  test("each document becomes a resource node named <Kind>.<metadata.name>", () => {
    const out = run("deploy.yaml", TWO_DOCS);
    expect(out.decls.map((d) => d.id)).toEqual([
      "deploy.yaml#resource.Deployment.web",
      "deploy.yaml#image.app",
      "deploy.yaml#resource.Service.web",
    ]);
  });

  test("an unnamed document falls back to its 0-based index", () => {
    const out = run("x.yaml", "apiVersion: v1\nkind: ConfigMap\n");
    expect(out.decls[0]?.id).toBe("x.yaml#resource.ConfigMap.~0");
  });

  test("a resource node carries apiVersion, kind, namespace and flavour in meta", () => {
    const out = run("cm.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n  namespace: shop\n");
    expect(decl(out, "ConfigMap.c").meta).toEqual({
      apiVersion: "v1",
      flavour: "k8s",
      kind: "ConfigMap",
      namespace: "shop",
    });
  });

  test("a manifest exports nothing: every Kubernetes declaration has exported false", () => {
    const out = run("deploy.yaml", TWO_DOCS);
    expect(out.decls.every((d) => d.exported === false)).toBe(true);
  });

  test("a repeated name inside one file suffixes the id and never the name", () => {
    const twice = TWO_CONFIGMAPS.replace(/  namespace: [ab]\n/gu, "");
    const out = run("dup.yaml", twice);
    // The suffix lives in the id and nowhere else (driver ruling 2026-09-04): `name` stays as
    // the file wrote it, so nothing downstream publishes a name nobody typed.
    expect(out.decls.map((d) => d.id)).toEqual([
      "dup.yaml#resource.ConfigMap.web-config",
      "dup.yaml#resource.ConfigMap.web-config~2",
    ]);
    expect(out.decls.map((d) => d.name)).toEqual(["ConfigMap.web-config", "ConfigMap.web-config"]);
  });

  test("two documents with one name are one export record, not a suffixed second one", async () => {
    const snapshot = await snapshotOf({ "dup.yaml": TWO_CONFIGMAPS });
    expect(snapshot.manifest.files["dup.yaml"]?.exports).toEqual(["ConfigMap.web-config"]);
  });

  test("a plain YAML file with no apiVersion and kind contributes nothing", () => {
    expect(run("ci.yaml", "hello: world\nlist:\n  - 1\n").decls).toEqual([]);
  });

  test("a document with no calls and no imports produces neither", () => {
    const out = run("deploy.yaml", TWO_DOCS);
    expect(out.calls).toEqual([]);
    expect(out.imports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("images", () => {
  test("each container becomes an image node named after the container", () => {
    const out = run("deploy.yaml", TWO_DOCS);
    const image = decl(out, "app");
    expect(image.kind).toBe("image");
    expect(image.id).toBe("deploy.yaml#image.app");
    expect(image.meta).toEqual({ container: "app", flavour: "k8s", image: "nginx:1.27" });
  });

  test("init containers and pod containers are both image nodes", () => {
    const source = `apiVersion: v1
kind: Pod
metadata:
  name: p
spec:
  initContainers:
    - name: setup
      image: busybox:1.36
  containers:
    - name: app
      image: nginx:1.27
`;
    // Source order, not a fixed list of paths: `initContainers` is written first.
    expect(run("pod.yaml", source).decls.map((d) => d.name)).toEqual(["Pod.p", "setup", "app"]);
  });

  test("an image node points at ext:image/<ref> at high confidence", async () => {
    const snapshot = await snapshotOf({ "pod.yaml": TWO_DOCS });
    expect(references(snapshot)).toContain(
      "pod.yaml#image.app -from-image-> ext:image/nginx:1.27 [nginx:1.27] high",
    );
  });
});

// ---------------------------------------------------------------------------

describe("selectors", () => {
  test("a Service selecting exactly one workload gets a high-confidence selector edge", async () => {
    const snapshot = await buildSnapshot({ root: TINY_K8S, config: YAML_CONFIG });
    expect(references(snapshot)).toContain(
      "deploy.yaml#resource.Service.web -selector-> deploy.yaml#resource.Deployment.web [app=web] high",
    );
  });

  test("a selector matching two workloads is dropped, never guessed", async () => {
    const two = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: a
spec:
  template:
    metadata:
      labels:
        app: web
    spec:
      containers: []
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: b
spec:
  template:
    metadata:
      labels:
        app: web
    spec:
      containers: []
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
`;
    const snapshot = await snapshotOf({ "two.yaml": two });
    expect(references(snapshot).filter((line) => line.includes("-selector->"))).toEqual([]);
  });

  test("a NetworkPolicy podSelector resolves the same way as a Service selector", async () => {
    const source = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    metadata:
      labels:
        app: api
        tier: back
    spec:
      containers: []
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api
spec:
  podSelector:
    matchLabels:
      app: api
`;
    const snapshot = await snapshotOf({ "np.yaml": source });
    expect(references(snapshot)).toContain(
      "np.yaml#resource.NetworkPolicy.api -selector-> np.yaml#resource.Deployment.api [app=api] high",
    );
  });

  test("an empty selector matches nothing rather than everything", async () => {
    const source = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    metadata:
      labels:
        app: api
    spec:
      containers: []
---
apiVersion: v1
kind: Service
metadata:
  name: all
spec:
  selector: {}
`;
    const snapshot = await snapshotOf({ "svc.yaml": source });
    expect(references(snapshot).filter((line) => line.includes("-selector->"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("config refs", () => {
  test("configMapRef, configMapKeyRef and a volume configMap all reach the one ConfigMap", async () => {
    const snapshot = await buildSnapshot({ root: TINY_K8S, config: YAML_CONFIG });
    expect(references(snapshot)).toContain(
      "worker.yaml#resource.Deployment.worker -config-ref-> configmap.yaml#resource.ConfigMap.web-config " +
        "[ConfigMap/web-config] high",
    );
  });

  test("a secretRef and a PVC claim name resolve to their own kinds", async () => {
    const source = `apiVersion: v1
kind: Secret
metadata:
  name: creds
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
---
apiVersion: v1
kind: Pod
metadata:
  name: p
spec:
  containers:
    - name: app
      image: nginx:1.27
      envFrom:
        - secretRef:
            name: creds
  volumes:
    - name: d
      persistentVolumeClaim:
        claimName: data
`;
    const snapshot = await snapshotOf({ "p.yaml": source });
    const lines = references(snapshot).filter((line) => line.includes("-config-ref->"));
    expect(lines).toEqual([
      "p.yaml#resource.Pod.p -config-ref-> p.yaml#resource.PersistentVolumeClaim.data [PersistentVolumeClaim/data] high",
      "p.yaml#resource.Pod.p -config-ref-> p.yaml#resource.Secret.creds [Secret/creds] high",
    ]);
  });

  test("a config reference naming two ConfigMaps of the same name is dropped", async () => {
    const source = `apiVersion: v1
kind: ConfigMap
metadata:
  name: shared
  namespace: a
---
apiVersion: v1
kind: Pod
metadata:
  name: p
spec:
  containers:
    - name: app
      image: nginx:1.27
      envFrom:
        - configMapRef:
            name: shared
`;
    const other = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared\n  namespace: b\n";
    const snapshot = await snapshotOf({ "p.yaml": source, "other.yaml": other });
    expect(references(snapshot).filter((line) => line.includes("-config-ref->"))).toEqual([]);
  });

  test("two ConfigMaps of one name in the SAME file are two candidates, so the edge drops", async () => {
    // The id suffix distinguishes the two declarations; the *name* does not, and the name is
    // what `configMapRef: web-config` writes. Looking the reference up by id would find the
    // first and report an ambiguous reference as a certain one (driver ruling 2026-09-04).
    const workload = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.27
          envFrom:
            - configMapRef:
                name: web-config
`;
    const snapshot = await snapshotOf({ "cm.yaml": TWO_CONFIGMAPS, "deploy.yaml": workload });
    expect(references(snapshot).filter((line) => line.includes("-config-ref->"))).toEqual([]);
  });

  test("a config reference naming nothing at all is dropped, never left unresolved", async () => {
    const source = `apiVersion: v1
kind: Pod
metadata:
  name: p
spec:
  containers:
    - name: app
      image: nginx:1.27
      envFrom:
        - configMapRef:
            name: absent
`;
    const snapshot = await snapshotOf({ "p.yaml": source });
    expect(references(snapshot).filter((line) => line.includes("-config-ref->"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("helm templates", () => {
  test("template actions are blanked in place so spans stay truthful", () => {
    const src = "kind: Deployment\nmetadata:\n  name: {{ .Release.Name }}-web\n";
    expect(blankTemplates(src)).toBe("kind: Deployment\nmetadata:\n  name: ___________________-web\n");
    expect(blankTemplates(src)).toHaveLength(src.length);
  });

  test("an action that begins a line becomes spaces, so the line disappears from the document", () => {
    const src = "{{- if .Values.on }}\nkind: Service\n{{- end }}\n";
    expect(blankTemplates(src)).toBe(`${" ".repeat(20)}\nkind: Service\n${" ".repeat(10)}\n`);
    expect(blankTemplates(src)).toHaveLength(src.length);
  });

  test("a comment action closes on its own terminator, however much whitespace opens it", () => {
    // `{{-`, a newline and an indented comment is still one action: the probe that decides
    // whether a span is a comment has to read past the whitespace to find the opener.
    const src = "a: 1\n{{-\n          /* }} not the end }} */ -}}\nb: 2\n";
    const blanked = blankTemplates(src);
    expect(blanked).toHaveLength(src.length);
    expect(blanked.split("\n")[3]).toBe("b: 2");
    // The whole comment is one span: nothing of it survives as text.
    expect(blanked).not.toContain("not the end");
  });

  test("newlines inside an action survive, so every later line keeps its number", () => {
    const src = "a: {{ include \"x\"\n  (dict) }}\nb: 1\n";
    const blanked = blankTemplates(src);
    expect(blanked).toHaveLength(src.length);
    expect(blanked.split("\n")).toHaveLength(src.split("\n").length);
    expect(blanked.split("\n")[2]).toBe("b: 1");
  });

  test("an action that is a key's whole value and renders a block becomes spaces, not a scalar", () => {
    // `labels: {{- include … | nindent 4 }}` renders a nested mapping, so the lines below it are
    // more indented than the key. Blanked to `_` the key would own a plain scalar and the block
    // under it would not parse at all; the whole `metadata:` mapping is lost with it. Measured
    // on bitnami/charts: this one rule is 72 of the 76 templates that used to shred.
    const src = "metadata:\n  labels: {{- include \"x\" . | nindent 4 }}\n    app: web\n  name: {{ .Release.Name }}\n";
    const blanked = blankTemplates(src);
    expect(blanked).toHaveLength(src.length);
    expect(blanked.split("\n")[1]?.trimEnd()).toBe("  labels:");
    expect(blanked.split("\n")[1]).toHaveLength((src.split("\n")[1] as string).length);
    // The `name:` action on the last line is still a scalar: nothing deeper follows it.
    expect(blanked.split("\n")[3]).toBe("  name: ___________________");

    const out = run("templates/x.yaml", `apiVersion: v1\nkind: ConfigMap\n${src}`);
    expect(out.decls.map((d) => d.id)).toEqual(["templates/x.yaml#resource.ConfigMap.~0"]);
  });

  test("a templated name falls back to the document index and keeps the raw template in meta", () => {
    const src = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}-web\n";
    const out = run("templates/deployment.yaml", src);
    expect(out.decls[0]?.id).toBe("templates/deployment.yaml#resource.Deployment.~0");
    expect(out.decls[0]?.meta?.["nameTemplate"]).toBe("{{ .Release.Name }}-web");
    expect(out.decls[0]?.meta?.["templated"]).toBe("1");
    expect(out.decls[0]?.meta?.["flavour"]).toBe("helm");
  });

  test("a templated image keeps its raw text and makes no ext:image edge", async () => {
    const snapshot = await buildSnapshot({ root: TINY_HELM, config: YAML_CONFIG });
    const image = snapshot.symbols.find((d) => d.id === "templates/deployment.yaml#image.web");
    expect(image?.meta?.["templated"]).toBe("1");
    expect(image?.meta?.["imageTemplate"]).toBe("{{ .Values.image.repository }}:{{ .Values.image.tag }}");
    // The templated image makes no edge; its literal sibling in the same document does.
    expect(references(snapshot).filter((line) => line.includes("#image.web -from-image->"))).toEqual([]);
  });

  test("a literal image inside a template is fully rendered text, so it still gets its edge", async () => {
    const snapshot = await snapshotOf({
      "Chart.yaml": "apiVersion: v2\nname: c\nversion: 0.1.0\n",
      "values.yaml": "known: 1\n",
      "templates/job.yaml": `apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .Release.Name }}-migrate
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: busybox:1.36
        - name: app
          image: {{ .Values.known }}
`,
    });
    // `busybox:1.36` came out of no template span; it is the image that will run.
    expect(references(snapshot).filter((line) => line.includes("-from-image->"))).toEqual([
      "templates/job.yaml#image.migrate -from-image-> ext:image/busybox:1.36 [busybox:1.36] high",
    ]);
  });

  test("spans still point at the line the node was written on", () => {
    const src = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n";
    const out = run("templates/deployment.yaml", src);
    expect(out.decls[0]?.span).toEqual([1, 4]);
  });
});

// ---------------------------------------------------------------------------

describe("values", () => {
  test("values.yaml yields one variable node per top-level key only", () => {
    const out = run("values.yaml", "image:\n  repository: nginx\n  tag: \"1.27\"\nreplicaCount: 1\n");
    expect(out.decls.map((d) => d.id)).toEqual(["values.yaml#variable.image", "values.yaml#variable.replicaCount"]);
    expect(decl(out, "image").meta).toEqual({ flavour: "helm", path: "image" });
  });

  test("a chart node's span stops on the last line the chart file wrote", () => {
    // `nodeId` builds the id, and the span is trimmed of the trailing blank the block node
    // swallows, so both match every other node kind in the map (fix round 1).
    const chart = run("Chart.yaml", "apiVersion: v2\nname: tiny\nversion: 0.1.0\n\n");
    expect(chart.decls[0]?.id).toBe("Chart.yaml#module.tiny");
    expect(chart.decls[0]?.span).toEqual([1, 3]);

    const values = run("values.yaml", "image:\n  repository: nginx\n  tag: \"1.27\"\n\nreplicaCount: 1\n");
    expect(values.decls.map((d) => [d.id, d.span])).toEqual([
      ["values.yaml#variable.image", [1, 3]],
      ["values.yaml#variable.replicaCount", [5, 5]],
    ]);
  });

  test("Chart.yaml yields one module node named after the chart", () => {
    const out = run("Chart.yaml", "apiVersion: v2\nname: tiny\nversion: 0.1.0\nappVersion: \"1.27\"\n");
    expect(out.decls.map((d) => d.id)).toEqual(["Chart.yaml#module.tiny"]);
    expect(decl(out, "tiny").meta).toEqual({ appVersion: "1.27", flavour: "helm", version: "0.1.0" });
  });

  test("a .Values action links the template to the values key at med confidence", async () => {
    const snapshot = await buildSnapshot({ root: TINY_HELM, config: YAML_CONFIG });
    expect(references(snapshot)).toContain(
      "templates/deployment.yaml -helm-values-> values.yaml#variable.image [.Values.image.repository] med",
    );
  });

  test("a .Values action naming a key that values.yaml does not declare is dropped", async () => {
    const snapshot = await snapshotOf({
      "Chart.yaml": "apiVersion: v2\nname: c\nversion: 0.1.0\n",
      "values.yaml": "known: 1\n",
      "templates/x.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Values.unknown }}\n",
    });
    expect(references(snapshot).filter((line) => line.includes("-helm-values->"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("tiny-k8s", () => {
  test("the fixture's node set is exactly what the three manifests declare", async () => {
    const snapshot = await buildSnapshot({ root: TINY_K8S, config: YAML_CONFIG });
    expect(snapshot.symbols.map((d) => d.id)).toEqual([
      "configmap.yaml#resource.ConfigMap.web-config",
      "deploy.yaml#resource.Deployment.web",
      "deploy.yaml#image.app",
      "deploy.yaml#resource.Service.web",
      "worker.yaml#resource.Deployment.worker",
      "worker.yaml#image.queue",
      "worker.yaml#image.sidecar",
    ]);
  });

  test("the fixture's reference edges are the selector, the config refs and the images", async () => {
    const snapshot = await buildSnapshot({ root: TINY_K8S, config: YAML_CONFIG });
    expect(references(snapshot)).toEqual([
      "deploy.yaml#image.app -from-image-> ext:image/nginx:1.27 [nginx:1.27] high",
      "deploy.yaml#resource.Service.web -selector-> deploy.yaml#resource.Deployment.web [app=web] high",
      "worker.yaml#image.queue -from-image-> ext:image/redis:7.2 [redis:7.2] high",
      "worker.yaml#image.sidecar -from-image-> ext:image/busybox:1.36 [busybox:1.36] high",
      "worker.yaml#resource.Deployment.worker -config-ref-> configmap.yaml#resource.ConfigMap.web-config " +
        "[ConfigMap/web-config] high",
    ]);
  });

  test("the manifest lists each file's node names as its exports", async () => {
    const snapshot = await buildSnapshot({ root: TINY_K8S, config: YAML_CONFIG });
    expect(snapshot.manifest.files["deploy.yaml"]?.exports).toEqual(["Deployment.web", "Service.web", "app"]);
  });
});

// ---------------------------------------------------------------------------

describe("tiny-helm", () => {
  test("the chart's node set is the module, the values keys and the templated resources", async () => {
    const snapshot = await buildSnapshot({ root: TINY_HELM, config: YAML_CONFIG });
    expect(snapshot.symbols.map((d) => d.id)).toEqual([
      "Chart.yaml#module.tiny",
      "templates/deployment.yaml#resource.Deployment.~0",
      "templates/deployment.yaml#image.wait",
      "templates/deployment.yaml#image.web",
      "templates/service.yaml#resource.Service.~0",
      "values.yaml#variable.replicaCount",
      "values.yaml#variable.image",
      "values.yaml#variable.service",
    ]);
  });

  test("a chart template exports nothing: its names do not exist until the chart is rendered", async () => {
    const snapshot = await buildSnapshot({ root: TINY_HELM, config: YAML_CONFIG });
    expect(snapshot.manifest.files["templates/deployment.yaml"]?.exports).toEqual([]);
    expect(snapshot.manifest.files["Chart.yaml"]?.exports).toEqual(["tiny"]);
    expect(snapshot.manifest.files["values.yaml"]?.exports).toEqual(["image", "replicaCount", "service"]);
  });

  test("a chart draws no selector and no config edge: both are lookups by a name helm decides", async () => {
    const snapshot = await buildSnapshot({ root: TINY_HELM, config: YAML_CONFIG });
    // `from-image` survives because a literal image names itself; `helm-values` because both
    // ends are unrendered files. Everything else in a chart is a value, not a name.
    const kinds = new Set((snapshot.references ?? []).map((edge) => edge.refKind));
    expect([...kinds].sort()).toEqual(["from-image", "helm-values"]);
  });

  test("every .Values path in the chart reaches its top-level values key", async () => {
    const snapshot = await buildSnapshot({ root: TINY_HELM, config: YAML_CONFIG });
    expect(references(snapshot)).toEqual([
      "templates/deployment.yaml -helm-values-> values.yaml#variable.image [.Values.image.repository] med",
      "templates/deployment.yaml -helm-values-> values.yaml#variable.image [.Values.image.tag] med",
      "templates/deployment.yaml -helm-values-> values.yaml#variable.replicaCount [.Values.replicaCount] med",
      "templates/deployment.yaml -helm-values-> values.yaml#variable.service [.Values.service.port] med",
      "templates/deployment.yaml#image.wait -from-image-> ext:image/busybox:1.36 [busybox:1.36] high",
      "templates/service.yaml -helm-values-> values.yaml#variable.service [.Values.service.port] med",
    ]);
  });
});
