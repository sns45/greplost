//! The store module: a struct, its inherent impl, and a trait impl.

use crate::retry::Backoff;

/// A tiny in-memory store.
pub struct Store;

impl Store {
    /// Builds an empty store.
    pub fn new() -> Self {
        Store
    }

    /// Puts one value, through the private recorder.
    pub fn put(&self, n: i32) {
        self.record(n);
    }

    fn record(&self, _n: i32) {}
}

impl Backoff for Store {
    fn next(&self) -> u64 {
        0
    }
}
