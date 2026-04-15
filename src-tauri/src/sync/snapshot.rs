//! Periodic snapshot of an own log — compaction + fast bootstrap for new
//! peers. `Snapshot::{from_log, write_atomic, apply_peer}`. Populated in
//! Chunk 4 (read/write) and Chunk 8 (compaction triggers).
