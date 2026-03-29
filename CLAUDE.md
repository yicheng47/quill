# Quill — Claude Code Instructions

## Stack

- **Backend:** Rust, Tauri 2, SQLite (rusqlite), WAL mode
- **Frontend:** React 19, TypeScript, Tailwind CSS 4, Vite, React Router
- **EPUB rendering:** foliate-js (git submodule in `/public/foliate-js/`)
- **i18n:** i18next + react-i18next (`src/i18n/en.json`, `src/i18n/zh.json`)
- **Icons:** lucide-react
- **CI:** GitHub Actions — `ci.yaml` (PR checks), `release.yml` (tag-triggered builds)

## Project Layout

```
src/                    # React frontend
  pages/                # Home, Reader
  components/           # UI components
    ui/                 # Primitives: Button, Input, Select, Slider, Toggle
    settings/           # Settings modal sections (one per tab)
  hooks/                # Custom hooks (useSettings, useBooks, useAiChat, etc.)
  contexts/             # React context providers
  i18n/                 # Translation JSON files
src-tauri/              # Rust backend
  src/commands/         # Tauri command modules
  src/ai/               # AI provider implementations
  migrations/           # SQL schema files (versioned)
docs/
  features/             # Feature specs (product-level)
  impls/                # Implementation plans (code-level, with Figma design prompts)
```

## Workflow

- **Planning:** For non-trivial features, write a detailed implementation plan to `docs/impls/<feature-name>.md` before coding. Include Figma design prompts (text-based) in the same file. Figma prompts should be high-level — describe intent, structure, and states, not pixel values. Let the design tool handle the details.
- **Feature specs** live in `docs/features/` — these are product-level; don't modify them during implementation.
- **Commits:** One commit per feature branch (amend), unless told otherwise.
- **Backend tests:** Write unit tests for new backend commands before moving to frontend.
- **Cargo.lock:** Run `cargo check` after version bumps to sync `Cargo.lock` before committing.
- **Version bumps & releases:** Commit directly to main (no PR needed). Tag with `v` prefix, push tag to trigger release CI.

## Skills (slash commands)

- `/release` — Bump version, tag, push, wait for CI, publish GitHub release with notes
- `/feature` — Create, list, or manage feature specs (`docs/features/`) and GitHub issues

## Conventions

- Settings are stored as key-value pairs in SQLite (`settings` table). Use `useSettings` hook on frontend, `commands/settings.rs` on backend.
- Sensitive data (API keys, OAuth tokens) goes in `secrets.db` (local-only, never syncs), not `quill.db`.
- All user-facing strings must use i18n keys — never hardcode English text in components.
- Settings modal sections follow the row pattern in `GeneralSettings.tsx`: 73px-tall rows, flex justify-between, 1px `black/10` dividers.
- AI streaming uses per-request event channels via Tauri event emitter.
