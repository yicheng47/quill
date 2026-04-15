//! Deterministic merge rules — `apply_event(tx, event)` folds one peer event
//! into the local SQLite materialized view. LWW on updates, tombstone-guarded
//! INSERT OR IGNORE on adds. Populated in Chunk 4.
