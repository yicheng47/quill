//! `ReplayEngine::tick()` — lists peer logs and snapshots, merges new events
//! sorted by `(ts, device)`, applies in one SQL transaction, advances
//! `_replay_state` watermarks. Populated in Chunk 4.
