// Command gocallgraph prints the Go toolchain's own view of one repository:
// which files it loads, which packages each file imports, which identifiers each
// file exports, and which functions call which.
//
// It is the Go half of Eval 1's compiler oracle (tech spec 10.3). It is built
// and run by bench/src/truth/go.ts and knows nothing about greplost: everything
// here comes from go/packages (which drives `go list -json -deps`), go/ast and
// golang.org/x/tools/go/callgraph/cha. Scoring a structure layer against itself
// would be worthless (tech spec 10.1, principle 2), so this program never reads
// greplost's extractor, resolver or artifacts.
//
// Identity, matching greplost's node ids (tech spec 5.3):
//
//	file    -> repo-relative slash path ("render/json.go")
//	package -> repo-relative directory ("render"), "." for the module root,
//	           because a Go import names a package, not a file (Appendix C)
//	symbol  -> "<file>#<Name>" or "<file>#<Type>.<method>"
//	caller  -> the enclosing top-level func of the call site, or the bare file
//	           id for a call in a package-level initializer
//
// Conservatism: every edge has both ends inside the repo, and a callee this
// program cannot name (a func literal, a synthetic wrapper) is dropped rather
// than guessed.
//
// Usage: gocallgraph -root <repo root>   (JSON on stdout)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/tools/go/callgraph/cha"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"
)

// edge is one `from -> to` fact, in greplost's id vocabulary.
type edge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// output is the whole document this program prints.
type output struct {
	// Files the Go toolchain actually loaded, repo-relative and sorted. Files
	// excluded by a build constraint are absent, which is what lets the harness
	// score both sides over the same universe.
	Files []string `json:"files"`
	// One entry per (importing file, imported in-repo package directory).
	Imports []edge `json:"imports"`
	// file -> exported package-level identifiers, sorted. Methods are members of
	// a type, not of a package, and are not listed.
	Exports map[string][]string `json:"exports"`
	// Static and CHA-resolved call edges between named, in-repo functions.
	Calls []edge `json:"calls"`
	// Package load errors, for the harness to disclose. Loading is best effort:
	// a package that fails to type-check simply contributes nothing.
	Errors []string `json:"errors"`
	// Number of packages `./...` matched, so an empty result is distinguishable
	// from a repo with nothing in it.
	Packages int `json:"packages"`
}

const rootDirID = "."

func main() {
	root := flag.String("root", "", "repository root to load (required)")
	flag.Parse()
	if *root == "" {
		fmt.Fprintln(os.Stderr, "gocallgraph: -root is required")
		os.Exit(2)
	}
	abs, err := filepath.Abs(*root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gocallgraph: %v\n", err)
		os.Exit(1)
	}
	out, err := run(abs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gocallgraph: %v\n", err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "gocallgraph: %v\n", err)
		os.Exit(1)
	}
}

func run(root string) (*output, error) {
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
			packages.NeedImports | packages.NeedDeps | packages.NeedTypes |
			packages.NeedSyntax | packages.NeedTypesInfo | packages.NeedModule,
		Dir:   root,
		Tests: false,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return nil, err
	}

	out := &output{
		Files:    []string{},
		Imports:  []edge{},
		Exports:  map[string][]string{},
		Calls:    []edge{},
		Errors:   []string{},
		Packages: len(pkgs),
	}

	// Only packages whose files live under `root` are the repo; everything the
	// module depends on is loaded so calls resolve, but is never an edge end.
	repo := &repoIndex{root: root, funcsByFile: map[string][]funcSpan{}}

	seenErr := map[string]bool{}
	for _, pkg := range pkgs {
		for _, e := range pkg.Errors {
			if msg := e.Error(); !seenErr[msg] {
				seenErr[msg] = true
				out.Errors = append(out.Errors, msg)
			}
		}
	}
	sort.Strings(out.Errors)

	files := map[string]bool{}
	for _, pkg := range pkgs {
		// A package that did not type-check has no SSA and therefore no calls, and
		// its exports are whatever the parser salvaged. Listing its files as
		// "loaded" would make the harness score a prediction about them against an
		// answer this program was structurally unable to give, so the package is
		// left out of the covered universe entirely and disclosed through Errors.
		if len(pkg.Errors) > 0 {
			continue
		}
		for _, name := range pkg.GoFiles {
			if rel, ok := repo.rel(name); ok {
				files[rel] = true
			}
		}
	}
	out.Files = sortedKeys(files)

	// Imports and exports come straight from the syntax the toolchain loaded.
	importEdges := map[edge]bool{}
	for _, pkg := range pkgs {
		for _, file := range pkg.Syntax {
			name := pkg.Fset.Position(file.Pos()).Filename
			rel, ok := repo.rel(name)
			if !ok || !files[rel] {
				continue
			}
			repo.indexFuncs(pkg, rel, file)
			for _, spec := range file.Imports {
				path, err := strconv.Unquote(spec.Path.Value)
				if err != nil {
					continue
				}
				dir, ok := repo.packageDir(pkg.Imports[path])
				if !ok {
					continue
				}
				importEdges[edge{From: rel, To: dir}] = true
			}
			out.Exports[rel] = exportedNames(file)
		}
	}
	out.Imports = sortedEdges(importEdges)

	// Calls need SSA. A package that failed to type-check has no types and is
	// skipped by ssautil; the rest still produce their edges.
	prog, _ := ssautil.AllPackages(pkgs, ssa.InstantiateGenerics)
	prog.Build()
	graph := cha.CallGraph(prog)

	callEdges := map[edge]bool{}
	for _, node := range graph.Nodes {
		for _, e := range node.Out {
			if e.Site == nil || e.Callee == nil {
				continue
			}
			from, ok := repo.callerID(prog.Fset, e.Site.Pos())
			if !ok {
				continue
			}
			to, ok := repo.calleeID(prog.Fset, e.Callee.Func)
			if !ok {
				continue
			}
			callEdges[edge{From: from, To: to}] = true
		}
	}
	out.Calls = sortedEdges(callEdges)
	return out, nil
}

// funcSpan is one top-level function's byte range and symbol path in a file.
type funcSpan struct {
	start, end token.Pos
	symbol     string
}

type repoIndex struct {
	root string
	// file -> top-level funcs, in declaration order.
	funcsByFile map[string][]funcSpan
}

// rel reports the repo-relative slash path of an absolute filename, and whether
// it is inside the repo at all.
func (r *repoIndex) rel(name string) (string, bool) {
	if name == "" {
		return "", false
	}
	rel, err := filepath.Rel(r.root, name)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// packageDir is the repo-relative directory id of a loaded package, and whether
// that package lives in this repo.
func (r *repoIndex) packageDir(pkg *packages.Package) (string, bool) {
	if pkg == nil {
		return "", false
	}
	names := pkg.GoFiles
	if len(names) == 0 {
		names = pkg.CompiledGoFiles
	}
	if len(names) == 0 {
		return "", false
	}
	rel, ok := r.rel(names[0])
	if !ok {
		return "", false
	}
	dir := filepath.ToSlash(filepath.Dir(rel))
	if dir == "" || dir == "." {
		return rootDirID, true
	}
	return dir, true
}

// indexFuncs records the top-level functions of one file so a call position can
// be attributed to the declaration that owns it - including calls inside a func
// literal, which belong to the enclosing declaration exactly as greplost's
// extractor attributes them.
func (r *repoIndex) indexFuncs(pkg *packages.Package, rel string, file *ast.File) {
	if _, done := r.funcsByFile[rel]; done {
		return
	}
	spans := []funcSpan{}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		symbol := fn.Name.Name
		if fn.Recv != nil {
			recv := receiverTypeName(pkg, fn)
			if recv == "" {
				continue
			}
			symbol = recv + "." + fn.Name.Name
		}
		spans = append(spans, funcSpan{start: fn.Pos(), end: fn.End(), symbol: symbol})
	}
	r.funcsByFile[rel] = spans
}

// callerID is the greplost id of whatever owns the call at pos: `<file>#<symbol>`
// inside a function, and the bare `<file>` for a package-level initializer.
func (r *repoIndex) callerID(fset *token.FileSet, pos token.Pos) (string, bool) {
	if !pos.IsValid() {
		return "", false
	}
	rel, ok := r.rel(fset.Position(pos).Filename)
	if !ok {
		return "", false
	}
	spans, known := r.funcsByFile[rel]
	if !known {
		return "", false
	}
	for _, span := range spans {
		if pos >= span.start && pos < span.end {
			return rel + "#" + span.symbol, true
		}
	}
	return rel, true
}

// calleeID is the greplost id of a called function, or false when this program
// cannot name it: a func literal, a synthetic wrapper, or code outside the repo.
func (r *repoIndex) calleeID(fset *token.FileSet, fn *ssa.Function) (string, bool) {
	if fn == nil {
		return "", false
	}
	if origin := fn.Origin(); origin != nil {
		fn = origin
	}
	if fn.Parent() != nil {
		return "", false // a func literal has no declared name
	}
	obj := fn.Object()
	if obj == nil {
		return "", false // a synthetic wrapper, thunk or bound method
	}
	rel, ok := r.rel(fset.Position(obj.Pos()).Filename)
	if !ok {
		return "", false
	}
	name := obj.Name()
	if sig, isSig := obj.Type().(*types.Signature); isSig && sig.Recv() != nil {
		recv := namedTypeName(sig.Recv().Type())
		if recv == "" {
			return "", false
		}
		name = recv + "." + name
	}
	return rel + "#" + name, true
}

// receiverTypeName is the declared type name a method hangs off, star stripped
// and type parameters dropped: `func (s *Store[T]) Put` gives `Store`.
func receiverTypeName(pkg *packages.Package, fn *ast.FuncDecl) string {
	if pkg.TypesInfo != nil {
		if obj, ok := pkg.TypesInfo.Defs[fn.Name].(*types.Func); ok && obj != nil {
			if sig, isSig := obj.Type().(*types.Signature); isSig && sig.Recv() != nil {
				if name := namedTypeName(sig.Recv().Type()); name != "" {
					return name
				}
			}
		}
	}
	// Syntax fallback, for a file that did not type-check.
	if len(fn.Recv.List) == 0 {
		return ""
	}
	return exprTypeName(fn.Recv.List[0].Type)
}

func exprTypeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.StarExpr:
		return exprTypeName(t.X)
	case *ast.IndexExpr:
		return exprTypeName(t.X)
	case *ast.IndexListExpr:
		return exprTypeName(t.X)
	case *ast.ParenExpr:
		return exprTypeName(t.X)
	case *ast.Ident:
		return t.Name
	}
	return ""
}

func namedTypeName(t types.Type) string {
	if ptr, ok := t.(*types.Pointer); ok {
		t = ptr.Elem()
	}
	switch n := t.(type) {
	case *types.Named:
		if origin := n.Origin(); origin != nil && origin.Obj() != nil {
			return origin.Obj().Name()
		}
		if n.Obj() != nil {
			return n.Obj().Name()
		}
	case *types.Alias:
		if n.Obj() != nil {
			return n.Obj().Name()
		}
	}
	return ""
}

// exportedNames lists the exported package-level identifiers a file declares.
// Methods belong to their type, not to the package, so they are not exports.
func exportedNames(file *ast.File) []string {
	names := map[string]bool{}
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Recv == nil && d.Name.IsExported() {
				names[d.Name.Name] = true
			}
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.ValueSpec:
					for _, ident := range s.Names {
						if ident.IsExported() {
							names[ident.Name] = true
						}
					}
				case *ast.TypeSpec:
					if s.Name.IsExported() {
						names[s.Name.Name] = true
					}
				}
			}
		}
	}
	return sortedKeys(names)
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func sortedEdges(set map[edge]bool) []edge {
	out := make([]edge, 0, len(set))
	for e := range set {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].From != out[j].From {
			return out[i].From < out[j].From
		}
		return out[i].To < out[j].To
	})
	return out
}
