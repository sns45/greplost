// Copies the pinned tree-sitter WASM grammars that ship one into packages/core/grammars/.
//
// The four grammars that do not ship a usable wasm (rust, kotlin, hcl, dockerfile) are built
// from source by scripts/build-grammars.sh instead. packages/core/grammars/VERSIONS.txt is the
// record of which grammar came from which route, and why.
//
// Run after bumping a grammar in a scratch install:
//   bun scripts/vendor-grammars.ts <node_modules dir>
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const nm = process.argv[2] ?? "node_modules";
const out = join(import.meta.dir, "..", "packages", "core", "grammars");
mkdirSync(out, { recursive: true });
for (const [src, name] of [
  ["tree-sitter-typescript/tree-sitter-typescript.wasm", "tree-sitter-typescript.wasm"],
  ["tree-sitter-typescript/tree-sitter-tsx.wasm", "tree-sitter-tsx.wasm"],
  ["tree-sitter-go/tree-sitter-go.wasm", "tree-sitter-go.wasm"],
  ["tree-sitter-python/tree-sitter-python.wasm", "tree-sitter-python.wasm"],
  ["tree-sitter-java/tree-sitter-java.wasm", "tree-sitter-java.wasm"],
  ["@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm", "tree-sitter-yaml.wasm"],
  ["web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
]) {
  copyFileSync(join(nm, src!), join(out, name!));
  console.log("vendored", name);
}
