package store

import "testing"

func TestPut(t *testing.T) {
	s := New("t")
	if err := s.Put("k", "v"); err != nil {
		t.Fatalf("put: %v", err)
	}
}
