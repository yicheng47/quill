# 358 — Codex Model and Effort per AI Feature

GitHub issue: https://github.com/yicheng47/quill/issues/358

Design: `quill/desktop/specs/358-per-feature-ai-models.pen` in `YeelinksCo/yeelinks_design`, signed off by Jason on 2026-11-19. The chosen frames are `358 / Settings — AI · Codex, per-feature models (chosen: B)` (`YCWsJ`), `358 / Models — B · One picker per feature (chosen)` (`M72h1`, open menu `x0TOu`), and `358 / Composer — 1 · Picker in the footer line (chosen)` (`NdKzl`: Ask Quill island `XkhJu` with open menu `P5a0d`, Chats view `qMpFS`). The file also keeps today's 2.0 Settings screen (`dOWfE`) for reference.

## Motivation

The Codex connection sends one model, `ai_model`, on every AI call, and two effort tiers from #294 split the calls: `ai_effort_quick` covers Look up and chat titles, and `ai_effort_deep` covers Chat, Explain and Translate. The features want different trade-offs. A lookup should come back fast from a small model, an explanation is worth a mid-size model thinking hard, and a chat deserves the largest model. Quill cannot run Look up on luna while Explain runs on terra, and Explain's effort is tied to Chat's.

#294 left "a separate model per tier" out of scope because nobody had asked for it. This feature brings it in, as one model and one effort per feature instead of per tier.

## Scope

In scope, **Codex connection only**:

- **One row per feature.** In `Settings → AI Assistant → Models`, the single model row and the two effort rows become four feature rows: Look up, Explain, Chat, Translate. Each row keeps the settings-row pattern and has one picker labelled with the model and reasoning together, such as "GPT-6.1 Terra · High". Its menu has a Model section (Default, the live catalog, Custom…) and a Reasoning section (Default with the level it resolves to, then the levels that row's model supports). Chat titles follow Look up and get no row.
- **Defaults by model family**, used when a feature has no saved choice and no carried-over value:

  | Feature | Model family | Effort |
  |---|---|---|
  | Look up (and chat titles) | luna | low |
  | Explain | terra | high |
  | Chat | sol | high |
  | Translate | terra | medium (proposed) |

  A family resolves against the live catalog to the first catalog model whose slug ends in `-<family>`. The catalog lists newest first, so today luna is `gpt-6-luna`, terra is `gpt-6.1-terra` and sol is `gpt-6.2-sol`, and a newer model of the family is picked up without a release. When the catalog has no model of the family, the catalog default model is used. When the model does not support the default effort, that model's own default effort is used.
- **Chat model picker in the composer's model line.** The reader's Ask Quill island (`src/components/AiPanel.tsx`) already prints the model and effort under the composer (`formatAiModelFooter`); on the Codex connection that line becomes the picker, and the Chats view (`src/components/ChatsView.tsx`) gets the same line under its composer. The menu opens upward with the same Model and Reasoning sections as the Settings Chat row, plus a note that it also changes Chat in `Settings → AI`. It reads and writes the Chat setting, so a change applies to every chat from then on, including the chat that is open. On API connections the island keeps today's passive line and the Chats view shows none.
- **Carry-over from 2.0.** A saved `ai_model` and saved `ai_effort_quick` / `ai_effort_deep` keep applying to each feature until the user changes that feature's row: a value the user chose is never replaced by a new default.
- i18n for every new string in `en.json` and `zh.json`.

Out of scope:

- API key and Ollama connections. They keep one `ai_model` and send no effort.
- Remembering a model per chat. It needs a new chats column, a migration and a sync-event change, and the composer picker covers the need without it.
- Per-book overrides.

### Settings keys

Each feature gets two keys in the local `settings` table, which does not sync: `ai_codex_model_<feature>` and `ai_codex_effort_<feature>`, for `lookup`, `explain`, `chat` and `translate`. An empty value or `default` means "not chosen". No schema migration is needed.

A Codex call resolves its model and effort in this order:

1. **Model:** `ai_codex_model_<feature>`, then a non-empty legacy `ai_model`, then the feature's family default, then the catalog default.
2. **Effort:** `ai_codex_effort_<feature>`, then the legacy tier (`ai_effort_quick` for Look up, `ai_effort_deep` for the others), then the feature's default effort, then the model's default effort. A chosen effort the resolved catalog model does not support falls through to the next step, as `resolve_model_and_effort` does today. A custom model outside the catalog passes the chosen effort through unchanged.

Calls map to features as `lookup` and `generate_title` → `lookup`, `explain` → `explain`, `chat` → `chat`, `translate` → `translate`.

## Implementation Phases

1. **Backend resolution.** Replace `effort_tier_key` (`crates/quill-core/src/commands/ai.rs`) with a call-to-feature map. `load_connection` (`crates/quill-core/src/ai/dispatch.rs`) reads the feature's keys plus the legacy ones and passes them on in `TurnSpec`, together with the feature's default family and effort. `resolve_model_and_effort` (`crates/quill-core/src/ai/codex/mod.rs`) applies the order above against the catalog. The existing `codex: turn model=… effort=…` log line records the result. Unit tests: every call maps to its feature, each precedence step wins over the next, the family resolves to the newest catalog match and falls back to the catalog default, an unsupported effort falls through, and a custom model passes its effort through.
2. **Shared catalog hook.** Move the `list_codex_models` fetch out of `AiSettings.tsx` into a hook that Settings and both composers use, so the catalog is fetched once per session and every picker agrees on the defaults.
3. **Settings rows.** Replace the Codex model row and the two effort rows in `AiSettings.tsx` with the four feature rows from frame `YCWsJ`, using the 73px row pattern. Each row's single picker opens the two-section menu from `x0TOu`. An unchosen row's label shows the resolved values, and the menu marks Default as chosen; picking Default clears that key. The API branch is not changed. Component tests cover default display, saving a model, saving a reasoning level, clearing to Default, and the custom model path.
4. **Composer picker.** Turn the island's model line into the picker from `NdKzl` and add the same line under the Chats view composer, writing the Chat keys. Changing it in one place updates the other and the Settings row. Component tests cover the write and the passive line on API connections.
5. **i18n**, then the live checks below.

## Verification

Automated:

- The Rust unit tests from phase 1 and the component tests from phases 3 and 4 pass, with `make typecheck`, `make lint`, `npm test` and `cargo test -p quill-core`.

Live checks, required because the change alters what a person sees and operates in Settings and the chat composers. They run in the development app on the Codex connection, with one tiny prompt per call:

| Check | What it verifies | Reason |
|---|---|---|
| F-1 | With no per-feature keys and no legacy values, the four Settings rows show the family defaults resolved from the live catalog. | The Models section and its default display are new. |
| F-2 | A Look up, an Explain, a Translate and a chat reply each log `codex: turn model=… effort=…` with their own feature's model and effort, and the chat title call logs Look up's. | The per-call resolution changed for every entry point. |
| F-3 | Changing one feature's row changes only that feature's next logged turn, and the choice survives reopening Settings and relaunching. | Each row writes its own keys. |
| F-4 | Changing the model and the reasoning in the Ask Quill island's model line updates the Chats view line and the Settings Chat row, and the next chat turn logs the new model and effort. | The composer picker is new and shares the Chat setting. |
| AI-01, AI-02, AI-03, AI-04 | Look up, Explain, Translate and chat still stream and finish. | Their request path now resolves model and effort per feature. |
| AI-06 (API part only) | An API-key connection still shows its single model row and no effort rows. | The Models section is reworked and its API branch must stay as it was. |

The checks keep iCloud sync off. The carry-over order is covered by the Rust unit tests rather than a live check, because it is pure resolution logic.
