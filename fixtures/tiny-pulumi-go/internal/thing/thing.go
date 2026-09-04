// Package thing is the fixture's decoy: a constructor that looks exactly like a
// Pulumi resource constructor and is not one.
//
// `NewThing(ctx, "x", &ThingArgs{})` has the shape spec 3.6 describes, down to the
// `Args` struct and the string name, but nothing here comes from a Pulumi provider
// SDK and `Thing` implements no Pulumi interface. Both the signal pass (which asks
// where the package identifier was imported from) and the `go/types` oracle (which
// asks what the call's result type implements) must ignore it, and for different
// reasons; that is what makes it worth having.
package thing

// ThingArgs is the decoy's argument struct.
type ThingArgs struct {
	// Name is an ordinary field, so the decoy has one to read.
	Name string
}

// Thing is the decoy's result.
type Thing struct {
	// Name is what the constructor was called with.
	Name string
}

// NewThing builds a Thing. `ctx` is `any` on purpose: this package must not import
// Pulumi at all, or the fixture would stop proving that the import path is what the
// rule reads.
func NewThing(ctx any, name string, args *ThingArgs) *Thing {
	_ = ctx
	if args != nil && args.Name != "" {
		return &Thing{Name: args.Name}
	}
	return &Thing{Name: name}
}
