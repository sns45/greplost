//! The `tiny` binary: the smallest crate that exercises every Rust rule.

mod retry;
mod store;

use store::Store;

fn main() {
    let s = Store::new();
    s.put(1);
    retry::run();
}
