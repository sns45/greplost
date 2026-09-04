//! rusttruth — an independent Rust structure oracle for the greplost benchmark.
//!
//! greplost's structure layer is never scored against itself (tech spec 10.1, principle 2), so
//! nothing here shares a line of code with `packages/core`: the item tree comes from `syn`, the
//! crate roots come from `cargo metadata --no-deps`, and every rule of spec 1.3 is implemented
//! again from the specification text rather than ported.
//!
//! It prints one JSON document on stdout, in greplost's own id vocabulary:
//!
//!   files    the `.rs` files it parsed, repo-relative with forward slashes;
//!   imports  one `{from,to}` per (importing file, imported file), from `mod` items and `use`
//!            trees resolved through the module tree;
//!   exports  file -> the names the file makes public, `pub use` globs followed transitively;
//!   calls    `{from,to}` between symbol ids, by spec 1.3's call rules;
//!   cycles   Tarjan SCCs of size > 1 over the import graph;
//!   errors   files `syn` could not parse, and any cargo trouble;
//!   crates   how many packages `cargo metadata` reported: the integrity guard, because an
//!            empty truth set would score an empty prediction as a perfect 1.000.
//!
//! Identity, restated: a file is its repo-relative path; a symbol is `<file>#<path>`, where the
//! path uses `::` for inline-module nesting and `.` for membership of a type
//! (`tests::Store.put`). Nothing here is a guess: an ambiguous name is omitted from truth,
//! exactly as the extractor omits it, and a method on a generic or `dyn` receiver is dropped.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use syn::visit::Visit;

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Edge {
    from: String,
    to: String,
}

#[derive(Serialize, Default)]
struct Output {
    files: Vec<String>,
    imports: Vec<Edge>,
    exports: BTreeMap<String, Vec<String>>,
    calls: Vec<Edge>,
    cycles: Vec<Vec<String>>,
    errors: Vec<String>,
    crates: usize,
}

// ---------------------------------------------------------------------------
// per-file facts
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ImportRec {
    specifier: String,
    /// `(name in the target, local binding)`; empty for a `mod` item or `extern crate`.
    symbols: Vec<(String, String)>,
    reexport: bool,
}

#[derive(Clone)]
enum ExportRec {
    /// A `pub` item declared here, or a `pub use` of one name. Only the name is scored: S2
    /// compares `<file>#<name>` keys, so where the name came from does not enter the metric.
    Named { name: String },
    /// `pub use <module>::*`, followed transitively once the module resolves.
    Star { from: String },
}

struct CallSite {
    caller: String,
    callee: String,
}

#[derive(Default)]
struct FileFacts {
    imports: Vec<ImportRec>,
    exports: Vec<ExportRec>,
    /// Top-level symbol name -> declaration kind.
    items: BTreeMap<String, String>,
    /// Every `<Type>.<member>` symbol path this file declares.
    members: BTreeSet<String>,
    calls: Vec<CallSite>,
    /// Symbol paths already taken in this file, so a duplicate can take a `~<n>` suffix.
    used: HashSet<String>,
    /// Member names two declarations both wanted: ambiguous, so they resolve to nothing.
    ambiguous: BTreeSet<String>,
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

fn parent_dir(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[..index],
        None => "",
    }
}

fn join(dir: &str, rest: &str) -> String {
    if dir.is_empty() {
        rest.to_string()
    } else if rest.is_empty() {
        dir.to_string()
    } else {
        format!("{dir}/{rest}")
    }
}

/// `a/b/c.rs` under `a` -> `b/c.rs`; `None` when `path` is not under `dir`.
fn relative_to(dir: &str, path: &str) -> Option<String> {
    if dir.is_empty() {
        return Some(path.to_string());
    }
    if path == dir {
        return Some(String::new());
    }
    path.strip_prefix(&format!("{dir}/")).map(str::to_string)
}

fn repo_relative(root: &Path, path: &Path) -> Option<String> {
    let stripped = path.strip_prefix(root).ok()?;
    let text = stripped.to_string_lossy().replace('\\', "/");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Every `.rs` file under `root`, repo-relative and sorted.
fn discover(root: &Path) -> Vec<String> {
    const SKIP: [&str; 5] = ["target", ".git", "node_modules", ".greplost", ".cargo"];
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if SKIP.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
            } else if name.ends_with(".rs") {
                if let Some(rel) = repo_relative(root, &path) {
                    out.push(rel);
                }
            }
        }
    }
    out.sort();
    out
}

// ---------------------------------------------------------------------------
// the crate index
// ---------------------------------------------------------------------------

struct Crate {
    /// Crate-root files that exist on disk, sorted; the first is the crate's primary root.
    roots: Vec<String>,
}

struct Crates {
    /// Crate directories, longest first, so the nearest manifest wins.
    dirs: Vec<String>,
    by_dir: HashMap<String, Crate>,
    by_name: HashMap<String, String>,
    count: usize,
}

fn load_crates(root: &Path, files: &BTreeSet<String>, errors: &mut Vec<String>) -> Crates {
    let manifest = root.join("Cargo.toml");
    let mut metadata = None;
    for offline in [true, false] {
        let mut command = cargo_metadata::MetadataCommand::new();
        command.manifest_path(&manifest).no_deps();
        if offline {
            command.other_options(vec!["--offline".to_string()]);
        }
        match command.exec() {
            Ok(value) => {
                metadata = Some(value);
                break;
            }
            Err(err) => {
                if !offline {
                    errors.push(format!("cargo metadata failed: {err}"));
                }
            }
        }
    }

    let mut by_dir: HashMap<String, Crate> = HashMap::new();
    let mut by_name: HashMap<String, String> = HashMap::new();
    let mut count = 0usize;

    if let Some(metadata) = metadata {
        for package in metadata.packages.iter() {
            count += 1;
            let manifest_path = PathBuf::from(package.manifest_path.as_std_path());
            let dir = manifest_path
                .parent()
                .and_then(|parent| repo_relative(root, parent))
                .unwrap_or_default();
            let mut roots: Vec<String> = Vec::new();
            for target in package.targets.iter() {
                let src = PathBuf::from(target.src_path.as_std_path());
                if let Some(rel) = repo_relative(root, &src) {
                    if files.contains(&rel) {
                        roots.push(rel);
                    }
                }
            }
            roots.sort();
            roots.dedup();
            let name = package.name.to_string().replace('-', "_");
            if !name.is_empty() {
                if let Some(first) = roots.first() {
                    by_name.entry(name.clone()).or_insert_with(|| first.clone());
                }
            }
            by_dir.insert(dir, Crate { roots });
        }
    }

    let mut dirs: Vec<String> = by_dir.keys().cloned().collect();
    dirs.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    Crates {
        dirs,
        by_dir,
        by_name,
        count,
    }
}

struct Tree<'a> {
    files: &'a BTreeSet<String>,
    crates: &'a Crates,
    /// file -> the crate root it belongs to.
    root_of: HashMap<String, String>,
}

impl<'a> Tree<'a> {
    fn new(files: &'a BTreeSet<String>, crates: &'a Crates) -> Self {
        let mut root_of = HashMap::new();
        for file in files.iter() {
            if let Some(root) = Self::compute_root(file, crates) {
                root_of.insert(file.clone(), root);
            }
        }
        Tree {
            files,
            crates,
            root_of,
        }
    }

    fn compute_root(file: &str, crates: &Crates) -> Option<String> {
        let mut owner: Option<&Crate> = None;
        for dir in crates.dirs.iter() {
            if relative_to(dir, file).is_some() {
                owner = crates.by_dir.get(dir);
                break;
            }
        }
        let owner = owner?;
        let mut best: Option<&String> = None;
        let mut best_length: isize = -1;
        for candidate in owner.roots.iter() {
            if candidate == file {
                return Some(candidate.clone());
            }
            let dir = parent_dir(candidate);
            if relative_to(dir, file).is_none() {
                continue;
            }
            if dir.len() as isize > best_length {
                best = Some(candidate);
                best_length = dir.len() as isize;
            }
        }
        best.or_else(|| owner.roots.first()).cloned()
    }

    fn root_for(&self, file: &str) -> Option<&String> {
        self.root_of.get(file)
    }

    /// `src/a/b.rs` under root `src/lib.rs` -> `["a","b"]`; the root itself -> `[]`.
    fn module_path(&self, file: &str, root: &str) -> Vec<String> {
        if file == root {
            return Vec::new();
        }
        let rest = match relative_to(parent_dir(root), file) {
            Some(rest) => rest,
            None => return Vec::new(),
        };
        let stem = rest.strip_suffix(".rs").unwrap_or(&rest);
        let mut segments: Vec<String> = stem.split('/').map(str::to_string).collect();
        if segments.last().map(String::as_str) == Some("mod") {
            segments.pop();
        }
        segments
    }

    /// The file a module path names, walking from a crate root.
    fn module_file(&self, root: &str, segments: &[String]) -> Option<String> {
        if segments.is_empty() {
            return Some(root.to_string());
        }
        let base = join(parent_dir(root), &segments.join("/"));
        let direct = format!("{base}.rs");
        if self.files.contains(&direct) {
            return Some(direct);
        }
        let nested = format!("{base}/mod.rs");
        if self.files.contains(&nested) {
            return Some(nested);
        }
        None
    }

    /// Walk a path as far as the module tree goes; its tail names an item, not a module.
    fn walk_down(&self, root: &str, segments: &[String]) -> Option<String> {
        for length in (0..=segments.len()).rev() {
            if let Some(hit) = self.module_file(root, &segments[..length]) {
                return Some(hit);
            }
        }
        None
    }

    /// One `use`/`mod` specifier resolved to a repo file, or `None` for anything external.
    fn resolve(&self, from_file: &str, specifier: &str) -> Option<String> {
        if specifier.is_empty() {
            return None;
        }
        let segments: Vec<String> = specifier
            .split("::")
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let head = segments.first()?.clone();
        let root = self.root_for(from_file)?.clone();

        if head == "crate" {
            return self.walk_down(&root, &segments[1..]);
        }
        if head == "self" || head == "super" {
            let mut up = 0usize;
            while segments.get(up).map(String::as_str) == Some("super") {
                up += 1;
            }
            let base = self.module_path(from_file, &root);
            if up > base.len() {
                return None;
            }
            let start = if head == "self" { 1 } else { up };
            let prefix: Vec<String> = if head == "self" {
                base
            } else {
                base[..base.len() - up].to_vec()
            };
            let mut path = prefix;
            path.extend_from_slice(&segments[start..]);
            return self.walk_down(&root, &path);
        }
        if let Some(target) = self.crates.by_name.get(&head) {
            return self.walk_down(target, &segments[1..]);
        }
        // A uniform path (Rust 2018): `use store::Store` names a module of the file's own module.
        let base = self.module_path(from_file, &root);
        let mut probe = base.clone();
        probe.push(head);
        if self.module_file(&root, &probe).is_some() {
            let mut path = base;
            path.extend_from_slice(&segments);
            return self.walk_down(&root, &path);
        }
        None
    }
}

// ---------------------------------------------------------------------------
// the item walk
// ---------------------------------------------------------------------------

fn is_pub(vis: &syn::Visibility) -> bool {
    !matches!(vis, syn::Visibility::Inherited)
}

/// The declared name behind a type expression: `&Store`, `Store<T>` and `&mut fmt::Display` all
/// give `Store` / `Display`. A trait object, an `impl Trait`, a tuple and a primitive give none.
fn base_type_name(ty: &syn::Type) -> Option<String> {
    match ty {
        syn::Type::Path(path) => {
            if path.qself.is_some() {
                return None;
            }
            path.path.segments.last().map(|s| s.ident.to_string())
        }
        syn::Type::Reference(inner) => base_type_name(&inner.elem),
        syn::Type::Ptr(inner) => base_type_name(&inner.elem),
        syn::Type::Paren(inner) => base_type_name(&inner.elem),
        syn::Type::Group(inner) => base_type_name(&inner.elem),
        _ => None,
    }
}

fn normalise_type(name: Option<String>, self_ty: Option<&str>, generics: &HashSet<String>) -> Option<String> {
    let name = name?;
    if name == "Self" {
        return self_ty.map(str::to_string);
    }
    if generics.contains(&name) {
        return None;
    }
    Some(name)
}

fn generic_names(generics: &syn::Generics) -> Vec<String> {
    generics
        .params
        .iter()
        .filter_map(|param| match param {
            syn::GenericParam::Type(t) => Some(t.ident.to_string()),
            syn::GenericParam::Const(c) => Some(c.ident.to_string()),
            syn::GenericParam::Lifetime(_) => None,
        })
        .collect()
}

/// One leaf of a use tree: the path as written, the name it binds, the local binding.
struct UseLeaf {
    path: Vec<String>,
    name: String,
    local: String,
}

fn use_leaves(tree: &syn::UseTree, prefix: &[String], out: &mut Vec<UseLeaf>) {
    match tree {
        syn::UseTree::Path(node) => {
            let mut next = prefix.to_vec();
            next.push(node.ident.to_string());
            use_leaves(&node.tree, &next, out);
        }
        syn::UseTree::Group(node) => {
            for item in node.items.iter() {
                use_leaves(item, prefix, out);
            }
        }
        syn::UseTree::Name(node) => {
            let ident = node.ident.to_string();
            if ident == "self" {
                // `use a::{self, b}`: the module itself, bound under its own last segment.
                if let Some(last) = prefix.last() {
                    out.push(UseLeaf {
                        path: prefix.to_vec(),
                        name: last.clone(),
                        local: last.clone(),
                    });
                }
                return;
            }
            let mut path = prefix.to_vec();
            path.push(ident.clone());
            out.push(UseLeaf {
                path,
                name: ident.clone(),
                local: ident,
            });
        }
        syn::UseTree::Rename(node) => {
            let ident = node.ident.to_string();
            let alias = node.rename.to_string();
            if ident == "self" {
                if let Some(last) = prefix.last() {
                    out.push(UseLeaf {
                        path: prefix.to_vec(),
                        name: last.clone(),
                        local: alias,
                    });
                }
                return;
            }
            let mut path = prefix.to_vec();
            path.push(ident.clone());
            out.push(UseLeaf {
                path,
                name: ident,
                local: alias,
            });
        }
        syn::UseTree::Glob(_) => {
            out.push(UseLeaf {
                path: prefix.to_vec(),
                name: "*".to_string(),
                local: "*".to_string(),
            });
        }
    }
}

/// Rewrite a use path so it reads from the file's own module rather than from the inline module
/// it was written in: the resolver is handed a file, not a position inside one.
fn rebase(path: &[String], mods: &[String]) -> Vec<String> {
    let head = match path.first() {
        Some(head) => head.as_str(),
        None => return path.to_vec(),
    };
    if head == "self" {
        let mut out = vec!["self".to_string()];
        out.extend_from_slice(mods);
        out.extend_from_slice(&path[1..]);
        return out;
    }
    if head == "super" {
        let mut up = 0usize;
        while path.get(up).map(String::as_str) == Some("super") {
            up += 1;
        }
        let rest = &path[up..];
        let climbed = up.min(mods.len());
        let remaining = up - climbed;
        if remaining > 0 {
            let mut out = vec!["super".to_string(); remaining];
            out.extend_from_slice(rest);
            return out;
        }
        let mut out = vec!["self".to_string()];
        out.extend_from_slice(&mods[..mods.len() - climbed]);
        out.extend_from_slice(rest);
        return out;
    }
    if mods.is_empty() || head == "crate" {
        return path.to_vec();
    }
    let mut out = vec!["self".to_string()];
    out.extend_from_slice(mods);
    out.extend_from_slice(path);
    out
}

/// The context an item is written in.
#[derive(Clone)]
struct Scope {
    /// Symbol-path prefix for a child declaration, empty at file level.
    prefix: String,
    /// True at file level: only a top-level `pub` item is an export of the file.
    top: bool,
    /// Inline `mod` segments between the file and here.
    mods: Vec<String>,
    /// True inside an `impl` or `trait` body: a function there is a method.
    type_body: bool,
    /// The enclosing `impl`'s type, for `Self::m()`.
    self_ty: Option<String>,
    generics: HashSet<String>,
}

fn walk_items(items: &[syn::Item], scope: &Scope, facts: &mut FileFacts) {
    for item in items.iter() {
        walk_item(item, scope, facts);
    }
}

/// The symbol path a declaration's **id** takes: `Store`, then `Store~2`, then `Store~3`.
///
/// Rust declares one name twice in one file constantly - `pub struct Store;` with
/// `impl Store { … }`, two trait impls each declaring `go`, two `#[cfg]`-gated
/// `pub fn normalize_path`s. Left alone they share one id and the member set collapses to
/// whichever came first. The suffix lands on the **id** only: the exported name stays the name
/// as written, because `normalize_path~2` is a name nobody can import. `~` cannot occur in a
/// Rust identifier, so a suffixed id can never collide with one somebody wrote. The extractor
/// applies the identical rule, which is what keeps exports and call ids comparable.
fn unique_name(used: &mut HashSet<String>, name: &str) -> String {
    if used.insert(name.to_string()) {
        return name.to_string();
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{name}~{n}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

/// Record one declaration, and answer with the id path it took (the caller id of its body).
fn declare_item(facts: &mut FileFacts, scope: &Scope, name: &str, kind: &str, vis: &syn::Visibility) -> String {
    let unique = unique_name(&mut facts.used, name);
    if scope.top {
        facts.items.entry(name.to_string()).or_insert_with(|| kind.to_string());
        if is_pub(vis) {
            facts.exports.push(ExportRec::Named { name: name.to_string() });
        }
    } else if name.contains('.') {
        // A member name two declarations both want resolves to nothing at all, never to
        // whichever came first.
        if !facts.members.insert(name.to_string()) {
            facts.ambiguous.insert(name.to_string());
        }
    }
    unique
}

fn walk_item(item: &syn::Item, scope: &Scope, facts: &mut FileFacts) {
    match item {
        syn::Item::Use(node) => {
            let mut leaves = Vec::new();
            use_leaves(&node.tree, &[], &mut leaves);
            let reexport = is_pub(&node.vis);
            for leaf in leaves {
                let path = rebase(&leaf.path, &scope.mods);
                let specifier = path.join("::");
                if specifier.is_empty() {
                    continue;
                }
                facts.imports.push(ImportRec {
                    specifier: specifier.clone(),
                    symbols: vec![(leaf.name.clone(), leaf.local.clone())],
                    reexport,
                });
                if !reexport || !scope.mods.is_empty() {
                    continue;
                }
                if leaf.name == "*" {
                    facts.exports.push(ExportRec::Star { from: specifier });
                } else {
                    facts.exports.push(ExportRec::Named { name: leaf.local.clone() });
                }
            }
        }
        syn::Item::ExternCrate(node) => {
            facts.imports.push(ImportRec {
                specifier: node.ident.to_string(),
                symbols: Vec::new(),
                reexport: false,
            });
        }
        syn::Item::Mod(node) => {
            let name = node.ident.to_string();
            let full = format!("{}{}", scope.prefix, name);
            declare_item(facts, scope, &full, "module", &node.vis);
            match &node.content {
                None => {
                    let mut path = vec!["self".to_string()];
                    path.extend_from_slice(&scope.mods);
                    path.push(name);
                    facts.imports.push(ImportRec {
                        specifier: path.join("::"),
                        symbols: Vec::new(),
                        reexport: false,
                    });
                }
                Some((_, items)) => {
                    let mut mods = scope.mods.clone();
                    mods.push(name);
                    let inner = Scope {
                        prefix: format!("{full}::"),
                        top: false,
                        mods,
                        type_body: false,
                        self_ty: scope.self_ty.clone(),
                        generics: scope.generics.clone(),
                    };
                    walk_items(items, &inner, facts);
                }
            }
        }
        syn::Item::Impl(node) => {
            let type_name = match base_type_name(&node.self_ty) {
                Some(name) => name,
                None => return,
            };
            let trait_name = node
                .trait_
                .as_ref()
                .and_then(|(_, path, _)| path.segments.last().map(|s| s.ident.to_string()));
            let display = match &trait_name {
                Some(trait_name) => format!("{trait_name} for {type_name}"),
                None => type_name.clone(),
            };
            let full = format!("{}{}", scope.prefix, display);
            declare_item(facts, scope, &full, "impl", &syn::Visibility::Inherited);
            let owner = format!("{}{}", scope.prefix, type_name);
            let mut generics = scope.generics.clone();
            generics.extend(generic_names(&node.generics));
            let inner = Scope {
                prefix: format!("{owner}."),
                top: false,
                mods: scope.mods.clone(),
                type_body: true,
                self_ty: Some(type_name),
                generics,
            };
            for member in node.items.iter() {
                match member {
                    syn::ImplItem::Fn(f) => {
                        let name = format!("{}{}", inner.prefix, f.sig.ident);
                        let unique = declare_item(facts, &inner, &name, "method", &f.vis);
                        collect_calls(&unique, &inner, Some(&f.sig), Some(&f.block), facts);
                    }
                    syn::ImplItem::Const(c) => {
                        let name = format!("{}{}", inner.prefix, c.ident);
                        declare_item(facts, &inner, &name, "const", &c.vis);
                        collect_expr_calls("", &inner, &c.expr, facts);
                    }
                    syn::ImplItem::Type(t) => {
                        let name = format!("{}{}", inner.prefix, t.ident);
                        declare_item(facts, &inner, &name, "type", &t.vis);
                    }
                    _ => {}
                }
            }
        }
        syn::Item::Trait(node) => {
            let name = node.ident.to_string();
            let full = format!("{}{}", scope.prefix, name);
            declare_item(facts, scope, &full, "trait", &node.vis);
            let mut generics = scope.generics.clone();
            generics.extend(generic_names(&node.generics));
            // `Self` inside a trait is the implementing type, which this file does not know.
            let inner = Scope {
                prefix: format!("{full}."),
                top: false,
                mods: scope.mods.clone(),
                type_body: true,
                self_ty: None,
                generics,
            };
            for member in node.items.iter() {
                match member {
                    syn::TraitItem::Fn(f) => {
                        let name = format!("{}{}", inner.prefix, f.sig.ident);
                        let unique = declare_item(facts, &inner, &name, "method", &syn::Visibility::Inherited);
                        collect_calls(&unique, &inner, Some(&f.sig), f.default.as_ref(), facts);
                    }
                    syn::TraitItem::Const(c) => {
                        let name = format!("{}{}", inner.prefix, c.ident);
                        declare_item(facts, &inner, &name, "const", &syn::Visibility::Inherited);
                    }
                    _ => {}
                }
            }
        }
        syn::Item::Fn(node) => {
            let full = format!("{}{}", scope.prefix, node.sig.ident);
            let kind = if scope.type_body { "method" } else { "function" };
            let unique = declare_item(facts, scope, &full, kind, &node.vis);
            collect_calls(&unique, scope, Some(&node.sig), Some(&node.block), facts);
        }
        syn::Item::Struct(node) => {
            let full = format!("{}{}", scope.prefix, node.ident);
            declare_item(facts, scope, &full, "struct", &node.vis);
        }
        syn::Item::Union(node) => {
            let full = format!("{}{}", scope.prefix, node.ident);
            declare_item(facts, scope, &full, "struct", &node.vis);
        }
        syn::Item::Enum(node) => {
            let full = format!("{}{}", scope.prefix, node.ident);
            declare_item(facts, scope, &full, "enum", &node.vis);
        }
        syn::Item::Type(node) => {
            let full = format!("{}{}", scope.prefix, node.ident);
            declare_item(facts, scope, &full, "type", &node.vis);
        }
        syn::Item::Const(node) => {
            let full = format!("{}{}", scope.prefix, node.ident);
            declare_item(facts, scope, &full, "const", &node.vis);
            collect_expr_calls("", scope, &node.expr, facts);
        }
        syn::Item::Static(node) => {
            let full = format!("{}{}", scope.prefix, node.ident);
            declare_item(facts, scope, &full, "var", &node.vis);
            collect_expr_calls("", scope, &node.expr, facts);
        }
        syn::Item::Macro(node) => {
            // Only `macro_rules! name { … }` declares an item; a bare invocation does not.
            if let Some(ident) = node.ident.as_ref() {
                let full = format!("{}{}", scope.prefix, ident);
                declare_item(facts, scope, &full, "function", &syn::Visibility::Inherited);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

/// Receiver types in force inside one function; `None` means "bound, but not typed".
type Receivers = HashMap<String, Option<String>>;

fn bind(types: &mut Receivers, name: String, value: Option<String>) {
    match types.get(&name) {
        None => {
            types.insert(name, value);
        }
        // A name bound twice in one function is a shadow: over-dropping costs recall,
        // under-dropping emits a wrong edge.
        Some(existing) if *existing != value => {
            types.insert(name, None);
        }
        Some(_) => {}
    }
}

fn pattern_names(pat: &syn::Pat, out: &mut Vec<String>) {
    match pat {
        syn::Pat::Ident(node) => {
            out.push(node.ident.to_string());
            if let Some((_, sub)) = node.subpat.as_ref() {
                pattern_names(sub, out);
            }
        }
        syn::Pat::Type(node) => pattern_names(&node.pat, out),
        syn::Pat::Reference(node) => pattern_names(&node.pat, out),
        syn::Pat::Or(node) => {
            for case in node.cases.iter() {
                pattern_names(case, out);
            }
        }
        syn::Pat::Paren(node) => pattern_names(&node.pat, out),
        syn::Pat::Slice(node) => {
            for elem in node.elems.iter() {
                pattern_names(elem, out);
            }
        }
        syn::Pat::Struct(node) => {
            for field in node.fields.iter() {
                pattern_names(&field.pat, out);
            }
        }
        syn::Pat::Tuple(node) => {
            for elem in node.elems.iter() {
                pattern_names(elem, out);
            }
        }
        syn::Pat::TupleStruct(node) => {
            for elem in node.elems.iter() {
                pattern_names(elem, out);
            }
        }
        _ => {}
    }
}

/// The type a `let` value pins, when the syntax alone settles it.
fn type_of_value(expr: &syn::Expr, self_ty: Option<&str>, generics: &HashSet<String>) -> Option<String> {
    match expr {
        syn::Expr::Struct(node) => {
            let name = node.path.segments.last().map(|s| s.ident.to_string());
            normalise_type(name, self_ty, generics)
        }
        syn::Expr::Call(node) => {
            let path = match &*node.func {
                syn::Expr::Path(path) => path,
                _ => return None,
            };
            if path.qself.is_some() || path.path.leading_colon.is_some() || path.path.segments.len() != 2 {
                return None;
            }
            let head = path.path.segments[0].ident.to_string();
            normalise_type(Some(head), self_ty, generics)
        }
        _ => None,
    }
}

struct BinderCollector<'a> {
    types: Receivers,
    /// Names of the `fn`s written inside this function's body, at any depth.
    nested: HashSet<String>,
    self_ty: Option<String>,
    generics: &'a HashSet<String>,
}

impl<'a> BinderCollector<'a> {
    fn unknown(&mut self, pat: &syn::Pat) {
        let mut names = Vec::new();
        pattern_names(pat, &mut names);
        for name in names {
            bind(&mut self.types, name, None);
        }
    }

    /// One typed parameter, from a signature at any depth inside the function.
    fn parameter(&mut self, input: &syn::FnArg) {
        let typed = match input {
            syn::FnArg::Typed(typed) => typed,
            syn::FnArg::Receiver(_) => return,
        };
        match &*typed.pat {
            syn::Pat::Ident(ident) if ident.subpat.is_none() => {
                let self_ty = self.self_ty.clone();
                let value = normalise_type(base_type_name(&typed.ty), self_ty.as_deref(), self.generics);
                bind(&mut self.types, ident.ident.to_string(), value);
            }
            other => self.unknown(other),
        }
    }
}

impl<'ast, 'a> Visit<'ast> for BinderCollector<'a> {
    fn visit_local(&mut self, node: &'ast syn::Local) {
        let self_ty = self.self_ty.clone();
        match &node.pat {
            syn::Pat::Type(typed) => match &*typed.pat {
                syn::Pat::Ident(ident) if ident.subpat.is_none() => {
                    let value = normalise_type(base_type_name(&typed.ty), self_ty.as_deref(), self.generics);
                    bind(&mut self.types, ident.ident.to_string(), value);
                }
                other => self.unknown(other),
            },
            syn::Pat::Ident(ident) if ident.subpat.is_none() => {
                let value = node
                    .init
                    .as_ref()
                    .and_then(|init| type_of_value(&init.expr, self_ty.as_deref(), self.generics));
                bind(&mut self.types, ident.ident.to_string(), value);
            }
            other => self.unknown(other),
        }
        syn::visit::visit_local(self, node);
    }

    fn visit_expr_closure(&mut self, node: &'ast syn::ExprClosure) {
        for input in node.inputs.iter() {
            self.unknown(input);
        }
        syn::visit::visit_expr_closure(self, node);
    }

    fn visit_expr_for_loop(&mut self, node: &'ast syn::ExprForLoop) {
        self.unknown(&node.pat);
        syn::visit::visit_expr_for_loop(self, node);
    }

    fn visit_arm(&mut self, node: &'ast syn::Arm) {
        self.unknown(&node.pat);
        syn::visit::visit_arm(self, node);
    }

    fn visit_expr_let(&mut self, node: &'ast syn::ExprLet) {
        self.unknown(&node.pat);
        syn::visit::visit_expr_let(self, node);
    }

    /// A `fn` written inside a function body (ripgrep's `#[cfg(unix)] fn imp(p: &PrinterPath)`
    /// pattern) binds its parameters into the same flattened set: its calls are attributed to
    /// the enclosing item, so its receivers have to be typed there too.
    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        // Its *name* also shadows anything the file declares under that name, so a bare call to
        // it is not a call on the top-level item and must be dropped rather than guessed.
        self.nested.insert(node.sig.ident.to_string());
        for input in node.sig.inputs.iter() {
            self.parameter(input);
        }
        syn::visit::visit_item_fn(self, node);
    }
}

struct CallCollector<'a> {
    caller: String,
    self_ty: Option<String>,
    types: &'a Receivers,
    /// `fn`s declared inside this body: a bare call to one of these names is not a call on the
    /// file's item of that name, and nothing here can say which body it landed in.
    nested: &'a HashSet<String>,
    out: Vec<CallSite>,
}

impl<'a> CallCollector<'a> {
    fn push(&mut self, callee: Option<String>) {
        if let Some(callee) = callee {
            self.out.push(CallSite {
                caller: self.caller.clone(),
                callee,
            });
        }
    }
}

impl<'ast, 'a> Visit<'ast> for CallCollector<'a> {
    fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
        let callee = match &*node.func {
            syn::Expr::Path(path) => {
                // Only a *bare* name is shadowed; `self::helper()` is written module-qualified
                // and names the module's item deliberately.
                let bare = path.qself.is_none()
                    && path.path.leading_colon.is_none()
                    && path.path.segments.len() == 1;
                match path_callee(path, self.self_ty.as_deref()) {
                    Some(name) if bare && self.nested.contains(&name) => None,
                    other => other,
                }
            }
            _ => None,
        };
        self.push(callee);
        syn::visit::visit_expr_call(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        let member = node.method.to_string();
        let callee = match &*node.receiver {
            syn::Expr::Path(path)
                if path.qself.is_none()
                    && path.path.leading_colon.is_none()
                    && path.path.segments.len() == 1 =>
            {
                let name = path.path.segments[0].ident.to_string();
                if name == "self" {
                    Some(format!("this.{member}"))
                } else {
                    self.types
                        .get(&name)
                        .and_then(|t| t.clone())
                        .map(|t| format!("{t}.{member}"))
                }
            }
            _ => None,
        };
        self.push(callee);
        syn::visit::visit_expr_method_call(self, node);
    }
}

/// Callee text, normalised the way the extractor normalises it (spec 1.3, "Calls").
fn path_callee(path: &syn::ExprPath, self_ty: Option<&str>) -> Option<String> {
    if path.qself.is_some() || path.path.leading_colon.is_some() {
        return None;
    }
    let segments = &path.path.segments;
    if segments.len() == 1 {
        return Some(segments[0].ident.to_string());
    }
    if segments.len() != 2 {
        return None;
    }
    let head = segments[0].ident.to_string();
    let name = segments[1].ident.to_string();
    match head.as_str() {
        // `self::f()` names an item of this very module: it is a plain name.
        "self" => Some(name),
        "crate" | "super" => None,
        "Self" => self_ty.map(|t| format!("{t}.{name}")),
        _ => Some(format!("{head}.{name}")),
    }
}

fn collect_calls(
    caller: &str,
    scope: &Scope,
    sig: Option<&syn::Signature>,
    block: Option<&syn::Block>,
    facts: &mut FileFacts,
) {
    let block = match block {
        Some(block) => block,
        None => return,
    };
    let mut generics = scope.generics.clone();
    if let Some(sig) = sig {
        generics.extend(generic_names(&sig.generics));
    }
    let mut binder = BinderCollector {
        types: Receivers::new(),
        nested: HashSet::new(),
        self_ty: scope.self_ty.clone(),
        generics: &generics,
    };
    if let Some(sig) = sig {
        for input in sig.inputs.iter() {
            binder.parameter(input);
        }
    }
    binder.visit_block(block);

    let mut collector = CallCollector {
        caller: caller.to_string(),
        self_ty: scope.self_ty.clone(),
        types: &binder.types,
        nested: &binder.nested,
        out: Vec::new(),
    };
    collector.visit_block(block);
    facts.calls.extend(collector.out);
}

/// Calls written in a `const`/`static` initialiser: top-level code, so the caller is the file.
fn collect_expr_calls(caller: &str, scope: &Scope, expr: &syn::Expr, facts: &mut FileFacts) {
    let empty = Receivers::new();
    let no_names = HashSet::new();
    let mut collector = CallCollector {
        caller: caller.to_string(),
        self_ty: scope.self_ty.clone(),
        types: &empty,
        nested: &no_names,
        out: Vec::new(),
    };
    collector.visit_expr(expr);
    facts.calls.extend(collector.out);
}

// ---------------------------------------------------------------------------
// linking
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Binding {
    module: String,
    name: String,
}

fn module_name_of(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    let stem = base.strip_suffix(".rs").unwrap_or(base);
    if stem != "mod" {
        return stem.to_string();
    }
    let dir = parent_dir(path);
    dir.rsplit('/').next().unwrap_or(dir).to_string()
}

fn tarjan(nodes: &[String], edges: &[(String, String)]) -> Vec<Vec<String>> {
    let position: HashMap<&str, usize> = nodes.iter().enumerate().map(|(i, n)| (n.as_str(), i)).collect();
    let count = nodes.len();
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); count];
    for (from, to) in edges.iter() {
        if let (Some(&a), Some(&b)) = (position.get(from.as_str()), position.get(to.as_str())) {
            adjacency[a].push(b);
        }
    }

    let mut index = vec![usize::MAX; count];
    let mut low = vec![0usize; count];
    let mut on_stack = vec![false; count];
    let mut stack: Vec<usize> = Vec::new();
    let mut next = 0usize;
    let mut components: Vec<Vec<String>> = Vec::new();

    for start in 0..count {
        if index[start] != usize::MAX {
            continue;
        }
        // Iterative Tarjan: a corpus repo is far deeper than the call stack allows.
        let mut frames: Vec<(usize, usize)> = vec![(start, 0)];
        index[start] = next;
        low[start] = next;
        next += 1;
        stack.push(start);
        on_stack[start] = true;
        while !frames.is_empty() {
            let last = frames.len() - 1;
            let node = frames[last].0;
            let cursor = frames[last].1;
            if cursor < adjacency[node].len() {
                let child = adjacency[node][cursor];
                frames[last].1 += 1;
                if index[child] == usize::MAX {
                    index[child] = next;
                    low[child] = next;
                    next += 1;
                    stack.push(child);
                    on_stack[child] = true;
                    frames.push((child, 0));
                } else if on_stack[child] {
                    low[node] = low[node].min(index[child]);
                }
                continue;
            }
            frames.pop();
            if let Some(&(parent, _)) = frames.last() {
                low[parent] = low[parent].min(low[node]);
            }
            if low[node] == index[node] {
                let mut component: Vec<String> = Vec::new();
                while let Some(member) = stack.pop() {
                    on_stack[member] = false;
                    component.push(nodes[member].clone());
                    if member == node {
                        break;
                    }
                }
                if component.len() > 1 {
                    component.sort();
                    components.push(component);
                }
            }
        }
    }
    components.sort();
    components
}

fn main() {
    let mut root = String::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--root" || arg == "-root" {
            root = args.next().unwrap_or_default();
        }
    }
    if root.is_empty() {
        eprintln!("usage: rusttruth --root <repo>");
        std::process::exit(2);
    }
    let output = run(Path::new(&root));
    match serde_json::to_string(&output) {
        Ok(text) => println!("{text}"),
        Err(err) => {
            eprintln!("rusttruth: cannot serialise output: {err}");
            std::process::exit(1);
        }
    }
}

fn run(root: &Path) -> Output {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut out = Output::default();

    let discovered: BTreeSet<String> = discover(&root).into_iter().collect();
    let crates = load_crates(&root, &discovered, &mut out.errors);
    out.crates = crates.count;
    let tree = Tree::new(&discovered, &crates);

    // 1. Parse every discovered file. A file `syn` cannot parse is dropped from truth entirely,
    //    so it is never scored as "a file that declares nothing".
    let mut facts: BTreeMap<String, FileFacts> = BTreeMap::new();
    for file in discovered.iter() {
        let source = match fs::read_to_string(root.join(file)) {
            Ok(source) => source,
            Err(err) => {
                out.errors.push(format!("{file}: {err}"));
                continue;
            }
        };
        let parsed = match syn::parse_file(&source) {
            Ok(parsed) => parsed,
            Err(err) => {
                out.errors.push(format!("{file}: {err}"));
                continue;
            }
        };
        let scope = Scope {
            prefix: String::new(),
            top: true,
            mods: Vec::new(),
            type_body: false,
            self_ty: None,
            generics: HashSet::new(),
        };
        let mut file_facts = FileFacts::default();
        walk_items(&parsed.items, &scope, &mut file_facts);
        // A member name two declarations both wanted (two traits each declaring `go` for one
        // type) names two declarations, so it is dropped from the member set entirely: the
        // second took a `~<n>` id, and neither of them is *the* answer to the bare name.
        let ambiguous = file_facts.ambiguous.clone();
        for name in ambiguous.iter() {
            file_facts.members.remove(name);
        }
        facts.insert(file.clone(), file_facts);
    }
    out.files = facts.keys().cloned().collect();

    // 2. Imports: one edge per resolved specifier, plus the per-file resolution table the
    //    export closure and the call rules both read.
    let covered: BTreeSet<String> = facts.keys().cloned().collect();
    let mut targets: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    let mut import_keys: BTreeSet<(String, String)> = BTreeSet::new();
    for (file, file_facts) in facts.iter() {
        let table = targets.entry(file.clone()).or_default();
        for record in file_facts.imports.iter() {
            let resolved = match tree.resolve(file, &record.specifier) {
                Some(resolved) => resolved,
                None => continue,
            };
            if !covered.contains(&resolved) {
                continue;
            }
            table.entry(record.specifier.clone()).or_insert(resolved.clone());
            import_keys.insert((file.clone(), resolved));
        }
    }
    out.imports = import_keys
        .iter()
        .map(|(from, to)| Edge {
            from: from.clone(),
            to: to.clone(),
        })
        .collect();

    // 3. Exports: a file's own `pub` items and `pub use` names, then `pub use …::*` followed
    //    transitively to a fixed point.
    let mut exports: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut stars: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (file, file_facts) in facts.iter() {
        let names = exports.entry(file.clone()).or_default();
        let table = targets.get(file);
        let mut targeted: Vec<String> = Vec::new();
        for record in file_facts.exports.iter() {
            match record {
                ExportRec::Named { name } => {
                    names.insert(name.clone());
                }
                ExportRec::Star { from } => {
                    if let Some(module) = table.and_then(|t| t.get(from)) {
                        if module != file && !targeted.contains(module) {
                            targeted.push(module.clone());
                        }
                    }
                }
            }
        }
        stars.insert(file.clone(), targeted);
    }
    loop {
        let mut changed = false;
        for (file, sources) in stars.iter() {
            let mut added: Vec<String> = Vec::new();
            for source in sources.iter() {
                if let Some(names) = exports.get(source) {
                    for name in names.iter() {
                        if exports.get(file).map(|own| own.contains(name)) != Some(true) {
                            added.push(name.clone());
                        }
                    }
                }
            }
            if added.is_empty() {
                continue;
            }
            changed = true;
            if let Some(own) = exports.get_mut(file) {
                own.extend(added);
            }
        }
        if !changed {
            break;
        }
    }
    for (file, names) in exports.iter() {
        out.exports.insert(file.clone(), names.iter().cloned().collect());
    }

    // 4. Calls, by the rules of spec 1.3. Everything ambiguous is dropped, never guessed.
    //
    // A local name keeps every `use` that binds it, because one file routinely writes a name
    // twice: `use grep_matcher::LineTerminator` at the top, and `use super::LineTerminator`
    // again inside `mod tests`. The rule is "exactly one `use` **whose target declares it**",
    // so the choice is made when the wanted member is known, not when the imports are read.
    let mut bindings: BTreeMap<String, HashMap<String, Vec<Binding>>> = BTreeMap::new();
    let mut reexports: BTreeMap<String, HashMap<String, Vec<Binding>>> = BTreeMap::new();
    let mut modules: BTreeMap<String, HashMap<String, Vec<String>>> = BTreeMap::new();
    // Files a `use …::*` glob brings into scope, other than the file itself: a glob of one's own
    // file (`mod tests { use super::*; }`) adds nothing the same-file rule does not cover.
    let mut globs: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (file, file_facts) in facts.iter() {
        let table = targets.get(file);
        let mut direct: HashMap<String, Vec<Binding>> = HashMap::new();
        let mut through: HashMap<String, Vec<Binding>> = HashMap::new();
        let mut by_module: HashMap<String, Vec<String>> = HashMap::new();
        let mut glob_targets: Vec<String> = Vec::new();
        for record in file_facts.imports.iter() {
            let target = match table.and_then(|t| t.get(&record.specifier)) {
                Some(target) => target.clone(),
                None => continue,
            };
            let last = record.specifier.rsplit("::").next().unwrap_or("").to_string();
            if record.symbols.is_empty() {
                if !last.is_empty() {
                    push_module(&mut by_module, &last, &target);
                }
                continue;
            }
            for (name, local) in record.symbols.iter() {
                if name == "*" {
                    if target != *file && !glob_targets.contains(&target) {
                        glob_targets.push(target.clone());
                    }
                    continue;
                }
                if *name == last && module_name_of(&target) == last {
                    push_module(&mut by_module, local, &target);
                }
                let into = if record.reexport { &mut through } else { &mut direct };
                let list = into.entry(local.clone()).or_default();
                let candidate = Binding {
                    module: target.clone(),
                    name: name.clone(),
                };
                if !list.iter().any(|b| b.module == candidate.module && b.name == candidate.name) {
                    list.push(candidate);
                }
            }
        }
        bindings.insert(file.clone(), direct);
        reexports.insert(file.clone(), through);
        modules.insert(file.clone(), by_module);
        globs.insert(file.clone(), glob_targets);
    }

    let declared = |module: &str, name: &str| -> Option<String> {
        let kind = facts.get(module).and_then(|f| f.items.get(name));
        if let Some(kind) = kind {
            if kind != "type" {
                return Some(format!("{module}#{name}"));
            }
        }
        // Reached through exactly one `pub use`: one documented hop.
        let list = reexports.get(module).and_then(|r| r.get(name))?;
        agreed(list.iter().map(|hop| {
            match facts.get(&hop.module).and_then(|f| f.items.get(&hop.name)) {
                Some(kind) if kind != "type" => Some(format!("{}#{}", hop.module, hop.name)),
                _ => None,
            }
        }))
    };

    let mut call_keys: BTreeSet<(String, String)> = BTreeSet::new();
    for (file, file_facts) in facts.iter() {
        for site in file_facts.calls.iter() {
            let target = resolve_call(
                file,
                site,
                file_facts,
                &facts,
                bindings.get(file),
                &reexports,
                modules.get(file),
                globs.get(file).map(|list| list.as_slice()),
                &declared,
            );
            let to = match target {
                Some(to) => to,
                None => continue,
            };
            let from = if site.caller.is_empty() {
                file.clone()
            } else {
                format!("{file}#{}", site.caller)
            };
            call_keys.insert((from, to));
        }
    }
    out.calls = call_keys
        .iter()
        .map(|(from, to)| Edge {
            from: from.clone(),
            to: to.clone(),
        })
        .collect();

    // 5. Cycles over the import graph.
    let nodes: Vec<String> = out.files.clone();
    let edges: Vec<(String, String)> = import_keys.iter().cloned().collect();
    out.cycles = tarjan(&nodes, &edges);

    out
}

/// Append to a keyed list, skipping an exact duplicate.
fn push_module(map: &mut HashMap<String, Vec<String>>, key: &str, value: &str) {
    let list = map.entry(key.to_string()).or_default();
    if !list.iter().any(|existing| existing == value) {
        list.push(value.to_string());
    }
}

/// The one id every candidate agrees on, or `None` when they disagree or none resolves.
///
/// This is "exactly one" as spec 1.3 means it: the candidates that *resolve* are counted, not
/// the `use` items that were written, so two `use` items naming one declaration are one answer.
fn agreed(candidates: impl Iterator<Item = Option<String>>) -> Option<String> {
    let mut answer: Option<String> = None;
    for candidate in candidates.flatten() {
        match &answer {
            None => answer = Some(candidate),
            Some(existing) if *existing == candidate => {}
            Some(_) => return None,
        }
    }
    answer
}

#[allow(clippy::too_many_arguments)]
fn resolve_call(
    file: &str,
    site: &CallSite,
    own: &FileFacts,
    facts: &BTreeMap<String, FileFacts>,
    bindings: Option<&HashMap<String, Vec<Binding>>>,
    reexports: &BTreeMap<String, HashMap<String, Vec<Binding>>>,
    modules: Option<&HashMap<String, Vec<String>>>,
    globs: Option<&[String]>,
    declared: &dyn Fn(&str, &str) -> Option<String>,
) -> Option<String> {
    let callee = site.callee.as_str();
    if callee.is_empty() {
        return None;
    }
    let dot = callee.find('.');
    let (object, member) = match dot {
        None => {
            // 1. An item of this very file.
            if let Some(kind) = own.items.get(callee) {
                if kind != "type" {
                    return Some(format!("{file}#{callee}"));
                }
            }
            // 2. A name imported by exactly one `use` **whose target declares it**.
            if let Some(candidates) = bindings.and_then(|b| b.get(callee)) {
                if let Some(hit) = agreed(candidates.iter().map(|b| declared(&b.module, &b.name))) {
                    return Some(hit);
                }
            }
            // 6. A glob: `use crate::a::*` then `go()`. Only when exactly one glob is in scope
            // and its target declares the name, so nothing is guessed between two `*`s.
            let targets = globs?;
            if targets.len() != 1 {
                return None;
            }
            let module = &targets[0];
            return match facts.get(module).and_then(|f| f.items.get(callee)) {
                Some(kind) if kind != "type" => Some(format!("{module}#{callee}")),
                _ => None,
            };
        }
        Some(dot) => (&callee[..dot], &callee[dot + 1..]),
    };
    if object.is_empty() || member.is_empty() || member.contains('.') {
        return None;
    }

    // 4. `this.method`: the enclosing type owns it.
    if object == "this" {
        let owner = match site.caller.rfind('.') {
            Some(index) => &site.caller[..index],
            None => return None,
        };
        if owner.is_empty() {
            return None;
        }
        let name = format!("{owner}.{member}");
        return if own.members.contains(&name) {
            Some(format!("{file}#{name}"))
        } else {
            None
        };
    }

    // 5. `module::function`, through a `mod` item or a `use` of the module itself.
    if let Some(candidates) = modules.and_then(|m| m.get(object)) {
        if !candidates.is_empty() {
            return agreed(candidates.iter().map(|module| declared(module, member)));
        }
    }

    // 3. `Type::method`, where `Type` is declared here or imported by exactly one `use`.
    let name = format!("{object}.{member}");
    if own.items.contains_key(object) {
        return if own.members.contains(&name) {
            Some(format!("{file}#{name}"))
        } else {
            None
        };
    }
    let candidates = bindings?.get(object)?;
    agreed(
        candidates
            .iter()
            .map(|binding| through_type(binding, member, facts, reexports)),
    )
}

/// `Type::method` through one import binding: the impl in that file, else one `pub use` hop.
fn through_type(
    binding: &Binding,
    member: &str,
    facts: &BTreeMap<String, FileFacts>,
    reexports: &BTreeMap<String, HashMap<String, Vec<Binding>>>,
) -> Option<String> {
    let target = format!("{}.{member}", binding.name);
    if facts.get(&binding.module).map(|f| f.members.contains(&target)) == Some(true) {
        return Some(format!("{}#{}", binding.module, target));
    }
    let hops = reexports.get(&binding.module).and_then(|r| r.get(&binding.name))?;
    agreed(hops.iter().map(|hop| {
        let through = format!("{}.{member}", hop.name);
        if facts.get(&hop.module).map(|f| f.members.contains(&through)) == Some(true) {
            Some(format!("{}#{}", hop.module, through))
        } else {
            None
        }
    }))
}
