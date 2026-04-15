//! `SyncWriter::with_tx` — wraps a SQL transaction so every mutating command
//! writes its event alongside the row change under one fsync. Populated in
//! Chunk 5.
