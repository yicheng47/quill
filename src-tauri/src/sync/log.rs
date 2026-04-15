//! Append-only JSONL log per device, owned by `EventLog`. Handles ULID
//! generation, line framing, fsync, and (on macOS) NSFileCoordinator-wrapped
//! appends into the iCloud ubiquity container. Populated in Chunk 3.
