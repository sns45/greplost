// Command tfinspect prints HashiCorp's own view of the Terraform configuration in one
// repository: which .tf files it loads, which module calls each file makes, which variables and
// outputs each file declares, which blocks each file declares, and which blocks reference which.
//
// It is the Terraform half of Eval 1's oracle (tech spec 10.3). It is built and run by
// bench/src/truth/hcl.ts and knows nothing about greplost: everything here comes from
// terraform-config-inspect (HashiCorp's static module reader, which is what `terraform-docs`
// and the Terraform registry use) and from hclsyntax, HCL's own parser. Scoring a structure
// layer against itself would be worthless (tech spec 10.1, principle 2), so this program never
// reads greplost's extractor, resolver or artifacts, and never links against tree-sitter.
//
// Two oracles, one program, because they answer different questions:
//
//	tfconfig    the module model: variables, outputs, managed and data resources and module
//	            calls, each carrying a Pos{Filename, Line}. This is what `imports` (S1) and
//	            `exports` (S2) are built from, and it is a model nobody here wrote.
//	hclsyntax   the expression model: every traversal inside every attribute, with the
//	            for-expression and object-key scoping HCL itself applies. This is what
//	            `references` (S5) is built from, and it is the same parser Terraform runs.
//
// Ruling (leaf 2.2, 2026-09-04): the reference oracle is hclsyntax rather than
// `terraform graph -type=plan`, which the design sketched. Three reasons, all measured on
// fixtures/tiny-terraform with terraform 1.12.2:
//
//  1. `terraform graph` performs a transitive reduction, so it *omits* real direct references:
//     it printed `aws_subnet.a -> aws_vpc.main` and `aws_vpc.main -> var.cidr` but not
//     `aws_subnet.a -> var.cidr`, which is written in the fixture. An oracle that hides true
//     edges makes correct output look like a false positive.
//  2. Its node names carry no file, and every metric here is per file.
//  3. It requires `terraform init`, so it needs the network and a provider download, and it
//     writes .terraform/ into the directory it runs in.
//
// hclsyntax has none of those problems, is offline and deterministic, and is HashiCorp's own
// implementation of the language. NOTES records `hclsyntax-traversals` so RESULTS.md discloses
// which oracle produced the numbers.
//
// Identity, matching greplost's node ids (spec 2026-09-04 section 0.2):
//
//	file      -> repo-relative slash path ("modules/logs/main.tf")
//	module    -> repo-relative directory ("modules/logs"), "." for the repo root, because
//	             Terraform loads every .tf file in a directory as one module
//	node      -> "<file>#<kind>.<name>" for resource, data, variable, output, provider, module
//	const     -> "<file>#local.<name>" and "<file>#terraform" (a `locals` entry and the
//	             `terraform` block are declarations, not nodes)
//	external  -> "ext:module/<source>", "ext:provider/<name>"
//
// Conservatism: a reference is emitted only when the address names exactly one block in the
// caller's own module directory (or, for `module.M.O`, exactly one output in the directory the
// module call names). Anything ambiguous is dropped rather than guessed.
//
// Usage: tfinspect -root <repo root>   (JSON on stdout)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclparse"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/terraform-config-inspect/tfconfig"
)

// edge is one `from -> to` fact, in greplost's id vocabulary.
type edge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// refEdge is one reference fact: the mechanism and the address that produced it travel with it
// so the harness can score `refKind` and show `symbols` without re-deriving either.
type refEdge struct {
	From       string `json:"from"`
	To         string `json:"to"`
	RefKind    string `json:"refKind"`
	Symbol     string `json:"symbol"`
	Confidence string `json:"confidence"`
}

// output is the whole document this program prints.
type output struct {
	// Repo-relative .tf files this program read, sorted.
	Files []string `json:"files"`
	// One entry per (calling file, called in-repo module directory). Import targets are
	// directory ids because a Terraform module is a directory, not a file.
	Imports []edge `json:"imports"`
	// file -> the variable and output names it declares, sorted. A Terraform module's public
	// surface is exactly its variables (inputs) and outputs.
	Exports map[string][]string `json:"exports"`
	// Always empty: HCL has no call edges at all, so S3 is n/a for every Terraform target.
	Calls []edge `json:"calls"`
	// Reference edges, sorted. The fifth metric (S5) is scored against this.
	References []refEdge `json:"references"`
	// Every declaration id, sorted: the node set S5's sibling metric is scored against.
	Nodes []string `json:"nodes"`
	// Parse and load diagnostics, for the harness to disclose.
	Errors []string `json:"errors"`
	// Number of directories loaded as a module, so an empty result is distinguishable from a
	// repo with no Terraform in it.
	Modules int `json:"modules"`
}

const rootDirID = "."

// Directory names never walked: build output, dependency trees, and Terraform's own cache.
var skipDirs = map[string]bool{
	".git":         true,
	".greplost":    true,
	".terraform":   true,
	"build":        true,
	"dist":         true,
	"node_modules": true,
	"testdata":     true,
	"vendor":       true,
}

// Address heads that are Terraform's own symbols and can never name a block.
var ignoredHeads = map[string]bool{
	"count":     true,
	"each":      true,
	"path":      true,
	"self":      true,
	"terraform": true,
}

// requiredProviderPrefix marks a `terraform.required_providers` entry. A "/" cannot occur in an
// HCL address, so the sentinel can never be confused with one.
const requiredProviderPrefix = "provider/"

func main() {
	root := flag.String("root", "", "repository root to read (required)")
	flag.Parse()
	if *root == "" {
		fmt.Fprintln(os.Stderr, "tfinspect: -root is required")
		os.Exit(2)
	}
	abs, err := filepath.Abs(*root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tfinspect: %v\n", err)
		os.Exit(1)
	}
	out, err := run(abs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tfinspect: %v\n", err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "tfinspect: %v\n", err)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

// decl is one declaration, in the shape the reference rules need it.
type decl struct {
	id     string
	kind   string // resource | data | variable | output | provider | module | const
	name   string // as written, without the ~<n> uniqueness suffix
	file   string
	alias  string // provider blocks only
	source string // module blocks only
}

// rawRef is one reference before the address is resolved.
type rawRef struct {
	fromID  string
	dir     string
	address string
	refKind string
}

// module is one Terraform module: one directory, and everything its .tf files declare.
type module struct {
	dir   string
	files []string
	byKey map[string][]*decl
}

func nodeID(file, kind, name string) string {
	if kind == "const" {
		return file + "#" + name
	}
	return file + "#" + kind + "." + name
}

// indexKey is the key an address is looked up by: "<kind>.<name>", or "const:<name>" for a
// `locals` entry and the `terraform` block.
func indexKey(kind, name string) string {
	if kind == "const" {
		return "const:" + name
	}
	return kind + "." + name
}

// dirOf is the module directory of a repo-relative file path.
func dirOf(file string) string {
	index := strings.LastIndex(file, "/")
	if index == -1 {
		return rootDirID
	}
	return file[:index]
}

// isLocalSource is Terraform's own rule: a module source is local exactly when it begins with
// "./" or "../".
func isLocalSource(source string) bool {
	return strings.HasPrefix(source, "./") || strings.HasPrefix(source, "../") ||
		source == "." || source == ".."
}

// joinRelative resolves a local module source against the calling file's directory, returning
// "" when the result climbs out of the repository.
func joinRelative(dir, rest string) (string, bool) {
	if dir == rootDirID {
		dir = ""
	}
	segments := []string{}
	for _, segment := range strings.Split(dir+"/"+rest, "/") {
		switch segment {
		case "", ".":
			continue
		case "..":
			if len(segments) == 0 {
				return "", false
			}
			segments = segments[:len(segments)-1]
		default:
			segments = append(segments, segment)
		}
	}
	if len(segments) == 0 {
		return rootDirID, true
	}
	return strings.Join(segments, "/"), true
}

// ---------------------------------------------------------------------------
// walking
// ---------------------------------------------------------------------------

// terraformFiles returns every .tf file under root, repo-relative with forward slashes, sorted.
func terraformFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable directory is not a finding about the configuration.
			return nil //nolint:nilerr
		}
		if d.IsDir() {
			if p == root {
				return nil
			}
			name := d.Name()
			if skipDirs[name] || strings.HasPrefix(name, ".") {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".tf") {
			return nil
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			return nil //nolint:nilerr
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	return files, nil
}

// ---------------------------------------------------------------------------
// hclsyntax: declarations and raw references
// ---------------------------------------------------------------------------

// blockName is the node name of a top-level block, and whether it is a node at all. `resource`
// and `data` need exactly two labels and every other block exactly one; a block with the wrong
// number is not a node, because which label is the name would be a guess.
func blockName(blockType string, labels []string) (kind string, name string, ok bool) {
	switch blockType {
	case "resource", "data":
		if len(labels) != 2 {
			return "", "", false
		}
		return blockType, labels[0] + "." + labels[1], true
	case "variable", "output", "provider", "module":
		if len(labels) != 1 {
			return "", "", false
		}
		return blockType, labels[0], true
	default:
		return "", "", false
	}
}

// literalString is an attribute's value when it is a plain string with no interpolation.
func literalString(attr *hclsyntax.Attribute) string {
	value, diags := attr.Expr.Value(nil)
	if diags.HasErrors() || value.IsNull() || !value.IsKnown() {
		return ""
	}
	if value.Type().FriendlyName() != "string" {
		return ""
	}
	return value.AsString()
}

// attributesInOrder is a block body's attributes in source order. hclsyntax stores them in a
// map, and both the ~<n> suffix rule and the output ordering need a deterministic order.
func attributesInOrder(body *hclsyntax.Body) []*hclsyntax.Attribute {
	attrs := make([]*hclsyntax.Attribute, 0, len(body.Attributes))
	for _, attr := range body.Attributes {
		attrs = append(attrs, attr)
	}
	sort.Slice(attrs, func(i, j int) bool {
		return attrs[i].SrcRange.Start.Byte < attrs[j].SrcRange.Start.Byte
	})
	return attrs
}

// uniqueName makes a node name unique within one file: `aws`, then `aws~2`, then `aws~3`.
func uniqueName(used map[string]bool, file, kind, name string) string {
	if !used[nodeID(file, kind, name)] {
		used[nodeID(file, kind, name)] = true
		return name
	}
	for n := 2; ; n++ {
		candidate := fmt.Sprintf("%s~%d", name, n)
		if used[nodeID(file, kind, candidate)] {
			continue
		}
		used[nodeID(file, kind, candidate)] = true
		return candidate
	}
}

// addressOf turns a traversal into the dotted address it opens with. A single segment is not an
// address: `string` in `type = string` names no block.
func addressOf(traversal hcl.Traversal) string {
	if len(traversal) == 0 {
		return ""
	}
	parts := []string{traversal.RootName()}
	for _, step := range traversal[1:] {
		attr, ok := step.(hcl.TraverseAttr)
		if !ok {
			break
		}
		parts = append(parts, attr.Name)
	}
	if len(parts) < 2 {
		return ""
	}
	return strings.Join(parts, ".")
}

// exprReferences collects every address an expression names, skipping Terraform's own symbols
// and any name bound by an enclosing `dynamic` block. hclsyntax.Variables already applies HCL's
// own scoping: a `for` expression's key and value variables and a bare object key are not
// variables, so neither reaches here.
func exprReferences(expr hclsyntax.Expression, bound map[string]bool) []string {
	var out []string
	for _, traversal := range hclsyntax.Variables(expr) {
		root := traversal.RootName()
		if ignoredHeads[root] || bound[root] {
			continue
		}
		address := addressOf(traversal)
		if address == "" {
			continue
		}
		out = append(out, address)
	}
	return out
}

// providerOfType is Terraform's own rule: the provider local name is the resource type up to
// the first underscore.
func providerOfType(resourceType string) string {
	if index := strings.IndexByte(resourceType, '_'); index != -1 {
		return resourceType[:index]
	}
	return resourceType
}

// walkBody records every reference inside one block body, attributed to `fromID`. Nested blocks
// belong to the block that contains them; a `dynamic` block binds its label.
func walkBody(body *hclsyntax.Body, fromID, dir string, bound map[string]bool, topLevel bool, refs *[]rawRef) {
	for _, attr := range attributesInOrder(body) {
		// The `provider` meta-argument names a provider configuration and is handled by the
		// caller, so that a resource without one still records its implicit provider. It is a
		// meta-argument only at the top level of a block: an attribute called `provider` inside
		// a nested block is an ordinary argument and references what it names.
		if topLevel && attr.Name == "provider" {
			continue
		}
		for _, address := range exprReferences(attr.Expr, bound) {
			*refs = append(*refs, rawRef{fromID: fromID, dir: dir, address: address, refKind: "hcl-ref"})
		}
	}
	for _, nested := range body.Blocks {
		scope := bound
		if nested.Type == "dynamic" && len(nested.Labels) == 1 {
			scope = make(map[string]bool, len(bound)+1)
			for name := range bound {
				scope[name] = true
			}
			scope[nested.Labels[0]] = true
		}
		walkBody(nested.Body, fromID, dir, scope, false, refs)
	}
}

// scanFile reads one .tf file with hclsyntax and returns the declarations it makes and the
// references it writes.
func scanFile(parser *hclparse.Parser, absolute, rel string) ([]*decl, []rawRef, []string) {
	var problems []string
	file, diags := parser.ParseHCLFile(absolute)
	if diags.HasErrors() {
		for _, diag := range diags {
			problems = append(problems, fmt.Sprintf("%s: %s", rel, diag.Error()))
		}
		if file == nil || file.Body == nil {
			return nil, nil, problems
		}
	}
	body, ok := file.Body.(*hclsyntax.Body)
	if !ok {
		return nil, nil, problems
	}

	dir := dirOf(rel)
	used := map[string]bool{}
	var decls []*decl
	var refs []rawRef

	for _, block := range body.Blocks {
		switch block.Type {
		case "locals":
			if len(block.Labels) != 0 {
				continue
			}
			for _, attr := range attributesInOrder(block.Body) {
				name := uniqueName(used, rel, "const", "local."+attr.Name)
				owner := nodeID(rel, "const", name)
				decls = append(decls, &decl{id: owner, kind: "const", name: name, file: rel})
				for _, address := range exprReferences(attr.Expr, nil) {
					refs = append(refs, rawRef{fromID: owner, dir: dir, address: address, refKind: "hcl-ref"})
				}
			}
		case "terraform":
			if len(block.Labels) != 0 {
				continue
			}
			name := uniqueName(used, rel, "const", "terraform")
			owner := nodeID(rel, "const", name)
			decls = append(decls, &decl{id: owner, kind: "const", name: name, file: rel})
			for _, nested := range block.Body.Blocks {
				if nested.Type != "required_providers" {
					continue
				}
				for _, attr := range attributesInOrder(nested.Body) {
					refs = append(refs, rawRef{
						fromID:  owner,
						dir:     dir,
						address: requiredProviderPrefix + attr.Name,
						refKind: "hcl-ref",
					})
				}
			}
		default:
			kind, written, ok := blockName(block.Type, block.Labels)
			if !ok || written == "" {
				continue
			}
			name := uniqueName(used, rel, kind, written)
			owner := nodeID(rel, kind, name)
			made := &decl{id: owner, kind: kind, name: name, file: rel}
			if kind == "provider" {
				if attr, has := block.Body.Attributes["alias"]; has {
					made.alias = literalString(attr)
				}
			}
			if kind == "module" {
				if attr, has := block.Body.Attributes["source"]; has {
					made.source = literalString(attr)
					if made.source != "" {
						refs = append(refs, rawRef{
							fromID:  owner,
							dir:     dir,
							address: made.source,
							refKind: "uses",
						})
					}
				}
			}
			decls = append(decls, made)
			walkBody(block.Body, owner, dir, nil, true, &refs)
			refs = append(refs, providerReferences(block, kind, owner, dir)...)
		}
	}
	return decls, refs, problems
}

// providerReferences is the provider a block uses: the `provider =` meta-argument when it has
// one, and otherwise the implicit configuration named by a resource type's prefix.
func providerReferences(block *hclsyntax.Block, kind, owner, dir string) []rawRef {
	if attr, has := block.Body.Attributes["provider"]; has {
		traversal, diags := hcl.AbsTraversalForExpr(attr.Expr)
		if diags.HasErrors() || len(traversal) == 0 {
			return nil
		}
		parts := []string{traversal.RootName()}
		for _, step := range traversal[1:] {
			step, ok := step.(hcl.TraverseAttr)
			if !ok {
				break
			}
			parts = append(parts, step.Name)
		}
		return []rawRef{{fromID: owner, dir: dir, address: strings.Join(parts, "."), refKind: "hcl-ref"}}
	}
	if kind != "resource" && kind != "data" {
		return nil
	}
	return []rawRef{{
		fromID:  owner,
		dir:     dir,
		address: providerOfType(block.Labels[0]),
		refKind: "hcl-ref",
	}}
}

// ---------------------------------------------------------------------------
// reference resolution
// ---------------------------------------------------------------------------

// only is the one declaration `key` names in `dir`, or nil when there is not exactly one.
func only(modules map[string]*module, dir, key string) *decl {
	mod := modules[dir]
	if mod == nil {
		return nil
	}
	found := mod.byKey[key]
	if len(found) != 1 {
		return nil
	}
	return found[0]
}

// providerConfig is the provider configuration `name` (with `alias`, or "" for the default one)
// means in `dir`, when exactly one block declares it.
func providerConfig(modules map[string]*module, dir, name, alias string) *decl {
	mod := modules[dir]
	if mod == nil {
		return nil
	}
	var matching []*decl
	for _, candidate := range mod.byKey["provider."+name] {
		if candidate.alias == alias {
			matching = append(matching, candidate)
		}
	}
	if len(matching) != 1 {
		return nil
	}
	return matching[0]
}

// resolve turns one raw reference into an edge, or reports that it names no single block.
func resolve(modules map[string]*module, ref rawRef) (refEdge, bool) {
	made := func(to, confidence string) (refEdge, bool) {
		return refEdge{From: ref.fromID, To: to, RefKind: ref.refKind, Symbol: ref.address, Confidence: confidence}, true
	}

	if ref.refKind == "uses" {
		if !isLocalSource(ref.address) {
			if strings.HasPrefix(ref.address, "/") {
				return refEdge{}, false
			}
			return made("ext:module/"+ref.address, "high")
		}
		target, ok := joinRelative(ref.dir, ref.address)
		if !ok || modules[target] == nil {
			return refEdge{}, false
		}
		return made(target, "high")
	}

	if strings.HasPrefix(ref.address, requiredProviderPrefix) {
		name := strings.TrimPrefix(ref.address, requiredProviderPrefix)
		if name == "" {
			return refEdge{}, false
		}
		return made("ext:provider/"+name, "high")
	}

	segments := strings.Split(ref.address, ".")
	head := segments[0]

	if len(segments) == 1 {
		if found := providerConfig(modules, ref.dir, head, ""); found != nil {
			return made(found.id, "high")
		}
		return refEdge{}, false
	}

	switch head {
	case "var":
		if found := only(modules, ref.dir, indexKey("variable", segments[1])); found != nil {
			return made(found.id, "high")
		}
	case "local":
		if found := only(modules, ref.dir, indexKey("const", "local."+segments[1])); found != nil {
			return made(found.id, "high")
		}
	case "data":
		if len(segments) < 3 {
			return refEdge{}, false
		}
		if found := only(modules, ref.dir, indexKey("data", segments[1]+"."+segments[2])); found != nil {
			return made(found.id, "high")
		}
	case "module":
		call := only(modules, ref.dir, indexKey("module", segments[1]))
		if call == nil {
			return refEdge{}, false
		}
		if len(segments) == 2 {
			return made(call.id, "high")
		}
		if call.source == "" || !isLocalSource(call.source) {
			return refEdge{}, false
		}
		target, ok := joinRelative(ref.dir, call.source)
		if !ok {
			return refEdge{}, false
		}
		if found := only(modules, target, indexKey("output", segments[2])); found != nil {
			// The one documented hop: through the module call, onto the module's own output.
			return made(found.id, "med")
		}
	default:
		if found := only(modules, ref.dir, indexKey("resource", head+"."+segments[1])); found != nil {
			return made(found.id, "high")
		}
		if found := providerConfig(modules, ref.dir, head, segments[1]); found != nil {
			return made(found.id, "high")
		}
	}
	return refEdge{}, false
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

func run(root string) (*output, error) {
	files, err := terraformFiles(root)
	if err != nil {
		return nil, err
	}

	out := &output{
		Files:      []string{},
		Imports:    []edge{},
		Exports:    map[string][]string{},
		Calls:      []edge{},
		References: []refEdge{},
		Nodes:      []string{},
		Errors:     []string{},
	}

	// Pass 1: every declaration, from HCL's own parser, in source order per file.
	parser := hclparse.NewParser()
	modules := map[string]*module{}
	var refs []rawRef
	for _, rel := range files {
		decls, fileRefs, problems := scanFile(parser, filepath.Join(root, filepath.FromSlash(rel)), rel)
		out.Errors = append(out.Errors, problems...)
		dir := dirOf(rel)
		mod := modules[dir]
		if mod == nil {
			mod = &module{dir: dir, byKey: map[string][]*decl{}}
			modules[dir] = mod
		}
		mod.files = append(mod.files, rel)
		for _, made := range decls {
			key := indexKey(made.kind, made.name)
			mod.byKey[key] = append(mod.byKey[key], made)
			out.Nodes = append(out.Nodes, made.id)
		}
		refs = append(refs, fileRefs...)
		out.Files = append(out.Files, rel)
	}
	out.Modules = len(modules)

	// Pass 2: the module model, from terraform-config-inspect. It is a second, independent read
	// of the same directories, and it is what `imports` and `exports` are built from.
	dirs := make([]string, 0, len(modules))
	for dir := range modules {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	for _, dir := range dirs {
		absolute := root
		if dir != rootDirID {
			absolute = filepath.Join(root, filepath.FromSlash(dir))
		}
		mod, diags := tfconfig.LoadModule(absolute)
		for _, diag := range diags {
			if diag.Severity == tfconfig.DiagError {
				out.Errors = append(out.Errors, fmt.Sprintf("%s: %s", dir, diag.Summary))
			}
		}
		if mod == nil {
			continue
		}
		for _, variable := range mod.Variables {
			file := relativePos(root, variable.Pos.Filename)
			if file == "" {
				continue
			}
			out.Exports[file] = append(out.Exports[file], variable.Name)
		}
		for _, o := range mod.Outputs {
			file := relativePos(root, o.Pos.Filename)
			if file == "" {
				continue
			}
			out.Exports[file] = append(out.Exports[file], o.Name)
		}
		for _, call := range mod.ModuleCalls {
			file := relativePos(root, call.Pos.Filename)
			if file == "" || !isLocalSource(call.Source) {
				continue
			}
			target, ok := joinRelative(dirOf(file), call.Source)
			if !ok || modules[target] == nil {
				continue
			}
			out.Imports = append(out.Imports, edge{From: file, To: target})
		}
	}

	// Pass 3: resolve every reference against the module index.
	for _, ref := range refs {
		if made, ok := resolve(modules, ref); ok {
			out.References = append(out.References, made)
		}
	}

	sortOutput(out)
	return out, nil
}

// relativePos turns a tfconfig Pos.Filename into a repo-relative slash path, or "" when it
// points outside the repository.
func relativePos(root, filename string) string {
	if filename == "" {
		return ""
	}
	if !filepath.IsAbs(filename) {
		return filepath.ToSlash(filepath.Clean(filename))
	}
	rel, err := filepath.Rel(root, filename)
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	return filepath.ToSlash(rel)
}

func sortOutput(out *output) {
	sort.Strings(out.Files)
	sort.Strings(out.Nodes)
	sort.Strings(out.Errors)
	sort.Slice(out.Imports, func(i, j int) bool {
		if out.Imports[i].From != out.Imports[j].From {
			return out.Imports[i].From < out.Imports[j].From
		}
		return out.Imports[i].To < out.Imports[j].To
	})
	sort.Slice(out.References, func(i, j int) bool {
		a, b := out.References[i], out.References[j]
		if a.From != b.From {
			return a.From < b.From
		}
		if a.To != b.To {
			return a.To < b.To
		}
		if a.RefKind != b.RefKind {
			return a.RefKind < b.RefKind
		}
		return a.Symbol < b.Symbol
	})
	for file := range out.Exports {
		sort.Strings(out.Exports[file])
	}
	out.Nodes = dedupeStrings(out.Nodes)
}

func dedupeStrings(values []string) []string {
	out := values[:0]
	var previous string
	for i, value := range values {
		if i > 0 && value == previous {
			continue
		}
		out = append(out, value)
		previous = value
	}
	return out
}
