// Command pulumigotruth prints go/types' own view of the Pulumi resources in a
// repository: which resources a Go program constructs, and which of them are fed
// another resource's output.
//
// It is the Go half of the signal oracle (spec 2026-09-04 section 3.7), the
// counterpart of bench/src/truth/signals-ts.ts. It is built and run by
// bench/src/truth/signals-pulumi-go.ts and knows nothing about greplost: everything
// here comes from golang.org/x/tools/go/packages, go/ast and go/types. Scoring a
// structure layer against itself would be worthless (tech spec 10.1, principle 2),
// so this program never reads greplost's extractor, resolver or artifacts.
//
// The one question it answers, and the only way it answers it:
//
//	a call is a resource constructor when its result type implements
//	`pulumi.Resource`, decided by types.Implements against the interface looked
//	up in the loaded package set.
//
// Never by name. `s3.NewBucket` is a resource because `*s3.Bucket` has the method
// set of `pulumi.Resource` (an interface with unexported methods, so only a type
// embedding a Pulumi resource state can have them), and an identically shaped
// `thing.NewThing` from an ordinary package is not, because `*thing.Thing` does
// not. `fixtures/tiny-pulumi-go` ships exactly that pair.
//
// Identity, matching greplost's node ids (tech spec 5.3, schema 2):
//
//	file      -> repo-relative slash path ("aws-go-s3-folder/main.go")
//	resource  -> "<file>#resource.<name>", where <name> is the identifier the
//	             constructor's result is bound to, "~<index>" by position among
//	             the file's unbound resources when it is bound to nothing, and
//	             "<name>~<n>" from 2 when one file binds the same name twice
//	reference -> from the constructed resource to the resource whose field or
//	             method its arguments read, refKind "resource-input"
//
// Names are shared vocabulary, not shared judgement: which calls are resources and
// which identifiers hold resources are both decided by the type checker, and the
// names only say where to write the answer down.
//
// Multi-module repositories are loaded module by module. `pulumi/examples`, the
// pinned corpus, is fifty Go modules with no module at the root, and `./...` from a
// directory that is not in a module matches nothing at all.
//
// Usage: pulumigotruth -root <repo root>   (JSON on stdout)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/types"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

// reference is one `resource-input` fact, in greplost's edge vocabulary.
type reference struct {
	From    string   `json:"from"`
	To      string   `json:"to"`
	Kind    string   `json:"kind"`
	RefKind string   `json:"refKind"`
	Symbols []string `json:"symbols"`
}

// output is the whole document this program prints.
type output struct {
	// Files the Go toolchain actually loaded, repo-relative and sorted. The
	// harness intersects both sides with this before scoring.
	Files []string `json:"files"`
	// Resource node ids, sorted.
	Nodes []string `json:"nodes"`
	// `resource-input` edges between those nodes, sorted.
	References []reference `json:"references"`
	// Package load errors, for the harness to disclose. Loading is best effort.
	Errors []string `json:"errors"`
	// Packages loaded across every module, so an empty result is distinguishable
	// from a repo with nothing in it.
	Packages int `json:"packages"`
	// Modules the loader was pointed at.
	Modules int `json:"modules"`
	// Modules whose package set contained the Pulumi SDK, and could therefore
	// have a resource in them at all.
	PulumiModules int `json:"pulumiModules"`
}

const (
	// The core SDK package that declares the `Resource` interface. This is the one
	// place a path is written down, and it names the interface, never a resource.
	sdkPrefix   = "github.com/pulumi/pulumi/sdk/"
	sdkPkgSufix = "/go/pulumi"
	resourceIfc = "Resource"
)

func main() {
	root := flag.String("root", "", "repository root to load (required)")
	flag.Parse()
	if *root == "" {
		fmt.Fprintln(os.Stderr, "pulumigotruth: -root is required")
		os.Exit(2)
	}
	abs, err := filepath.Abs(*root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pulumigotruth: %v\n", err)
		os.Exit(1)
	}
	out, err := run(abs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pulumigotruth: %v\n", err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "pulumigotruth: %v\n", err)
		os.Exit(1)
	}
}

func run(root string) (*output, error) {
	out := &output{
		Files:      []string{},
		Nodes:      []string{},
		References: []reference{},
		Errors:     []string{},
	}

	dirs, err := moduleDirs(root)
	if err != nil {
		return nil, err
	}
	out.Modules = len(dirs)

	files := map[string]bool{}
	nodes := map[string]bool{}
	refs := map[string]reference{}
	seenErr := map[string]bool{}

	for _, dir := range dirs {
		pkgs, err := load(dir)
		if err != nil {
			// A module the loader could not start on is a disclosed error, not a
			// dead run: the other forty still have something to say.
			if !seenErr[err.Error()] {
				seenErr[err.Error()] = true
				out.Errors = append(out.Errors, err.Error())
			}
			continue
		}
		out.Packages += len(pkgs)
		for _, pkg := range pkgs {
			for _, e := range pkg.Errors {
				if msg := e.Error(); !seenErr[msg] {
					seenErr[msg] = true
					out.Errors = append(out.Errors, msg)
				}
			}
		}

		iface := resourceInterface(pkgs)
		if iface != nil {
			out.PulumiModules++
		}
		scanModule(root, pkgs, iface, files, nodes, refs)
	}

	out.Files = sortedKeys(files)
	out.Nodes = sortedKeys(nodes)
	for _, ref := range refs {
		out.References = append(out.References, ref)
	}
	sort.Slice(out.References, func(i, j int) bool {
		a, b := out.References[i], out.References[j]
		if a.From != b.From {
			return a.From < b.From
		}
		if a.To != b.To {
			return a.To < b.To
		}
		return strings.Join(a.Symbols, ",") < strings.Join(b.Symbols, ",")
	})
	sort.Strings(out.Errors)
	return out, nil
}

func load(dir string) ([]*packages.Package, error) {
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
			packages.NeedImports | packages.NeedDeps | packages.NeedTypes |
			packages.NeedSyntax | packages.NeedTypesInfo | packages.NeedModule,
		Dir:   dir,
		Tests: false,
	}
	return packages.Load(cfg, "./...")
}

// moduleDirs is every directory the loader has to be pointed at.
//
// The root itself when it is a module (which is every single-module repository and
// every fixture), and otherwise each `go.mod` beneath it. `./...` never descends
// into a nested module, so a nested one is listed on its own.
func moduleDirs(root string) ([]string, error) {
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err == nil {
		return []string{root}, nil
	}
	var out []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			name := entry.Name()
			if path != root && (name == "vendor" || name == "testdata" || name == "node_modules" || strings.HasPrefix(name, ".")) {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Name() == "go.mod" {
			out = append(out, filepath.Dir(path))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// resourceInterface is `pulumi.Resource` as this module's package set declares it.
//
// Looked up by the SDK's own import path and the interface's own name, which is the
// only naming this program does: everything downstream is a method-set question.
// nil when the module does not depend on the Pulumi SDK at all, in which case it
// cannot construct a Pulumi resource and contributes nothing.
func resourceInterface(pkgs []*packages.Package) *types.Interface {
	var found *types.Interface
	packages.Visit(pkgs, func(pkg *packages.Package) bool {
		if found != nil || pkg.Types == nil {
			return found == nil
		}
		path := pkg.PkgPath
		if !strings.HasPrefix(path, sdkPrefix) || !strings.HasSuffix(path, sdkPkgSufix) {
			return true
		}
		object := pkg.Types.Scope().Lookup(resourceIfc)
		if object == nil {
			return true
		}
		iface, ok := object.Type().Underlying().(*types.Interface)
		if ok {
			found = iface
		}
		return found == nil
	}, nil)
	return found
}

// scanModule walks every file of `pkgs` that lives under `root` and records what it
// found. A module with no Pulumi SDK in its package set still contributes its files
// (they were loaded, and the harness scores both sides over the loaded universe);
// it just has no resource in it.
func scanModule(
	root string,
	pkgs []*packages.Package,
	iface *types.Interface,
	files map[string]bool,
	nodes map[string]bool,
	refs map[string]reference,
) {
	for _, pkg := range pkgs {
		if pkg.Fset == nil {
			continue
		}
		for _, syntax := range pkg.Syntax {
			name := pkg.Fset.Position(syntax.Pos()).Filename
			rel, ok := relTo(root, name)
			if !ok {
				continue
			}
			files[rel] = true
			if iface == nil || pkg.TypesInfo == nil {
				continue
			}
			scanFile(rel, syntax, pkg.TypesInfo, iface, nodes, refs)
		}
	}
}

// scanFile records the resources of one file and the inputs between them.
func scanFile(
	file string,
	syntax *ast.File,
	info *types.Info,
	iface *types.Interface,
	nodes map[string]bool,
	refs map[string]reference,
) {
	bound := bindings(syntax)
	names := newAllocator()
	byBinding := map[string]string{}
	type resourceCall struct {
		name string
		call *ast.CallExpr
	}
	var found []resourceCall
	anonymous := 0

	// ast.Inspect visits in source order, which is what makes the `~<index>` of an
	// unbound resource reproducible.
	ast.Inspect(syntax, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || !isResource(info.TypeOf(call), iface) {
			return true
		}
		binding, hasBinding := bound[call]
		name := binding
		if !hasBinding {
			name = fmt.Sprintf("~%d", anonymous)
			anonymous++
		}
		name = names.take(name)
		if hasBinding {
			if _, seen := byBinding[binding]; !seen {
				byBinding[binding] = name
			}
		}
		nodes[file+"#resource."+name] = true
		found = append(found, resourceCall{name: name, call: call})
		return true
	})

	// Inputs come second: a resource may be fed one constructed below it.
	for _, entry := range found {
		for _, read := range inputsOf(entry.call, info, iface, byBinding, entry.name) {
			ref := reference{
				From:    file + "#resource." + entry.name,
				To:      file + "#resource." + byBinding[read.binding],
				Kind:    "reference",
				RefKind: "resource-input",
				Symbols: []string{read.text},
			}
			refs[ref.From+" -> "+ref.To+" ("+read.text+")"] = ref
		}
	}
}

// isResource is the whole judgement of this program.
func isResource(t types.Type, iface *types.Interface) bool {
	if t == nil || iface == nil {
		return false
	}
	// A Go constructor returns `(*T, error)`; the resource is the first result.
	if tuple, ok := t.(*types.Tuple); ok {
		if tuple.Len() == 0 {
			return false
		}
		t = tuple.At(0).Type()
	}
	if t == nil || t == types.Typ[types.Invalid] {
		return false
	}
	return types.Implements(t, iface)
}

// bindings maps a call expression to the identifier its result is bound to.
//
// The first name on the left of a `:=`, a `=` or a `var`, when that statement's
// right-hand side is this one call. The blank identifier binds nothing.
func bindings(syntax *ast.File) map[*ast.CallExpr]string {
	out := map[*ast.CallExpr]string{}
	record := func(value ast.Expr, name *ast.Ident) {
		call, ok := value.(*ast.CallExpr)
		if !ok || name == nil || name.Name == "_" {
			return
		}
		if _, seen := out[call]; !seen {
			out[call] = name.Name
		}
	}
	ast.Inspect(syntax, func(node ast.Node) bool {
		switch stmt := node.(type) {
		case *ast.AssignStmt:
			if len(stmt.Rhs) == 1 && len(stmt.Lhs) > 0 {
				name, _ := stmt.Lhs[0].(*ast.Ident)
				record(stmt.Rhs[0], name)
			}
		case *ast.ValueSpec:
			if len(stmt.Values) == 1 && len(stmt.Names) > 0 {
				record(stmt.Values[0], stmt.Names[0])
			}
		}
		return true
	})
	return out
}

// address is one `<var>.<Field>` read inside a constructor's arguments.
type address struct {
	binding string
	text    string
}

// inputsOf is every read of another resource's field or method in `call`'s arguments.
//
// Two conditions, and the first one is the type checker's: the identifier's object
// must itself be a value whose type implements `pulumi.Resource`, and it must name a
// resource this file constructed, so the edge has somewhere to land.
func inputsOf(
	call *ast.CallExpr,
	info *types.Info,
	iface *types.Interface,
	byBinding map[string]string,
	self string,
) []address {
	seen := map[string]bool{}
	var out []address
	for _, arg := range call.Args {
		ast.Inspect(arg, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			ident, ok := selector.X.(*ast.Ident)
			if !ok {
				return true
			}
			object := info.ObjectOf(ident)
			if object == nil || !isResource(object.Type(), iface) {
				return true
			}
			node_, known := byBinding[ident.Name]
			if !known || node_ == self {
				return true
			}
			text := ident.Name + "." + selector.Sel.Name
			if seen[text] {
				return true
			}
			seen[text] = true
			out = append(out, address{binding: ident.Name, text: text})
			return true
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].text < out[j].text })
	return out
}

// allocator keeps node names unique inside one file: a duplicate takes `~<n>` from 2.
type allocator struct{ used map[string]int }

func newAllocator() *allocator { return &allocator{used: map[string]int{}} }

func (a *allocator) take(name string) string {
	seen, ok := a.used[name]
	if !ok {
		a.used[name] = 1
		return name
	}
	next := seen + 1
	a.used[name] = next
	return fmt.Sprintf("%s~%d", name, next)
}

// relTo is `name` as a repo-relative slash path, or false when it is outside `root`.
func relTo(root, name string) (string, bool) {
	rel, err := filepath.Rel(root, name)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}
