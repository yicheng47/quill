//! Per-device event-log sync engine (issue #185).
//!
//! Scaffolding grows chunk by chunk per `docs/impls/31-sync.md`. Keeping the
//! submodules present from the start lets callers and tests land
//! incrementally without a mega-PR.
//!
//! `dead_code` is silenced module-wide until Chunk 5 wires `SyncWriter` into
//! the command layer; at that point every symbol has a caller and this
//! allow can be removed.
#![allow(dead_code)]

pub mod device;
pub mod events;
pub mod log;
pub mod merge;
pub mod migration;
pub mod replay;
pub mod snapshot;
pub mod watcher;
pub mod writer;
