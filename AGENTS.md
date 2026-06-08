# Quill Agent Guide

This file is the repo-wide guide for any coding assistant working on Quill. Keep shared conventions here instead of putting them only in a tool-specific file such as `CLAUDE.md`.

## Product Context

Quill is an AI-powered desktop ebook reader. It focuses on reading EPUB/PDF books, preserving a local library, and augmenting reading with AI lookup, explanations, translation, vocabulary, bookmarks, highlights, collections, and cross-device sync.

Core vocabulary:

- **Book**: a library item backed by an EPUB or PDF file.
- **Reader**: the reading surface for a book, including progress, layout, highlights, bookmarks, and AI panels.
- **Library**: the local SQLite materialized view plus book/cover blobs under the active data directory.
- **Sync**: iCloud-backed event-log sync for library state and shared book/cover files.
- **MCP**: Quill's local MCP server/client integration surface for AI tools to inspect or modify the library.

## Stack

- Frontend: React 19, TypeScript, Tailwind CSS 4, Vite, React Router.
- Desktop/backend: Tauri 2, Rust, SQLite via `rusqlite`.
- Reader engine: `foliate-js` under `public/foliate-js`.
- Sync: iCloud container files, append-only event logs, snapshots, and watcher-driven replay.
- AI: OpenAI-compatible providers plus OAuth-backed OpenAI support.

## Project Map

- `src/`: React frontend.
- `src/components/`: shared UI, reader controls, settings, and library components.
- `src/components/settings/`: settings modal sections.
- `src/components/ui/`: common UI primitives.
- `src/pages/`: route-level screens such as library, reader, chats, vocabulary, and translations.
- `src/hooks/`: frontend data hooks and command wrappers.
- `src/i18n/`: translation JSON files.
- `src-tauri/src/commands/`: Tauri command handlers exposed to the frontend.
- `src-tauri/src/sync/`: iCloud sync engine, event log, peer manifests, replay, snapshots, and writer.
- `src-tauri/src/mcp/`: MCP server and tools.
- `src-tauri/src/ai/`: AI provider integrations.
- `public/foliate-js/`: vendored reader engine submodule.
- `design/`: Pencil source files, including `design/quill-desktop.pen`.
- `docs/arch/`: architecture references.
- `docs/features/`: in-progress feature specs; shipped specs live in `docs/features/archive/`.
- `docs/impls/`: implementation plans; shipped plans live in `docs/impls/archive/`.
- `docs/guide/` and `docs/roadmap/`: user-facing guides and product planning notes.

## Development Commands

- Install deps: `pnpm install`.
- Start frontend dev server: `pnpm dev`.
- Start Tauri app in dev: `pnpm tauri dev`.
- Frontend typecheck: `pnpm exec tsc --noEmit`.
- Frontend lint: `pnpm run lint`.
- Frontend build: `pnpm build`.
- Rust check: `cd src-tauri && cargo check`.
- Rust tests: `cd src-tauri && cargo test`.
- Rust lint: `cd src-tauri && cargo clippy -- -D warnings`.
- Package desktop app: `pnpm run package`.

Prefer the smallest check that covers the change. For frontend changes, run typecheck and lint. For Rust behavior, run the relevant `cargo test` target; for sync changes, run sync-focused tests before broadening.

## Engineering Conventions

- Follow existing local patterns before adding new abstractions.
- Keep changes scoped to the request. Avoid unrelated refactors.
- Do not revert user changes. If the working tree is dirty, inspect first and preserve unrelated edits.
- Use structured APIs and parsers when available instead of ad hoc string manipulation.
- Keep comments rare and useful. Explain non-obvious intent, not mechanics.
- Keep UI aligned with `design/quill-desktop.pen` when a node or frame is referenced by the user.
- Keep `src/i18n/en.json` and `src/i18n/zh.json` in sync when adding user-facing strings.
- Treat sync and file-copy changes as data-safety sensitive. Preserve the invariant that the app must not repoint storage or disable sync until required local files are actually reachable.
- Do not add repo conventions only to an agent-specific file. Update this file and leave tool-specific files as compatibility entrypoints if needed.

## Commit And PR Conventions

- Use focused commits with an imperative subject.
- Common scopes: `sync`, `commands`, `reader`, `library`, `settings`, `ai`, `mcp`, `ui`, `docs`, `release`.
- Example: `fix(sync): keep status reads off the webview thread`.
- Keep PR descriptions current when scope changes.
- Do not add tool-specific co-author trailers unless the user explicitly asks.

## Notes For Agent Runtimes

This repository is intentionally agent-agnostic. Claude Code, Codex, or any other assistant should read `AGENTS.md` as the shared guide. Portable workflow skills live under `.agents/skills`. Tool-specific instruction/config files may exist only as compatibility entrypoints and should point back here when they contain shared guidance.
