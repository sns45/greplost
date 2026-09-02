// Package main wires the tiny fixture together.
package main

import (
	"fmt"

	"example.com/tiny/internal/retry"
	"example.com/tiny/internal/store"
)

func main() {
	s := store.New("memory")
	err := retry.Do(retry.DefaultAttempts, func() error {
		return s.Put("key", "value")
	})
	fmt.Println(s.Name, err)
}
