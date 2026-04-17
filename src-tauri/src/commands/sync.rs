//! Sync commands exposed to the frontend.
//!
//! Chunk 6 ships only `sync_now` — the manual "pull peer changes right
//! now" button. Chunk 7 will add `sync_status`, `sync_enable`, and
//! `sync_disable` alongside the new settings UI.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::replay::{ReplayEngine, ReplayReport};

/// JSON-friendly mirror of `ReplayReport`. We keep it explicit (rather
/// than deriving Serialize on `ReplayReport` directly) so internal
/// renames don't leak into the wire shape.
#[derive(Debug, Serialize)]
pub struct SyncNowResult {
    pub outbox_flushed: usize,
    pub snapshots_applied: usize,
    pub events_applied: usize,
    pub peers_seen: usize,
}

impl From<ReplayReport> for SyncNowResult {
    fn from(r: ReplayReport) -> Self {
        Self {
            outbox_flushed: r.outbox_flushed,
            snapshots_applied: r.snapshots_applied,
            events_applied: r.events_applied,
            peers_seen: r.peers_seen,
        }
    }
}

/// Run one replay tick on demand. Surfaces a structured report so the
/// settings UI can show "applied N events from M peers" feedback.
///
/// Returns a clear error if sync isn't enabled — Tauri state has no
/// `Arc<ReplayEngine>` until launch wires one up after a successful
/// migration. The frontend treats this as "press Enable Sync first"
/// rather than a hard failure.
#[tauri::command]
pub fn sync_now(
    db: State<'_, Db>,
    engine: State<'_, Option<Arc<ReplayEngine>>>,
) -> AppResult<SyncNowResult> {
    // Clone the Arc out of state so we don't hold a temporary borrow
    // across the SQL lock acquisition below.
    let engine: Arc<ReplayEngine> = match engine.as_ref() {
        Some(e) => Arc::clone(e),
        None => {
            return Err(AppError::Other(
                "sync is not enabled on this device".into(),
            ))
        }
    };
    let mut conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
    let report = engine.tick(&mut conn)?;
    Ok(report.into())
}
