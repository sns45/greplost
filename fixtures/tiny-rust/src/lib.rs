//! The `tiny` library crate: a module tree, one named re-export and one glob re-export.

mod retry;
pub mod store;

pub use crate::store::Store;
pub use self::retry::*;
