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

/// Rust's commonest self-import: `use super::*` inside a `#[cfg(test)]` child module names the
/// very file it is written in. The map drops a file's edge to itself, so truth must too.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_a_value() {
        let s = Store::new();
        s.put(1);
    }
}
