#!/usr/bin/env bash
# Compile one Kotlin source tree and read the classfiles back as greplost's truth document.
#
# The Kotlin oracle for `fixtures/tiny-kotlin` only (spec 2026-09-04 section 1.7): build 2 ships
# no corpus-scale Kotlin oracle, because `kotlinx.coroutines` is a Gradle multiplatform build
# that does not compile outside Gradle. Here compilation is trivially controllable, so the
# oracle is the compiler itself: `kotlinc` writes the classfiles and `javap -v -p` reads them.
#
#   usage: run.sh <source root>
#   stdout: {files, imports, exports, calls, errors}
set -euo pipefail

src="$1"
out="$(mktemp -d "${TMPDIR:-/tmp}/kotlintruth.XXXXXXXX")"
trap 'rm -rf "$out"' EXIT

kotlinc "$src" -d "$out/classes" -nowarn 1>&2

# `javap -v` prints each class's SourceFile attribute, which is what restores per-`.kt`
# attribution: one file compiles to a facade class, a class per type, and a synthetic class per
# lambda. `-p` is needed because a private member is still a declaration.
find "$out/classes" -name '*.class' -print0 | sort -z | xargs -0 javap -v -p > "$out/dump.txt"

python3 "$(dirname "$0")/parse_javap.py" "$out/dump.txt"
