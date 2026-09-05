"""Python structural truth for greplost's Eval 1 (bench spec 1.6, build 2 leaf 2.1).

The structure layer is never scored against itself (tech spec 10.1, principle 2), so
nothing here knows greplost exists: this is a standalone Python 3.14 program, standard
library only, that reads a list of files and prints what Python itself says about them.

    python3 bench/truth/pytruth/main.py --root <root> --files <listfile>

It prints one JSON document on stdout:

    {"files": [...], "imports": [...], "exports": {...}, "calls": [...],
     "cycles": [[...]], "errors": [...], "modules": <int>}

**Nothing is imported and nothing is executed.** Every file is read as bytes and parsed
with ``ast.parse``; module resolution is a path probe over the *explicit file list given on
the command line*, never over ``sys.path`` and never over site-packages. That is a safety
property (a corpus is untrusted code) and a correctness one (an oracle that imported the
corpus would report whatever happened to be installed on the machine). ``no import
execution`` in ``bench/test/truth-python.test.ts`` is the test that holds it.

What the four sets mean, in greplost's id vocabulary (tech spec 5.3):

``files``    the files that parsed. A file with a syntax error is listed in ``errors`` and
             dropped from every set, so it is never scored as "a file that exports nothing".
``imports``  one edge per (importing file, imported in-repo module *file*). A Python package
             is a file - the ``__init__.py`` the interpreter runs - so a package import
             targets that file rather than the directory. The edge names the module the
             specifier itself refers to: ``from pkg import sub`` is an edge to
             ``pkg/__init__.py``, because whether ``sub`` is a submodule or a name bound in
             ``__init__`` is a question no static reader can answer without executing it.
             A file that imports itself is not an edge: a package's own ``__init__.py``
             writing ``from pkg import sub`` is not a dependency between two files.
             When the specifier names no module file at all - a PEP 420 namespace package,
             which has no ``__init__.py`` to point at - each imported name is tried as a
             submodule of it, because that is the only thing the statement can mean.
             A literal ``importlib.import_module("x")`` is an edge too - it is the one
             dynamic-import spelling Python has, and a string constant names a module as
             plainly as an ``import`` statement does.
``exports``  file -> the module's public surface: the entries of a literal ``__all__`` when
             the module states one, otherwise the module-level names it *defines* (``def``,
             ``class``, assignment) that do not start with an underscore. Imported names are
             not a module's own surface.
``calls``    edges between named definitions, resolved by a scope-aware binder: module
             scope, class scope and function scope, with ``global``/``nonlocal`` restoring
             module scope. A callee bound by an enclosing function is a local and is
             omitted, and so is anything else that is not certain.
``cycles``   strongly connected components of size > 1 over the import graph, each sorted,
             the list sorted - the same shape greplost's Tarjan pass produces.

PEP 420 namespace packages (a directory with no ``__init__.py``) carry no module file, so an
import of one resolves to nothing and is simply not an edge; that is disclosed in the notes.

There is deliberately no external/unresolved distinction on this side to mirror the
extractor's: ``ModuleTable.resolve`` answers a file or ``None``, and ``None`` means "not an
edge". The extractor has to choose between ``ext:pypi/<name>`` and ``unresolved:`` because
both appear in the map a reader looks at, but neither is a file id, so the scorer drops both
before either side is compared. Nothing here needs the distinction, and inventing one would
be a rule with no observable behaviour.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys
import tomllib
from dataclasses import dataclass, field

# Extensions a Python module can be written with, in probe order.
MODULE_EXTENSIONS = (".py", ".pyi")
# Files whose presence marks a directory as an import root.
PROJECT_MARKERS = ("pyproject.toml", "setup.py", "setup.cfg")


# ---------------------------------------------------------------------------
# import roots and the module table
# ---------------------------------------------------------------------------


def _declared_roots(directory: str, absolute: str) -> list[str]:
    """Import roots a ``pyproject.toml`` declares, as paths relative to the repo root.

    Read with ``tomllib`` rather than by pattern, so a key that merely looks like a
    ``package-dir`` entry somewhere else in the file cannot be mistaken for one.
    """
    try:
        with open(absolute, "rb") as handle:
            data = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return []
    out: list[str] = []

    def add(value: object) -> None:
        if not isinstance(value, str):
            return
        cleaned = value.strip().removeprefix("./").rstrip("/")
        if cleaned in ("", ".") or ".." in cleaned:
            return
        joined = _join(directory, cleaned)
        if joined not in out:
            out.append(joined)

    tool = data.get("tool")
    if isinstance(tool, dict):
        setuptools = tool.get("setuptools")
        if isinstance(setuptools, dict):
            package_dir = setuptools.get("package-dir")
            if isinstance(package_dir, dict):
                add(package_dir.get(""))
        poetry = tool.get("poetry")
        if isinstance(poetry, dict):
            packages = poetry.get("packages")
            if isinstance(packages, list):
                for entry in packages:
                    if isinstance(entry, dict):
                        add(entry.get("from"))
    return out


def _join(directory: str, rest: str) -> str:
    if rest == "":
        return directory
    return rest if directory == "" else f"{directory}/{rest}"


def _parent(directory: str) -> str:
    index = directory.rfind("/")
    return "" if index < 0 else directory[:index]


def import_roots(root: str, files: list[str]) -> list[str]:
    """Directories a dotted module path is resolved against, most specific first.

    Found by probing every ancestor directory of a listed file for a project marker; a
    conventional ``src/`` layout under a marker directory counts even when nothing declares
    it. The repo root is always the last resort.
    """
    declared: list[str] = []
    markers: list[str] = []
    probed: set[str] = set()
    listed = set(files)
    for name in sorted(files):
        current = _parent(name)
        while True:
            if current not in probed:
                probed.add(current)
                for marker in PROJECT_MARKERS:
                    absolute = os.path.join(root, _join(current, marker))
                    if not os.path.exists(absolute):
                        continue
                    if current not in markers:
                        markers.append(current)
                    if marker == "pyproject.toml":
                        for declared_root in _declared_roots(current, absolute):
                            if declared_root not in declared:
                                declared.append(declared_root)
                    src = _join(current, "src")
                    if src not in declared and any(f.startswith(src + "/") for f in listed):
                        declared.append(src)
            if current == "":
                break
            current = _parent(current)

    def depth(name: str) -> tuple[int, str]:
        return (-len(name.split("/")), name)

    return sorted(declared, key=depth) + sorted(markers, key=depth) + [""]


def module_name(root_dir: str, path: str) -> str:
    """The dotted name of ``path`` read as a module under ``root_dir``."""
    relative = path[len(root_dir) + 1 :] if root_dir else path
    for extension in MODULE_EXTENSIONS:
        if relative.endswith(extension):
            relative = relative[: -len(extension)]
            break
    parts = relative.split("/")
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


class ModuleTable:
    """Dotted module name <-> file, over the explicit file list and nothing else."""

    def __init__(self, root: str, files: list[str]) -> None:
        self.files = set(files)
        self.roots = import_roots(root, files)
        self.by_file: dict[str, str] = {}
        for path in sorted(files):
            for root_dir in self.roots:
                if root_dir == "" or path.startswith(root_dir + "/"):
                    self.by_file[path] = module_name(root_dir, path)
                    break

    def resolve(self, dotted: str) -> str | None:
        """The file a dotted module path names, or None when the list does not hold it."""
        if not dotted:
            return None
        relative = dotted.replace(".", "/")
        for root_dir in self.roots:
            candidate = _join(root_dir, relative)
            for extension in MODULE_EXTENSIONS:
                if candidate + extension in self.files:
                    return candidate + extension
            for extension in MODULE_EXTENSIONS:
                # A package is the file the interpreter runs, not the directory.
                if f"{candidate}/__init__{extension}" in self.files:
                    return f"{candidate}/__init__{extension}"
        return None

    def package_of(self, path: str) -> str:
        """The package a relative import in ``path`` is resolved against (PEP 328)."""
        name = self.by_file.get(path, "")
        if path.rsplit("/", 1)[-1].startswith("__init__."):
            return name
        return name.rpartition(".")[0]


# ---------------------------------------------------------------------------
# per-module analysis
# ---------------------------------------------------------------------------


@dataclass
class ModuleFacts:
    """Everything one parsed module says about itself, before cross-module resolution."""

    path: str
    tree: ast.Module
    # Top-level names the module defines: def, class, and assignment targets.
    defined: dict[str, str] = field(default_factory=dict)
    # Every symbol path the module declares, `Class.method` included.
    symbols: set[str] = field(default_factory=set)
    # Every declaration's id suffix, in source order, with `~<n>` from 2 on a repeat:
    # ["C", "C.value", "C.value~2"]. Python declares one name twice as a matter of course
    # (`@property def value` beside `@value.setter def value`, a stack of `@overload`s), and
    # greplost's ids carry the same `~<n>` so each declaration keeps an id of its own
    # (driver ruling 2026-09-04, every language). Recorded here so both sides say the same
    # thing about what a name is worth: an *id* names one declaration, and the plain,
    # unsuffixed id is the first one. That is what a call edge targets on both sides -
    # `symbol_id` below is the only place this oracle turns a name into an id.
    symbol_ids: list[str] = field(default_factory=list)

    def symbol_id(self, symbol: str) -> str | None:
        """The id of the *first* declaration of ``symbol``, or None when there is none.

        The first declaration keeps the plain id, so this is `symbol` itself whenever the
        module declares it at all. Written as a lookup rather than a `symbol in symbols`
        test so that the suffix rule has one home on this side too: a later rule that
        pointed an edge at a *later* declaration would change this function and nothing else.
        """
        return symbol if symbol in self.symbols else None
    # Local name -> (module specifier text, level, imported name or "*" for the module).
    bindings: dict[str, tuple[str, int, str]] = field(default_factory=dict)
    # Entries of a literal `__all__`, or None when the module states none it can read.
    all_names: list[str] | None = None


def _literal_sequence(node: ast.expr) -> list[str] | None:
    """The string literals of a list, tuple or bare tuple; None when it is not one."""
    if not isinstance(node, (ast.List, ast.Tuple)):
        return None
    out: list[str] = []
    for element in node.elts:
        if not isinstance(element, ast.Constant) or not isinstance(element.value, str):
            return None
        out.append(element.value)
    return out


def _assigned_names(target: ast.expr) -> list[str]:
    """Plain identifiers a single assignment target binds (never attributes or subscripts)."""
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        out: list[str] = []
        for element in target.elts:
            out.extend(_assigned_names(element))
        return out
    if isinstance(target, ast.Starred):
        return _assigned_names(target.value)
    return []


def _chained_targets(targets: list[ast.expr], statement: ast.stmt) -> list[ast.expr]:
    """Assignment targets, with ``a = b = 1``'s second name included.

    ``ast`` already flattens a chain into ``targets``, so this only has to hand them back;
    it exists so the rule has one name, and so the difference from a parser that nests the
    chain instead of flattening it is written down rather than assumed.
    """
    del statement
    return list(targets)


def _body_of(node: ast.stmt) -> list[list[ast.stmt]]:
    """The statement blocks a compound statement owns, all at the statement's own scope."""
    blocks: list[list[ast.stmt]] = []
    for name in ("body", "orelse", "finalbody"):
        block = getattr(node, name, None)
        if isinstance(block, list):
            blocks.append(block)
    for handler in getattr(node, "handlers", []) or []:
        blocks.append(handler.body)
    for case in getattr(node, "cases", []) or []:
        blocks.append(case.body)
    return blocks


COMPOUND = (ast.If, ast.Try, ast.TryStar, ast.With, ast.AsyncWith, ast.For, ast.AsyncFor, ast.While, ast.Match)
DEFINITIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def _unique_id(facts: ModuleFacts, name: str) -> str:
    """``name``, then ``name~2``, ``name~3`` for each further declaration of it in this file.

    The mirror of greplost's rule: the suffix is part of the *id* only, never of the name a
    reader sees, and the numbering follows source order so a new overload never renumbers an
    older one. ``~`` cannot occur in a Python identifier, so a suffixed id can never collide
    with one somebody wrote.
    """
    if name not in facts.symbols:
        return name
    n = 2
    while f"{name}~{n}" in facts.symbol_ids:
        n += 1
    return f"{name}~{n}"


def walk_scope(body: list[ast.stmt], parent: str, facts: ModuleFacts) -> None:
    """Names a module body or a class body binds, descending through compound statements.

    Function bodies are *not* descended into: a ``def`` inside a ``def`` binds a local, not a
    module attribute.
    """
    for statement in body:
        if isinstance(statement, DEFINITIONS):
            name = statement.name if parent == "" else f"{parent}.{statement.name}"
            facts.symbol_ids.append(_unique_id(facts, name))
            facts.symbols.add(name)
            if parent == "":
                facts.defined.setdefault(statement.name, "class" if isinstance(statement, ast.ClassDef) else "def")
            if isinstance(statement, ast.ClassDef):
                walk_scope(statement.body, name, facts)
            continue
        if isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            if parent != "":
                continue  # a class body's assignments are its attributes, not module names
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            # Only a *plain identifier* target is a declaration. A tuple unpacking
            # (`a, b = f()`) does bind module names, but it declares no single thing with a
            # signature, so neither side of the comparison treats it as one.
            for target in _chained_targets(targets, statement):
                if isinstance(target, ast.Name) and target.id != "__all__":
                    facts.defined.setdefault(target.id, "value")
            continue
        if isinstance(statement, COMPOUND):
            for block in _body_of(statement):
                walk_scope(block, parent, facts)


def _all_writes(body: list[ast.stmt], out: list[tuple[bool, list[str] | None]]) -> None:
    """Every module-level write to ``__all__``, in source order, as (augmented, literal)."""
    for statement in body:
        if isinstance(statement, COMPOUND):
            for block in _body_of(statement):
                _all_writes(block, out)
            continue
        target: ast.expr | None = None
        value: ast.expr | None = None
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
            target, value = statement.targets[0], statement.value
        elif isinstance(statement, ast.AugAssign):
            target, value = statement.target, statement.value
        if not isinstance(target, ast.Name) or target.id != "__all__" or value is None:
            continue
        out.append((isinstance(statement, ast.AugAssign), _literal_sequence(value)))


def collect_all(body: list[ast.stmt], facts: ModuleFacts) -> None:
    """The module's ``__all__``, when every write to it is a literal sequence of strings.

    One unreadable write, wherever it is, leaves ``all_names`` None: a surface that cannot be
    read is not a surface to guess at, and the underscore convention takes over.
    """
    writes: list[tuple[bool, list[str] | None]] = []
    _all_writes(body, writes)
    if not writes or any(listed is None for _, listed in writes):
        facts.all_names = None
        return
    names: list[str] = []
    for augmented, listed in writes:
        if not augmented:
            names = []
        for name in listed or []:
            if name not in names:
                names.append(name)
    facts.all_names = names


def collect_bindings(tree: ast.Module, facts: ModuleFacts) -> None:
    """Every name the module's imports bind, wherever the import is written.

    Nested function bodies are included on purpose: a module that imports inside a function
    still names that module, and the import edge is real.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                local = alias.asname or alias.name.split(".")[0]
                facts.bindings.setdefault(local, (alias.name, 0, "*"))
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    continue
                local = alias.asname or alias.name
                facts.bindings.setdefault(local, (node.module or "", node.level, alias.name))


# ---------------------------------------------------------------------------
# calls
# ---------------------------------------------------------------------------


def function_bindings(node: ast.AST) -> set[str]:
    """Names bound inside one function scope, nested scopes flattened into it.

    ``global x`` and ``nonlocal x`` say the name is *not* this scope's, so they are removed
    again at the end: a call through one reaches the module-level definition.
    """
    bound: set[str] = set()
    escaped: set[str] = set()
    args = getattr(node, "args", None)
    if isinstance(args, ast.arguments):
        for group in (args.posonlyargs, args.args, args.kwonlyargs):
            for argument in group:
                bound.add(argument.arg)
        for optional in (args.vararg, args.kwarg):
            if optional is not None:
                bound.add(optional.arg)

    for child in ast.walk(node):
        if child is node:
            continue
        if isinstance(child, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            targets = child.targets if isinstance(child, ast.Assign) else [child.target]
            for target in targets:
                bound.update(_assigned_names(target))
        elif isinstance(child, ast.NamedExpr):
            bound.update(_assigned_names(child.target))
        elif isinstance(child, (ast.For, ast.AsyncFor, ast.comprehension)):
            bound.update(_assigned_names(child.target))
        elif isinstance(child, ast.withitem):
            if child.optional_vars is not None:
                bound.update(_assigned_names(child.optional_vars))
        elif isinstance(child, ast.ExceptHandler):
            if child.name:
                bound.add(child.name)
        elif isinstance(child, DEFINITIONS):
            bound.add(child.name)
        elif isinstance(child, ast.Import):
            for alias in child.names:
                bound.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(child, ast.ImportFrom):
            for alias in child.names:
                if alias.name != "*":
                    bound.add(alias.asname or alias.name)
        elif isinstance(child, (ast.Global, ast.Nonlocal)):
            escaped.update(child.names)
    return bound - escaped


@dataclass
class CallSite:
    caller: str
    callee: str


def class_body_bindings(node: ast.ClassDef) -> set[str]:
    """Names a class body binds directly: valued assignments, methods and nested classes.

    A class body runs in its own namespace, so ``class C: helper = 2; made = helper()`` calls
    the attribute and never a module-level ``def helper``. An annotation with no value binds
    nothing, so it is left out. The set stops at the class body, because Python's lookup skips
    the class namespace inside a method.
    """
    bound: set[str] = set()

    def visit(body: list[ast.stmt]) -> None:
        for statement in body:
            if isinstance(statement, DEFINITIONS):
                bound.add(statement.name)
            elif isinstance(statement, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                if isinstance(statement, ast.AnnAssign) and statement.value is None:
                    continue
                targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                for target in targets:
                    bound.update(_assigned_names(target))
            elif isinstance(statement, COMPOUND):
                for block in _body_of(statement):
                    visit(block)

    visit(node.body)
    return bound


def collect_calls(
    body: list[ast.stmt],
    owner: str,
    scope: frozenset[str] | None,
    out: list[CallSite],
    inside_function: bool = False,
    class_scope: frozenset[str] | None = None,
) -> None:
    """Call sites of one block, with the caller attributed to the nearest *named* definition.

    A ``def`` or ``class`` written inside a function body is a local, not a symbol any map
    holds, so the calls in it belong to the definition that contains it - the same rule the
    Go oracle applies to a func literal. ``inside_function`` is what carries that: once a
    function body is entered, no further definition renames the caller.

    ``scope`` and ``class_scope`` are the two namespaces a callee can be shadowed by, and only
    one is ever consulted, because Python consults only one: entering a function replaces the
    class namespace outright rather than nesting inside it.
    """
    for statement in body:
        if isinstance(statement, DEFINITIONS):
            for decorator in statement.decorator_list:
                _expression_calls(decorator, owner, scope, out, class_scope)
            name = owner if inside_function else (statement.name if owner == "" else f"{owner}.{statement.name}")
            if isinstance(statement, ast.ClassDef):
                # A base list or a metaclass argument is written inside the class statement,
                # so its calls belong to the class - and they are evaluated *before* the class
                # body runs, so they see the enclosing scope, not the class namespace.
                for base in [*statement.bases, *statement.keywords]:
                    _expression_calls(base, name, scope, out, class_scope)
                inner_class = class_scope if scope is not None else frozenset(class_body_bindings(statement))
                collect_calls(statement.body, name, scope, out, inside_function, inner_class)
                continue
            # The outermost function scope owns the bindings of everything nested in it.
            inner = scope if scope is not None else frozenset(function_bindings(statement))
            # Defaults and annotations are written inside the `def`, so they belong to it -
            # and a method body never sees the class namespace it was written in.
            _expression_calls(statement.args, name, inner, out, None)
            if statement.returns is not None:
                _expression_calls(statement.returns, name, inner, out, None)
            collect_calls(statement.body, name, inner, out, True, None)
            continue
        if isinstance(statement, COMPOUND):
            for node in ast.iter_child_nodes(statement):
                if not isinstance(node, ast.stmt):
                    _expression_calls(node, owner, scope, out, class_scope)
            for handler in getattr(statement, "handlers", []) or []:
                if handler.type is not None:
                    _expression_calls(handler.type, owner, scope, out, class_scope)
            for block in _body_of(statement):
                collect_calls(block, owner, scope, out, inside_function, class_scope)
            continue
        _expression_calls(statement, owner, scope, out, class_scope)


def _expression_calls(
    node: ast.AST,
    owner: str,
    scope: frozenset[str] | None,
    out: list[CallSite],
    class_scope: frozenset[str] | None = None,
) -> None:
    # A function scope replaces the class namespace rather than nesting inside it, so at most
    # one of the two is ever in force.
    shadowing = scope if scope is not None else class_scope
    for child in ast.walk(node):
        if not isinstance(child, ast.Call):
            continue
        callee = callee_text(child.func)
        if callee is None:
            continue
        head = callee.split(".", 1)[0]
        if shadowing is not None and head != "self" and head in shadowing:
            continue  # a local or class-body binding, not the module's definition
        out.append(CallSite(owner, callee))


def callee_text(func: ast.expr) -> str | None:
    """``f`` / ``obj.m`` / ``self.m``; a deeper chain or a computed callee is not recorded."""
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        return f"{func.value.id}.{func.attr}"
    return None


# ---------------------------------------------------------------------------
# cross-module resolution
# ---------------------------------------------------------------------------


def literal_specifier(node: ast.Call) -> str | None:
    """The module a literal ``import_module("x")`` names, or None when it names none.

    ``importlib.import_module`` is the only dynamic-import *spelling* Python has, and a
    string constant is the only argument a static reader can follow. Both spellings count -
    ``importlib.import_module("x")`` and a bare ``import_module("x")`` after
    ``from importlib import import_module`` - and a computed argument records nothing, which
    is what the "never guess" rule requires.
    """
    func = node.func
    name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
    if name != "import_module" or not node.args:
        return None
    first = node.args[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        return first.value
    return None


def resolve_literal(table: ModuleTable, path: str, spec: str) -> str | None:
    """A written specifier - absolute, or relative with its dots - resolved to a file."""
    level = len(spec) - len(spec.lstrip("."))
    return resolve_specifier(table, path, spec[level:], level)


def resolve_specifier(table: ModuleTable, path: str, module: str, level: int) -> str | None:
    """A module reference (absolute or relative) resolved to a file in the list."""
    if level == 0:
        return table.resolve(module)
    package = table.package_of(path)
    parts = package.split(".") if package else []
    if len(parts) < level - 1:
        return None
    base = parts[: len(parts) - (level - 1)]
    dotted = ".".join([*base, module] if module else base)
    return table.resolve(dotted)


class Truth:
    """The whole run: parse every file, then resolve imports, exports and calls."""

    def __init__(self, root: str, files: list[str]) -> None:
        self.root = root
        self.errors: list[str] = []
        self.facts: dict[str, ModuleFacts] = {}
        self.calls_by_file: dict[str, list[CallSite]] = {}
        parsed: list[str] = []
        for path in sorted(files):
            absolute = os.path.join(root, path)
            try:
                with open(absolute, "rb") as handle:
                    source = handle.read()
            except OSError as error:
                self.errors.append(f"{path}: {error}")
                continue
            try:
                tree = ast.parse(source, filename=path, type_comments=True)
            except SyntaxError:
                # `type_comments=True` rejects a malformed type comment that plain parsing
                # accepts, so a second pass keeps a file the interpreter would run.
                try:
                    tree = ast.parse(source, filename=path)
                except (SyntaxError, ValueError) as error:
                    self.errors.append(f"{path}: {error}")
                    continue
            except ValueError as error:
                self.errors.append(f"{path}: {error}")
                continue
            facts = ModuleFacts(path=path, tree=tree)
            walk_scope(tree.body, "", facts)
            collect_all(tree.body, facts)
            collect_bindings(tree, facts)
            self.facts[path] = facts
            sites: list[CallSite] = []
            collect_calls(tree.body, "", None, sites)
            self.calls_by_file[path] = sites
            parsed.append(path)
        self.files = parsed
        self.table = ModuleTable(root, parsed)

    # -- imports ----------------------------------------------------------

    def imports(self) -> list[dict[str, str]]:
        edges: set[tuple[str, str]] = set()

        def add(path: str, target: str | None) -> None:
            # A file importing itself is not a dependency between files. A package's
            # ``__init__.py`` writing ``from pkg import sub`` - which pydantic does twice -
            # would otherwise put a self-loop in the import graph and add the file to its own
            # fan-in and blast radius.
            if target is not None and target != path:
                edges.add((path, target))

        for path, facts in self.facts.items():
            for node in ast.walk(facts.tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        add(path, self.table.resolve(alias.name))
                elif isinstance(node, ast.ImportFrom):
                    target = resolve_specifier(self.table, path, node.module or "", node.level)
                    if target is not None:
                        add(path, target)
                    else:
                        # A PEP 420 namespace package names no module file through its
                        # specifier: `from ns import mod`, with no `ns/__init__.py`, imports
                        # the submodule `ns.mod`, and only the imported symbol says so.
                        for alias in node.names:
                            if alias.name == "*":
                                continue
                            add(
                                path,
                                resolve_specifier(
                                    self.table,
                                    path,
                                    f"{node.module}.{alias.name}" if node.module else alias.name,
                                    node.level,
                                ),
                            )
                elif isinstance(node, ast.Call):
                    # A literal `importlib.import_module("x")` is a dynamic import, and it
                    # names a module as plainly as an `import` statement does.
                    spec = literal_specifier(node)
                    add(path, None if spec is None else resolve_literal(self.table, path, spec))
        return [{"from": a, "to": b} for a, b in sorted(edges)]

    # -- exports ----------------------------------------------------------

    def exports(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for path, facts in self.facts.items():
            if facts.all_names is not None:
                seen: list[str] = []
                for name in facts.all_names:
                    if name not in seen:
                        seen.append(name)
                out[path] = sorted(seen)
                continue
            out[path] = sorted(name for name in facts.defined if not name.startswith("_"))
        return out

    # -- calls ------------------------------------------------------------

    def _export_target(self, path: str, name: str) -> tuple[str, str] | None:
        """Where a module's exported name is declared: here, or one re-export hop away."""
        facts = self.facts.get(path)
        if facts is None:
            return None
        if name in facts.defined:
            return (path, name)
        binding = facts.bindings.get(name)
        if binding is None or facts.all_names is None or name not in facts.all_names:
            return None
        module, level, imported = binding
        if imported == "*":
            return None
        target = resolve_specifier(self.table, path, module, level)
        if target is None:
            return None
        other = self.facts.get(target)
        if other is None or imported not in other.defined:
            return None
        return (target, imported)

    def _name_in_module(self, path: str, name: str) -> tuple[str, str] | None:
        facts = self.facts.get(path)
        if facts is None:
            return None
        if name in facts.defined:
            return (path, name)
        return self._export_target(path, name)

    def _resolve_call(self, path: str, site: CallSite) -> str | None:
        facts = self.facts[path]
        callee = site.callee
        if "." not in callee:
            if callee in facts.defined:
                return f"{path}#{callee}"
            binding = facts.bindings.get(callee)
            if binding is None:
                return None
            module, level, imported = binding
            if imported == "*":
                return None
            target = resolve_specifier(self.table, path, module, level)
            if target is None:
                return None
            found = self._name_in_module(target, imported)
            return None if found is None else f"{found[0]}#{found[1]}"

        obj, _, member = callee.partition(".")
        if "." in member:
            return None
        if obj == "self":
            owner = site.caller.partition(".")[0]
            if owner == "":
                return None
            symbol = facts.symbol_id(f"{owner}.{member}")
            return None if symbol is None else f"{path}#{symbol}"
        if obj in facts.defined:
            symbol = facts.symbol_id(f"{obj}.{member}")
            return None if symbol is None else f"{path}#{symbol}"
        binding = facts.bindings.get(obj)
        if binding is None:
            return None
        module, level, imported = binding
        target = resolve_specifier(self.table, path, module, level)
        if target is None:
            return None
        if imported == "*":
            found = self._name_in_module(target, member)
            return None if found is None else f"{found[0]}#{found[1]}"
        found = self._name_in_module(target, imported)
        if found is None:
            return None
        other = self.facts.get(found[0])
        if other is None:
            return None
        symbol = other.symbol_id(f"{found[1]}.{member}")
        return None if symbol is None else f"{found[0]}#{symbol}"

    def calls(self) -> list[dict[str, str]]:
        edges: set[tuple[str, str]] = set()
        for path, sites in self.calls_by_file.items():
            for site in sites:
                target = self._resolve_call(path, site)
                if target is None:
                    continue
                source = path if site.caller == "" else f"{path}#{site.caller}"
                edges.add((source, target))
        return [{"from": a, "to": b} for a, b in sorted(edges)]

    # -- cycles -----------------------------------------------------------

    def cycles(self, imports: list[dict[str, str]]) -> list[list[str]]:
        """Tarjan strongly connected components of size > 1 over the import graph."""
        graph: dict[str, list[str]] = {path: [] for path in self.files}
        for edge in imports:
            if edge["from"] in graph and edge["to"] in graph:
                graph[edge["from"]].append(edge["to"])

        index_of: dict[str, int] = {}
        low: dict[str, int] = {}
        on_stack: set[str] = set()
        stack: list[str] = []
        counter = 0
        found: list[list[str]] = []

        for start in sorted(graph):
            if start in index_of:
                continue
            # An explicit stack: a deep import chain would otherwise hit the recursion limit.
            work: list[tuple[str, int]] = [(start, 0)]
            while work:
                node, child = work[-1]
                if child == 0:
                    index_of[node] = low[node] = counter
                    counter += 1
                    stack.append(node)
                    on_stack.add(node)
                neighbours = sorted(graph[node])
                if child < len(neighbours):
                    work[-1] = (node, child + 1)
                    neighbour = neighbours[child]
                    if neighbour not in index_of:
                        work.append((neighbour, 0))
                    elif neighbour in on_stack:
                        low[node] = min(low[node], index_of[neighbour])
                    continue
                work.pop()
                if work:
                    parent = work[-1][0]
                    low[parent] = min(low[parent], low[node])
                if low[node] == index_of[node]:
                    component: list[str] = []
                    while True:
                        member = stack.pop()
                        on_stack.discard(member)
                        component.append(member)
                        if member == node:
                            break
                    if len(component) > 1:
                        found.append(sorted(component))
        found.sort(key=lambda cycle: cycle[0])
        return found


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Python structural truth, ast only.")
    parser.add_argument("--root", required=True)
    parser.add_argument("--files", required=True, help="file holding repo-relative paths, one per line")
    args = parser.parse_args(argv)

    with open(args.files, encoding="utf-8") as handle:
        files = [line.strip() for line in handle if line.strip()]

    truth = Truth(os.path.abspath(args.root), files)
    imports = truth.imports()
    document = {
        "files": truth.files,
        "imports": imports,
        "exports": truth.exports(),
        "calls": truth.calls(),
        "cycles": truth.cycles(imports),
        "errors": truth.errors,
        "modules": len(truth.files),
        # The interpreter that produced these numbers, major.minor, so a published result
        # names the thing that measured it. A patch bump is not reported: it changes nothing
        # this program reads, and churning every result file for one would be noise.
        "python": "%d.%d" % sys.version_info[:2],
    }
    json.dump(document, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
