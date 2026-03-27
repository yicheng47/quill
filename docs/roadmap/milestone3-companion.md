# Milestone 3 — Companion

Turn the AI reading assistant into a personalized companion powered by the persona engine.

## Architecture

- **Persona backend (private)** — stateful AI service that builds personality models from behavioral signals
- **Quill remains local-first** — all data stays in local SQLite + iCloud sync. Backend is an optional upgrade, not a dependency
- **Two backend endpoint types:**
  - AI endpoints — drop-in replacement for direct LLM calls, returns personalized responses
  - Signal collection — Quill pushes reading signals (highlights, notes, vocab, chats) for persona model updates

## Features

### Universal Cloud Sync
Bring your own cloud provider — let users choose where their library lives (iCloud, Google Drive, OneDrive, Dropbox, or any synced folder). Refactors the iCloud-specific storage code into a generic backend. Quill is the view layer; your cloud provider is the storage layer.

- **Status:** Planned
- **Issue:** [#74](https://github.com/yicheng47/quill/issues/74)
- **Spec:** [16 — Universal Cloud Sync](../features/16-universal-cloud-sync.md)
