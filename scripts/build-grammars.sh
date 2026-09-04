#!/usr/bin/env bash
#
# Builds the four tree-sitter grammars that ship no usable wasm into packages/core/grammars/.
#
#   rust        the npm tarball's prebuilt wasm is older than its own src/parser.c (ABI 14 vs
#               LANGUAGE_VERSION 15), so the vendored artifact is built from the pinned source
#   hcl         the npm name `tree-sitter-hcl` is a security placeholder; the grammar lives on
#               GitHub and is cloned at a pinned tag
#   kotlin      no wasm in the tarball, and the newest npm release (0.3.8) predates Kotlin's
#               `fun interface`; the pinned commit below is the maintained main branch, which
#               parses every file of the pinned corpus (leaf 2.6 ruling; see VERSIONS.txt)
#   dockerfile  same: `tree-sitter-dockerfile` on npm is a placeholder
#
# The three that do ship a usable wasm (python, java, yaml) are copied by
# scripts/vendor-grammars.ts. packages/core/grammars/VERSIONS.txt records both routes and the
# exact pins; keep it in step with this script.
#
# No Docker: `tree-sitter build --wasm` uses the bundled wasi-sdk clang.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
out="$repo/packages/core/grammars"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

TREE_SITTER_CLI="tree-sitter-cli@0.27.0"

RUST_VERSION="0.24.0"
KOTLIN_COMMIT="1852ea17b7f60fb3f9d84e0b1555d56b46b39fb1"
HCL_TAG="v1.2.0"
HCL_COMMIT="fad991865fee927dd1de5e172fb3f08ac674d914"
DOCKERFILE_TAG="v0.2.0"
DOCKERFILE_COMMIT="868e44ce378deb68aac902a9db68ff82d2299dd0"

mkdir -p "$out"

# <grammar dir> <output wasm name>
build() {
  bunx "$TREE_SITTER_CLI" build --wasm -o "$out/$2" "$1"
  echo "built $2"
}

# <url> <expected commit> <dir name>: for a grammar whose fix is newer than its last release.
clone_commit() {
  git -C "$tmp" clone --quiet --filter=blob:none "$1" "$3"
  git -C "$tmp/$3" checkout --quiet "$2"
}

# <url> <tag> <expected commit> <dir name>
clone_pinned() {
  git -C "$tmp" clone --quiet --depth 1 --branch "$2" "$1" "$4"
  local head
  head="$(git -C "$tmp/$4" rev-parse HEAD)"
  if [ "$head" != "$3" ]; then
    echo "greplost: $4 tag $2 is $head, expected $3" >&2
    exit 1
  fi
}

# The grammar that comes from npm is installed into a scratch package so this script
# never depends on the monorepo's own node_modules holding them.
mkdir -p "$tmp/npm"
printf '{ "name": "greplost-grammar-build", "private": true }\n' > "$tmp/npm/package.json"
( cd "$tmp/npm" && bun add --no-save "tree-sitter-rust@$RUST_VERSION" >/dev/null )

clone_pinned https://github.com/tree-sitter-grammars/tree-sitter-hcl "$HCL_TAG" "$HCL_COMMIT" hcl
clone_pinned https://github.com/camdencheek/tree-sitter-dockerfile "$DOCKERFILE_TAG" "$DOCKERFILE_COMMIT" dockerfile
clone_commit https://github.com/fwcd/tree-sitter-kotlin "$KOTLIN_COMMIT" kotlin

build "$tmp/npm/node_modules/tree-sitter-rust" tree-sitter-rust.wasm
build "$tmp/kotlin" tree-sitter-kotlin.wasm
build "$tmp/hcl" tree-sitter-hcl.wasm
build "$tmp/dockerfile" tree-sitter-dockerfile.wasm

chmod 644 "$out"/tree-sitter-rust.wasm "$out"/tree-sitter-kotlin.wasm \
  "$out"/tree-sitter-hcl.wasm "$out"/tree-sitter-dockerfile.wasm

echo "grammars rebuilt into $out"
