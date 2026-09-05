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

# An extension function is read back from the `$this$<name>` entry the compiler writes into the
# local variable table, so the dump has to carry debug info at all. Asserted rather than assumed:
# without it every extension would quietly be renamed to its bare name and the oracle would
# disagree with the map about `String.shout` while looking healthy.
if ! grep -q 'LocalVariableTable' "$out/dump.txt"; then
  echo "greplost: the disassembly carries no LocalVariableTable, so an extension receiver cannot be read;" >&2
  echo "greplost: kotlinc must compile with debug info (do not pass -Xno-debug or strip the classfiles)" >&2
  exit 1
fi

python3 "$(dirname "$0")/parse_javap.py" "$out/dump.txt"
