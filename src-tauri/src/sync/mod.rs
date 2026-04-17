//! Per-device event-log sync engine (issue #185).
//!
//! Scaffolding grows chunk by chunk per `docs/impls/31-sync.md`. Keeping the
//! submodules present from the start lets callers and tests land
//! incrementally without a mega-PR.
//!
//! Chunk 5 wired `SyncWriter` through every mutating Tauri command. The
//! writer's `with_tx` enqueues events into `_pending_publish`, but the
//! flush-and-publish path stays inert until `set_log(Some(_))` is called —
//! that flip ships in Chunk 7 along with the settings UI. The replay
//! engine, snapshot module, migration routine, and fs-notify watcher are
//! also already implemented but not yet hooked up to the launch flow,
//! which is Chunk 6's job.
//!
//! Until those chunks land, several `pub` symbols inside this module are
//! reachable only from the `#[cfg(test)]` blocks. Rather than scatter
//! `#[allow(dead_code)]` across them — and have to thread it back out as
//! each call site lands — silence the lint module-wide. Removed in Chunk 7
//! once every symbol has a non-test caller.
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
