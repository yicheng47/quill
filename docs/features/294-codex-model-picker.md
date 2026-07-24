# 294 — Model Picker with Live Model List for Codex Subscription Path

GitHub issue: https://github.com/yicheng47/quill/issues/294

## Motivation

In AI settings, the model field is a free-text input for every provider. On the OpenAI Codex-subscription path (OAuth), the valid model set is small and server-defined — free text invites typos and gives no discoverability, even though the field pre-fills with `gpt-5.3-codex`.

Codex CLI populates its model picker from `GET {base_url}/models?client_version=<ver>` — on the subscription path, `https://chatgpt.com/backend-api/codex/models` — using the same OAuth Bearer token + `chatgpt-account-id` header Quill already sends for chat requests (`src-tauri/src/ai/openai_responses.rs`). Response shape: `{ models: [{ slug, display_name, description, visibility, supported_reasoning_levels, ... }] }`. Quill can reuse this to offer a real model dropdown instead of free text.

## Scope

In scope:

- **OpenAI + OAuth path only:** replace the free-text model input in `AiSettings.tsx` with a dropdown of models fetched from the Codex `/models` endpoint — label = `display_name`, value = `slug`, filtered by `visibility`. Default stays `gpt-5.3-codex`.
- **Custom escape hatch:** a "Custom…" option in the dropdown reveals a text input, so newly shipped models are usable before Quill updates its fallback list.
- **Fallback + cache:** when the fetch fails or the account isn't connected yet, fall back to a small built-in model list. Cache the fetched list briefly (Codex CLI uses a ~5-minute TTL and a 5-second request timeout — mirror that).
- **Saved-value handling:** if the saved `ai_model` isn't in the fetched list, keep it selected (render as the Custom value) rather than silently switching models.

Out of scope:

- Other providers (API-key OpenAI, Anthropic, Ollama) keep the free-text input unchanged.
- Reasoning-effort presets from the models response (`supported_reasoning_levels`) — model slug selection only.

## Implementation Phases

1. **Backend:** `list_codex_models` Tauri command — GET the Codex `/models` endpoint with the stored OAuth credentials from `secrets.db`, short in-memory cache, bundled fallback list on error. Unit tests for response parsing, visibility filtering, and fallback behavior.
2. **Frontend:** in `AiSettings.tsx`, render a `Select` (+ Custom text input) for `provider === "openai" && authMode === "oauth"`, populated from the command; refetch on OAuth connect.
3. **i18n:** en/zh strings for the picker label, Custom option, and fetch-failed hint.

## Verification

- With a connected Codex subscription: the model row shows a dropdown listing the live catalog; picking a model and saving persists the slug to `ai_model` and chat requests use it.
- Disconnect network (or before OAuth login): dropdown still renders with the fallback list; no UI hang (5s timeout).
- Pick "Custom…", enter an arbitrary slug, save — persists and round-trips on reopen.
- Saved model not present in fetched list → shown as the Custom value, not silently replaced.
- API-key OpenAI, Anthropic, and Ollama paths still show the free-text input.
