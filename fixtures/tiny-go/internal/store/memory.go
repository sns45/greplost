package store

// NewMemory builds a Store under the default name.
func NewMemory() *Store {
	return New(DefaultName)
}
