//! Per-device event-log sync engine (issue #185).
//!
//! Scaffolding only — submodules are empty stubs here; each will be filled
//! out in its own chunk per `docs/impls/31-sync.md`. Keeping them present
//! from the start lets callers and tests land incrementally without a
//! mega-PR.

pub mod device;
pub mod events;
pub mod log;
pub mod merge;
pub mod migration;
pub mod replay;
pub mod snapshot;
pub mod watcher;
pub mod writer;
