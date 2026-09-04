//! Retry helpers, plus the trait whose dispatch is deliberately dropped.

use crate::store::Store;

/// Runs the tiny job once.
pub fn run() {}

const ATTEMPTS: u8 = 3;

/// How long to wait before the next attempt.
pub trait Backoff {
    fn next(&self) -> u64;
}

/// A generic receiver: trait-dispatched, so `t.next()` is dropped, never guessed.
pub fn poll<T: Backoff>(t: T) -> u64 {
    t.next()
}

/// A `dyn` receiver: also trait-dispatched, also dropped.
pub fn poll_dyn(b: &dyn Backoff) -> u64 {
    b.next()
}

/// A concrete receiver, declared by the parameter's own type: this one resolves.
pub fn warm(s: &Store) -> u64 {
    s.put(ATTEMPTS as i32);
    0
}
