# Milestone 3 — Companion

Turn the AI reading assistant into a personalized companion powered by the persona engine.

## Architecture

- **Persona backend (private)** — stateful AI service that builds personality models from behavioral signals
- **Quill remains local-first** — all data stays in local SQLite + iCloud sync. Backend is an optional upgrade, not a dependency
- **Two backend endpoint types:**
  - AI endpoints — drop-in replacement for direct LLM calls, returns personalized responses
  - Signal collection — Quill pushes reading signals (highlights, notes, vocab, chats) for persona model updates

## Features

TBD — builds on the local user profile introduced in Milestone 2.
