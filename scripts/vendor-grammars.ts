// Copies the pinned tree-sitter WASM grammars into packages/core/grammars/.
// Run after bumping tree-sitter-typescript / tree-sitter-go / web-tree-sitter in the spike or a scratch install:
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
  ["web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
]) {
  copyFileSync(join(nm, src!), join(out, name!));
  console.log("vendored", name);
}
