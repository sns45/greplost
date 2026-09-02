// Package store keeps values in memory.
package store

import "example.com/tiny/internal/retry"

// DefaultName names the store built by NewMemory.
const DefaultName = "default"

// ErrClosed is returned once the store is closed.
var ErrClosed = errorString("store closed")

// Putter accepts values.
type Putter interface {
	Put(key string, value string) error
}

// Store is an in-memory key/value store.
type Store struct {
	Name string
	data map[string]string
}

type errorString string

func (e errorString) Error() string {
	return string(e)
}

// New builds an empty Store.
func New(name string) *Store {
	return &Store{Name: name, data: map[string]string{}}
}

// Put stores one value, retrying until it sticks.
func (s *Store) Put(key string, value string) error {
	return retry.Do(retry.DefaultAttempts, func() error {
		s.set(key, value)
		return nil
	})
}

func (s *Store) set(key string, value string) {
	s.data[key] = value
}
