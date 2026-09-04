import { describe, expect, test } from "bun:test";
import { langOf } from "../src/lang.ts";
import { LANG_BY_BASENAME, LANG_BY_EXTENSION } from "../src/schema.ts";

describe("langOf", () => {
  test("maps extensions", () => {
    expect(langOf("a/b.py")).toBe("python");
    expect(langOf("a/b.rs")).toBe("rust");
    expect(langOf("a/b.tf")).toBe("hcl");
    expect(langOf("a/b.yml")).toBe("yaml");
  });

  test("maps every extension in the schema table", () => {
    for (const [extension, lang] of Object.entries(LANG_BY_EXTENSION)) {
      expect(langOf(`dir/file${extension}`)).toBe(lang);
    }
  });

  test("maps extensionless basenames", () => {
    expect(langOf("Dockerfile")).toBe("dockerfile");
    expect(langOf("deploy/Containerfile")).toBe("dockerfile");
    expect(langOf("Dockerfile.dev")).toBe("dockerfile");
  });

  test("maps every basename in the schema table, at any depth", () => {
    for (const [base, lang] of Object.entries(LANG_BY_BASENAME)) {
      expect(langOf(base)).toBe(lang);
      expect(langOf(`a/b/${base}`)).toBe(lang);
    }
  });

  test("the Dockerfile prefix beats the extension rule", () => {
    // `.ts` is a known extension, but a `Dockerfile.*` basename is a Dockerfile.
    expect(langOf("build/Dockerfile.ts")).toBe("dockerfile");
    expect(langOf("Dockerfile.ci")).toBe("dockerfile");
    // The bare prefix with nothing after it is not a Dockerfile variant name.
    expect(langOf("Dockerfile.")).toBeUndefined();
  });

  test("returns undefined for unknown files", () => {
    expect(langOf("README.md")).toBeUndefined();
    expect(langOf("notadockerfile")).toBeUndefined();
    expect(langOf("")).toBeUndefined();
    expect(langOf("src/.gitignore")).toBeUndefined();
    expect(langOf("a/b/Makefile")).toBeUndefined();
  });

  test("is case sensitive and anchored on the basename", () => {
    expect(langOf("dockerfile")).toBeUndefined();
    expect(langOf("a/Dockerfile/b.md")).toBeUndefined();
    expect(langOf("MyDockerfile.dev")).toBeUndefined();
  });
});
