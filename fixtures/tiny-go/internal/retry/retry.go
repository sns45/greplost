// Package retry runs an operation until it succeeds.
package retry

// DefaultAttempts is how many times Do tries by default.
const DefaultAttempts = 3

// Do runs op until it returns nil or attempts run out.
func Do(attempts int, op func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		err = op()
		if err == nil {
			return nil
		}
	}
	return err
}
