/**
 * The `greplost init` language marker table (spec 0.6; ruling 2026-09-05, leaf 2.12).
 *
 * `DEFAULT_CONFIG.languages` is the TypeScript family and must stay that way, so
 * adding a language to greplost cannot change any existing repository's map. The
 * consequence is that a Terraform repository used to get a config that matched
 * nothing: `init` reported a successful build, exit 0, and an empty map. The
 * marker table is what closes that, and it is filename-and-first-key only:
 * nothing here parses a file.
 *
 * One test per language, because the table is the kind of code where a missing
 * row is invisible until someone's repository maps empty.
 */
import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "@greplost/core/schema";

import { markedLanguages } from "../src/init.ts";

/** A reader over an in-memory repo, in the shape `markedLanguages` takes. */
function reader(files: Record<string, string>): (rel: string) => string | undefined {
  return (rel) => files[rel];
}

/** The languages the marker table adds on top of the defaults. */
function added(files: Record<string, string>): string[] {
  const marked = markedLanguages(Object.keys(files).sort(), reader(files));
  return marked.languages.filter((lang) => !DEFAULT_CONFIG.languages.includes(lang));
}

describe("language markers", () => {
  test("a repo with no marker keeps the default TypeScript family and no signals", () => {
    const marked = markedLanguages(["src/index.ts", "package.json", "README.md"], reader({}));
    expect(marked.languages).toEqual([...DEFAULT_CONFIG.languages]);
    expect(marked.signals).toEqual([]);
  });

  test("python: pyproject.toml, setup.py or any .py", () => {
    expect(added({ "pyproject.toml": "" })).toEqual(["python"]);
    expect(added({ "setup.py": "" })).toEqual(["python"]);
    expect(added({ "src/app/main.py": "" })).toEqual(["python"]);
  });

  test("rust: Cargo.toml", () => {
    expect(added({ "Cargo.toml": "" })).toEqual(["rust"]);
    expect(added({ "crates/core/Cargo.toml": "" })).toEqual(["rust"]);
  });

  test("java: pom.xml, build.gradle or build.gradle.kts", () => {
    expect(added({ "pom.xml": "" })).toEqual(["java"]);
    expect(added({ "build.gradle": "" })).toEqual(["java"]);
    // `build.gradle.kts` is a Kotlin build script, so it marks both.
    expect(added({ "build.gradle.kts": "" })).toEqual(["java", "kotlin"]);
  });

  test("kotlin: build.gradle.kts or any .kt", () => {
    expect(added({ "src/main/kotlin/App.kt": "" })).toEqual(["kotlin"]);
    expect(added({ "settings.gradle.kts": "" })).toEqual(["kotlin"]);
  });

  test("hcl: any .tf", () => {
    expect(added({ "main.tf": "" })).toEqual(["hcl"]);
    expect(added({ "modules/vpc/variables.tf": "" })).toEqual(["hcl"]);
    // A `.tfvars` file is values, not configuration, and marks nothing on its own.
    expect(added({ "prod.tfvars": "" })).toEqual([]);
  });

  test("yaml: a Helm chart", () => {
    expect(added({ "charts/web/Chart.yaml": "" })).toEqual(["yaml"]);
  });

  test("yaml: an Actions workflow", () => {
    expect(added({ ".github/workflows/ci.yml": "on: push\n" })).toEqual(["yaml"]);
    expect(added({ ".github/workflows/release.yaml": "on: push\n" })).toEqual(["yaml"]);
  });

  test("yaml: a manifest whose first key is apiVersion", () => {
    expect(added({ "deploy/pod.yaml": "apiVersion: v1\nkind: Pod\n" })).toEqual(["yaml"]);
    // A plain YAML file is not a manifest: a repository full of CI and lockfile
    // YAML must not start indexing all of it because one file ends in `.yaml`.
    expect(added({ "config/app.yaml": "server:\n  port: 8080\n" })).toEqual([]);
    // Comments and blank lines come before the first key, and a document may
    // open with `---`.
    expect(added({ "k8s/svc.yaml": "# a service\n---\napiVersion: v1\nkind: Service\n" })).toEqual(["yaml"]);
  });

  test("dockerfile: any Dockerfile, Containerfile or Dockerfile.<suffix>", () => {
    expect(added({ Dockerfile: "" })).toEqual(["dockerfile"]);
    expect(added({ "docker/Dockerfile.ci": "" })).toEqual(["dockerfile"]);
    expect(added({ Containerfile: "" })).toEqual(["dockerfile"]);
  });

  test("go: a go.mod, which is build 1's rule and stays exactly as it was", () => {
    expect(added({ "go.mod": "module example.com/x\n" })).toEqual(["go"]);
    expect(added({ "services/api/go.mod": "module example.com/api\n" })).toEqual(["go"]);
  });

  test("a repo with several markers gets all of them, sorted, defaults first", () => {
    const marked = markedLanguages(
      ["Cargo.toml", "Dockerfile", "go.mod", "main.tf", "src/app.py"],
      reader({ "go.mod": "module example.com/x\n" }),
    );
    expect(marked.languages).toEqual([...DEFAULT_CONFIG.languages, "dockerfile", "go", "hcl", "python", "rust"]);
  });

  test("signals: a package.json dependency turns on the pass that reads it", () => {
    const react = markedLanguages(
      ["package.json", "src/app.tsx"],
      reader({ "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }) }),
    );
    expect(react.signals).toEqual(["react"]);

    const next = markedLanguages(
      ["package.json"],
      reader({ "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }) }),
    );
    expect(next.signals).toEqual(["next", "react"]);

    const tanstack = markedLanguages(
      ["package.json"],
      reader({ "package.json": JSON.stringify({ devDependencies: { "@tanstack/react-router": "1.0.0" } }) }),
    );
    expect(tanstack.signals).toEqual(["tanstack"]);

    const pulumi = markedLanguages(
      ["package.json"],
      reader({ "package.json": JSON.stringify({ dependencies: { "@pulumi/aws": "6.0.0", "@pulumi/pulumi": "3.0.0" } }) }),
    );
    expect(pulumi.signals).toEqual(["pulumi-ts"]);
  });

  test("signals: a Pulumi Go program is found in the go.mod's requirements", () => {
    const marked = markedLanguages(
      ["go.mod"],
      reader({ "go.mod": "module example.com/infra\n\nrequire github.com/pulumi/pulumi/sdk/v3 v3.100.0\n" }),
    );
    expect(marked.languages).toContain("go");
    expect(marked.signals).toEqual(["pulumi-go"]);
  });

  test("an unreadable marker file is not a marker, and never throws", () => {
    const marked = markedLanguages(["package.json", "go.mod"], () => undefined);
    expect(marked.languages).toEqual([...DEFAULT_CONFIG.languages, "go"]);
    expect(marked.signals).toEqual([]);
  });
});
