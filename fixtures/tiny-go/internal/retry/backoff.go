package retry

import (
	"time"

	_ "sort"
)

// Backoff waits a fixed delay between attempts.
type Backoff struct {
	Delay time.Duration
}

// Wait sleeps for the configured delay.
func (b *Backoff) Wait() {
	time.Sleep(b.Delay)
}
