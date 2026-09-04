import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSnapshot } from "../src/build.ts";
import { DEFAULT_CONFIG } from "../src/schema.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe("restamp", () => {
  test("byte-identical Rust files keep their ~<n> ids and parents, re-homed to each file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "greplost-restamp-"));
    roots.push(root);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "Cargo.toml"), '[package]\nname = "twins"\nversion = "0.1.0"\n');
    writeFileSync(path.join(root, "src", "lib.rs"), "pub mod a;\npub mod b;\n");
    const body = "pub struct Store;\nimpl Store {\n    pub fn new() -> Store { Store }\n}\n";
    writeFileSync(path.join(root, "src", "a.rs"), body);
    writeFileSync(path.join(root, "src", "b.rs"), body);
    const snapshot = await buildSnapshot({ root, config: { ...DEFAULT_CONFIG, languages: ["rust"] } });
    const ids = (file: string) => snapshot.symbols.filter((d) => d.file === file).map((d) => d.id).sort();
    expect(ids("src/a.rs")).toEqual(["src/a.rs#Store", "src/a.rs#Store.new", "src/a.rs#Store~2"]);
    expect(ids("src/b.rs")).toEqual(["src/b.rs#Store", "src/b.rs#Store.new", "src/b.rs#Store~2"]);
    const parents = snapshot.symbols.filter((d) => d.parent !== undefined).map((d) => `${d.id} < ${d.parent}`).sort();
    expect(parents).toEqual(["src/a.rs#Store.new < Store", "src/b.rs#Store.new < Store"]);
  });
});
