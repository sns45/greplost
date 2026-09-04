#!/usr/bin/env python3
"""Read a `javap -v -p` dump of kotlinc's output and print greplost's truth document.

This is the Kotlin oracle for `fixtures/tiny-kotlin` (spec 2026-09-04 section 1.7: build 2
ships no corpus-scale Kotlin oracle, and this one deliberately covers the fixture only). It
never reads Kotlin source and never imports anything of greplost's: every fact below comes out
of a classfile the Kotlin compiler wrote.

How a classfile is read back into Kotlin's own vocabulary:

  file        each class carries a `SourceFile` attribute, and its package comes from its own
              binary name, so `tiny/Box$Companion` with `SourceFile: "Store.kt"` belongs to
              `tiny/Store.kt`. That attribute is what restores per-`.kt` attribution when one
              file compiles to six classes.
  class kind  the `kotlin.Metadata` annotation's `k` field is part of Kotlin's published
              annotation: k=1 is a class (or interface, object, companion), k=2 is the file
              facade a file's top-level members compile into, k=3 is a synthetic class (a
              lambda, a coroutine continuation). k=3 and unannotated classes are not source
              declarations and are skipped; their constant pools still count for imports.
  name        a nested class is `Outer$Inner` in bytecode and `Outer.Inner` in Kotlin, so a
              companion reads as `Box.Companion`, which is where greplost declares its members.
  extension   `fun Item.label()` compiles to a static `label(Item)` whose receiver is the first
              parameter, named `$this$label` in the local variable table. That name is the
              compiler's own marker for an extension receiver, and it is what lets the oracle
              call the member `Item.label` rather than `label`.
  property    `val id` compiles to a private field plus `getId()`. A public accessor whose
              stripped name matches a field is reported as the property, never as a method, so
              both sides speak about `Item.id`.
  import      Kotlin needs an import exactly when a reference crosses a package, so an import
              edge is a constant-pool class reference to another package's file.
  call        every `invokevirtual/static/special/interface` in a method body, with the target
              mapped through the same rules. A constructor call is an edge to the type itself
              (Kotlin has no `new`), and a call to a property accessor is not a call in Kotlin
              source, so it is not one here either.

Dropped, and disclosed in `NOTES` rather than hidden: members the compiler generated
(`component1`, `copy`, `equals`, `hashCode`, `toString`, enum `values`, an object's `INSTANCE`,
a companion holder field), anything flagged synthetic or bridge, and any name carrying a `$`
(a local function, a `$default` overload, an `internal` member's mangled name). A `$`-suffixed
caller is folded back onto the source function that spawned it.
"""

from __future__ import annotations

import json
import re
import sys

# --------------------------------------------------------------------------
# lexing the dump
# --------------------------------------------------------------------------

THIS_CLASS = re.compile(r"^  this_class: #\d+\s+//\s*(\S+)\s*$")
CONSTANT_CLASS = re.compile(r"^\s+#\d+ = Class\s+#\d+\s+//\s*(\S+)\s*$")
CLASS_FLAGS = re.compile(r"^  flags: \(0x[0-9a-fA-F]+\)(.*)$")
MEMBER_FLAGS = re.compile(r"^    flags: \(0x[0-9a-fA-F]+\)(.*)$")
DESCRIPTOR = re.compile(r"^    descriptor: (.+)$")
SOURCE_FILE = re.compile(r'^SourceFile: "(.+)"$')
MEMBER_DECL = re.compile(r"^  (\S.*);\s*$")
INVOKE = re.compile(r"invoke(?:virtual|static|special|interface)\s+#\d+(?:,\s*\d+)?\s+//\s+(?:Interface)?Method\s+(\S+)")
METADATA_K = re.compile(r"^\s+k=(\d+)\s*$", re.M)

# Members the compiler writes for every data class, plus the JVM's own object protocol.
DATA_SYNTHETIC = re.compile(r"^component\d+$")
OBJECT_METHODS = {
    ("equals", "(Ljava/lang/Object;)Z"),
    ("hashCode", "()I"),
    ("toString", "()Ljava/lang/String;"),
}
ENUM_MEMBERS = {"values", "valueOf", "getEntries", "$VALUES"}


class Member:
    __slots__ = ("name", "descriptor", "flags", "calls", "text")

    def __init__(self, name: str, descriptor: str, flags: set, calls: list, text: str) -> None:
        self.name = name
        self.descriptor = descriptor
        self.flags = flags
        self.calls = calls
        self.text = text

    @property
    def is_method(self) -> bool:
        return self.descriptor.startswith("(")

    @property
    def public(self) -> bool:
        return "ACC_PUBLIC" in self.flags

    @property
    def static(self) -> bool:
        return "ACC_STATIC" in self.flags

    @property
    def generated(self) -> bool:
        return "ACC_SYNTHETIC" in self.flags or "ACC_BRIDGE" in self.flags


class ClassFile:
    __slots__ = ("internal", "source", "flags", "kind", "refs", "members")

    def __init__(self) -> None:
        self.internal = ""
        self.source = ""
        self.flags = set()
        self.kind = 0
        self.refs = []
        self.members = []

    @property
    def package(self) -> str:
        cut = self.internal.rfind("/")
        return "" if cut == -1 else self.internal[:cut]

    @property
    def simple(self) -> str:
        cut = self.internal.rfind("/")
        return self.internal if cut == -1 else self.internal[cut + 1 :]

    @property
    def kotlin_name(self) -> str:
        """`Box$Companion` is `Box.Companion` in Kotlin."""
        return self.simple.replace("$", ".")

    @property
    def file_key(self) -> str:
        return f"{self.package}/{self.source}" if self.package else self.source

    @property
    def synthetic(self) -> bool:
        """A lambda, a coroutine continuation, or a class the compiler did not mark at all."""
        if self.kind not in (1, 2):
            return True
        return any(part.isdigit() for part in self.simple.split("$"))


def split_sections(dump: str) -> list:
    sections, current = [], []
    for line in dump.split("\n"):
        if line.startswith("Classfile "):
            if current:
                sections.append(current)
            current = []
        current.append(line)
    if current:
        sections.append(current)
    return sections


def parse_member_name(decl: str, descriptor: str, printed_class: str) -> str:
    if not descriptor.startswith("("):
        return decl.split()[-1] if decl.split() else ""
    if decl.startswith("static {}"):
        return "<clinit>"
    head = decl.split("(")[0].strip()
    token = head.split()[-1] if head.split() else ""
    return "<init>" if token == printed_class else token


def parse_class(lines: list) -> ClassFile:
    cls = ClassFile()
    printed_class = ""
    in_body = False
    decl = ""
    descriptor = ""
    flags = set()
    calls = []
    text = []

    def flush() -> None:
        if decl and descriptor:
            name = parse_member_name(decl, descriptor, printed_class)
            if name:
                cls.members.append(Member(name, descriptor, set(flags), list(calls), "\n".join(text)))

    for line in lines:
        if not in_body:
            match = THIS_CLASS.match(line)
            if match is not None:
                cls.internal = match.group(1)
                printed_class = cls.internal.replace("/", ".")
                continue
            match = CONSTANT_CLASS.match(line)
            if match is not None:
                cls.refs.append(match.group(1))
                continue
            match = CLASS_FLAGS.match(line)
            if match is not None and not cls.flags:
                cls.flags = set(re.findall(r"ACC_\w+", match.group(1)))
                continue
            if line == "{":
                in_body = True
            continue

        if line == "}":
            flush()
            in_body = False
            decl = ""
            continue

        match = MEMBER_DECL.match(line)
        if match is not None:
            flush()
            decl, descriptor, flags, calls, text = match.group(1), "", set(), [], []
            continue
        if not decl:
            continue
        text.append(line)
        match = DESCRIPTOR.match(line)
        if match is not None:
            descriptor = match.group(1).strip()
            continue
        match = MEMBER_FLAGS.match(line)
        if match is not None:
            flags = set(re.findall(r"ACC_\w+", match.group(1)))
            continue
        for target in INVOKE.findall(line):
            calls.append(target)

    flush()

    joined = "\n".join(lines)
    match = SOURCE_FILE.search(joined)
    if match is not None:
        cls.source = match.group(1)
    for source_line in joined.split("\n"):
        if source_line.strip().startswith('SourceFile: "'):
            cls.source = source_line.split('"')[1]
    metadata = joined.find("kotlin.Metadata(")
    if metadata != -1:
        found = METADATA_K.search(joined, metadata)
        if found is not None:
            cls.kind = int(found.group(1))
    return cls


# --------------------------------------------------------------------------
# JVM names -> Kotlin names
# --------------------------------------------------------------------------


def first_parameter(descriptor: str) -> str:
    """The internal name of a method descriptor's first parameter, or ""."""
    body = descriptor[1 : descriptor.find(")")] if descriptor.startswith("(") else ""
    if body.startswith("L") and ";" in body:
        return body[1 : body.index(";")]
    return ""


def simple_name(internal: str) -> str:
    cut = internal.rfind("/")
    return (internal if cut == -1 else internal[cut + 1 :]).replace("$", ".")


def property_of(member: Member, fields: set) -> str:
    """The property a JVM accessor stands for, or "" when the member is a real method."""
    name, descriptor = member.name, member.descriptor
    parameters = descriptor[1 : descriptor.find(")")]
    if name.startswith("get") and len(name) > 3 and parameters == "":
        candidate = name[3].lower() + name[4:]
    elif name.startswith("is") and len(name) > 2 and parameters == "":
        candidate = name[2].lower() + name[3:]
    elif name.startswith("set") and len(name) > 3:
        candidate = name[3].lower() + name[4:]
    else:
        return ""
    return candidate if candidate in fields else ""


def member_symbol(cls: ClassFile, member: Member, fields: set, *, as_target: bool) -> str:
    """The Kotlin symbol path a member declares, or "" when it is not a source declaration."""
    name = member.name
    if member.generated or name in ("<clinit>",):
        return ""
    if name == "<init>":
        # Kotlin has no `new`: a constructor call is a call to the type itself.
        return cls.kotlin_name if (as_target and cls.kind == 1) else ""
    if "$" in name:
        return ""
    if DATA_SYNTHETIC.match(name) is not None or name == "copy":
        return ""
    if (name, member.descriptor) in OBJECT_METHODS:
        return ""
    if "ACC_ENUM" in cls.flags and name in ENUM_MEMBERS:
        return ""
    if not member.is_method:
        if name in ("INSTANCE", "Companion") and member.static:
            return ""
        local = name
    else:
        accessor = property_of(member, fields)
        if accessor != "":
            # A property read is not a call in Kotlin source, so it is not a call edge here.
            return "" if as_target else f"{prefix(cls)}{accessor}"
        local = name
        if cls.kind == 2 and member.static:
            receiver = extension_receiver(member)
            if receiver != "":
                return f"{receiver}.{local}"
    return f"{prefix(cls)}{local}"


def prefix(cls: ClassFile) -> str:
    """Members of a file facade are top-level names; members of a class hang off its name."""
    return "" if cls.kind == 2 else f"{cls.kotlin_name}."


def extension_receiver(member: Member) -> str:
    """`$this$label` in the local variable table marks the extension receiver (slot 0)."""
    if f"$this${member.name}" not in member.text:
        return ""
    parameter = first_parameter(member.descriptor)
    return simple_name(parameter) if parameter else ""


def caller_symbol(cls: ClassFile, member: Member, fields: set) -> str:
    """The declaration a method body belongs to; a `$`-suffixed synthetic folds back onto it."""
    if member.name in ("<init>", "<clinit>") or member.generated:
        return ""
    if "$" in member.name:
        head = member.name.split("$")[0]
        if head == "" or head == "access":
            return ""
        member = Member(head, member.descriptor, member.flags, member.calls, member.text)
    return member_symbol(cls, member, fields, as_target=False)


def strip_array(internal: str) -> str:
    while internal.startswith("["):
        internal = internal[1:]
    if internal.startswith("L") and internal.endswith(";"):
        internal = internal[1:-1]
    return internal


# --------------------------------------------------------------------------
# the document
# --------------------------------------------------------------------------


def build(dump: str) -> dict:
    classes = [parse_class(section) for section in split_sections(dump)]
    classes = [cls for cls in classes if cls.internal and cls.source]
    by_internal = {cls.internal: cls for cls in classes}

    files = sorted({cls.file_key for cls in classes})
    exports = {name: set() for name in files}
    imports = set()
    calls = set()
    errors = []

    for cls in classes:
        if cls.kind == 0:
            errors.append(f"{cls.internal}: no kotlin.Metadata annotation")

    # Imports: a constant-pool reference that crosses a package is what an import is for.
    for cls in classes:
        for ref in cls.refs:
            target = by_internal.get(strip_array(ref))
            if target is None or target.package == cls.package:
                continue
            if target.file_key == cls.file_key:
                continue
            imports.add((cls.file_key, target.file_key))

    for cls in classes:
        if cls.synthetic:
            continue
        fields = {member.name for member in cls.members if not member.is_method}
        if cls.kind == 1 and "ACC_PUBLIC" in cls.flags:
            exports[cls.file_key].add(cls.kotlin_name)
        for member in cls.members:
            symbol = member_symbol(cls, member, fields, as_target=False)
            if symbol != "":
                # A member of a non-public class is not an export of the file.
                if member.public and (cls.kind == 2 or "ACC_PUBLIC" in cls.flags):
                    exports[cls.file_key].add(symbol)

            caller = caller_symbol(cls, member, fields)
            if caller == "":
                continue
            for target in member.calls:
                edge = call_edge(f"{cls.file_key}#{caller}", target, by_internal, cls)
                if edge is not None:
                    calls.add(edge)

    return {
        "files": files,
        "imports": [{"from": a, "to": b} for a, b in sorted(imports)],
        "exports": {name: sorted(values) for name, values in sorted(exports.items())},
        "calls": [{"from": a, "to": b} for a, b in sorted(calls)],
        "errors": sorted(errors),
    }


def call_edge(source: str, target: str, by_internal: dict, current: ClassFile):
    # javap prints `// Method accept:(Ltiny/Item;)Z` with no class when the callee is a member
    # of the class being disassembled, and `// Method tiny/Item.getId:()...` when it is not.
    cut = target.find(".")
    colon_at = target.find(":")
    if cut == -1 or (colon_at != -1 and colon_at < cut):
        owner, rest = current.internal, target
    else:
        owner, rest = strip_array(target[:cut]), target[cut + 1 :]
    colon = rest.find(":")
    if colon == -1:
        return None
    name = rest[:colon].strip('"')
    descriptor = rest[colon + 1 :]
    cls = by_internal.get(owner)
    if cls is None or cls.synthetic:
        return None
    fields = {member.name for member in cls.members if not member.is_method}
    match = None
    for member in cls.members:
        if member.name == name and member.descriptor == descriptor:
            match = member
            break
    if match is None:
        match = Member(name, descriptor, set(), [], "")
        for member in cls.members:
            if member.name == name:
                match = member
                break
    symbol = member_symbol(cls, match, fields, as_target=True)
    if symbol == "":
        return None
    return (source, f"{cls.file_key}#{symbol}")


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: parse_javap.py <javap-dump>\n")
        return 2
    with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as handle:
        dump = handle.read()
    json.dump(build(dump), sys.stdout, sort_keys=True, indent=None)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
