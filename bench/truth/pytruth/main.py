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


def walk_scope(body: list[ast.stmt], parent: str, facts: ModuleFacts) -> None:
    """Names a module body or a class body binds, descending through compound statements.

    Function bodies are *not* descended into: a ``def`` inside a ``def`` binds a local, not a
    module attribute.
    """
    for statement in body:
        if isinstance(statement, DEFINITIONS):
            name = statement.name if parent == "" else f"{parent}.{statement.name}"
            facts.symbols.add(name)
            if parent == "":
                facts.defined.setdefault(statement.name, "class" if isinstance(statement, ast.ClassDef) else "def")
            if isinstance(statement, ast.ClassDef):
                walk_scope(statement.body, name, facts)
            continue
        if isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            for target in targets:
                for name in _assigned_names(target):
                    if parent != "" or name == "__all__":
                        continue
                    facts.defined.setdefault(name, "value")
            continue
        if isinstance(statement, COMPOUND):
            for block in _body_of(statement):
                walk_scope(block, parent, facts)


def collect_all(body: list[ast.stmt], facts: ModuleFacts) -> None:
    """The module's ``__all__``, when it is a literal sequence of strings.

    A computed ``__all__`` leaves ``all_names`` None: a surface that cannot be read is not a
    surface to guess at, and the underscore convention takes over.
    """
    usable = False
    names: list[str] | None = None
    for statement in body:
        if isinstance(statement, COMPOUND):
            for block in _body_of(statement):
                collect_all(block, facts)
            continue
        target: ast.expr | None = None
        value: ast.expr | None = None
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
            target, value = statement.targets[0], statement.value
        elif isinstance(statement, ast.AugAssign):
            target, value = statement.target, statement.value
        if not isinstance(target, ast.Name) or target.id != "__all__" or value is None:
            continue
        usable = True
        listed = _literal_sequence(value)
        if listed is None:
            facts.all_names = None
            facts.__dict__["_all_unusable"] = True
            return
        if names is None or isinstance(statement, ast.Assign):
            names = list(listed)
        else:
            names.extend(n for n in listed if n not in names)
    if usable and not facts.__dict__.get("_all_unusable") and names is not None:
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


def collect_calls(
    body: list[ast.stmt],
    owner: str,
    scope: frozenset[str] | None,
    out: list[CallSite],
    inside_function: bool = False,
) -> None:
    """Call sites of one block, with the caller attributed to the nearest *named* definition.

    A ``def`` or ``class`` written inside a function body is a local, not a symbol any map
    holds, so the calls in it belong to the definition that contains it - the same rule the
    Go oracle applies to a func literal. ``inside_function`` is what carries that: once a
    function body is entered, no further definition renames the caller.
    """
    for statement in body:
        if isinstance(statement, DEFINITIONS):
            for decorator in statement.decorator_list:
                _expression_calls(decorator, owner, scope, out)
            name = owner if inside_function else (statement.name if owner == "" else f"{owner}.{statement.name}")
            if isinstance(statement, ast.ClassDef):
                # A base list or a metaclass argument is written inside the class statement,
                # so its calls belong to the class.
                for base in [*statement.bases, *statement.keywords]:
                    _expression_calls(base, name, scope, out)
                collect_calls(statement.body, name, scope, out, inside_function)
                continue
            # The outermost function scope owns the bindings of everything nested in it.
            inner = scope if scope is not None else frozenset(function_bindings(statement))
            # Defaults and annotations are written inside the `def`, so they belong to it.
            _expression_calls(statement.args, name, inner, out)
            if statement.returns is not None:
                _expression_calls(statement.returns, name, inner, out)
            collect_calls(statement.body, name, inner, out, True)
            continue
        if isinstance(statement, COMPOUND):
            for node in ast.iter_child_nodes(statement):
                if not isinstance(node, ast.stmt):
                    _expression_calls(node, owner, scope, out)
            for handler in getattr(statement, "handlers", []) or []:
                if handler.type is not None:
                    _expression_calls(handler.type, owner, scope, out)
            for block in _body_of(statement):
                collect_calls(block, owner, scope, out, inside_function)
            continue
        _expression_calls(statement, owner, scope, out)


def _expression_calls(node: ast.AST, owner: str, scope: frozenset[str] | None, out: list[CallSite]) -> None:
    for child in ast.walk(node):
        if not isinstance(child, ast.Call):
            continue
        callee = callee_text(child.func)
        if callee is None:
            continue
        head = callee.split(".", 1)[0]
        if scope is not None and head != "self" and head in scope:
            continue  # a local binding, not the module's definition
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
        for path, facts in self.facts.items():
            for node in ast.walk(facts.tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        target = self.table.resolve(alias.name)
                        if target is not None:
                            edges.add((path, target))
                elif isinstance(node, ast.ImportFrom):
                    target = resolve_specifier(self.table, path, node.module or "", node.level)
                    if target is not None:
                        edges.add((path, target))
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
            symbol = f"{owner}.{member}"
            return f"{path}#{symbol}" if symbol in facts.symbols else None
        if obj in facts.defined:
            symbol = f"{obj}.{member}"
            return f"{path}#{symbol}" if symbol in facts.symbols else None
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
        symbol = f"{found[1]}.{member}"
        return f"{found[0]}#{symbol}" if other is not None and symbol in other.symbols else None

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
    }
    json.dump(document, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
