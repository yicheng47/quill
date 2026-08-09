# 294 — Codex Model Card + Two-Tier Reasoning Effort

GitHub issue: https://github.com/yicheng47/quill/issues/294

## Motivation

Two gaps on the OpenAI Codex-subscription path, both in the same settings surface.

**Model is free text.** In AI settings the model field is a plain input for every provider. On the Codex OAuth path the valid model set is small and server-defined, so free text invites typos and offers no discoverability — the user has to already know that `gpt-5.3-codex` exists to type it. Codex CLI populates its own picker from `GET {base_url}/models?client_version=<ver>` — on the subscription path `https://chatgpt.com/backend-api/codex/models` — using the same OAuth Bearer token and `chatgpt-account-id` header Quill already sends for chat (`src-tauri/src/ai/openai_responses.rs`). The response carries `{ models: [{ slug, display_name, description, visibility, supported_reasoning_levels, … }] }`, which is everything a real picker needs.

**Reasoning effort is not controllable at all.** Every Quill call runs at whatever the server defaults to. That is the wrong shape for this app, because Quill's AI calls are not one workload — they are two. A dictionary lookup on a tapped word should come back fast; a chat turn, an explanation, or a translation is worth more thinking. Today both get identical treatment, so lookups feel sluggish and the deep paths can't be pushed harder.

Runner solved the presentation half of this in [PR #390](https://github.com/yicheng47/runner/pull/390): a combobox whose options carry `value` / `label` / `description`, an explicit `default` sentinel that emits no flag at all, and free-text passthrough so a newly shipped model is usable before the app knows about it. Quill should follow that pattern rather than invent a second one.

## Scope

In scope — **OpenAI + OAuth (Codex subscription) path only**:

- **Model card picker.** Replace the free-text model input with a dropdown populated from the Codex `/models` endpoint: label = `display_name`, secondary line = `description`, value = `slug`, filtered by `visibility`. Default stays `gpt-5.3-codex`.
- **Custom escape hatch.** A "Custom…" option reveals a text input so any slug remains typable. A saved `ai_model` that isn't in the fetched list stays selected and renders as the Custom value — never silently switched.
- **Fallback + cache.** On fetch failure or before OAuth connect, fall back to a small bundled list. Cache the fetched list briefly and bound the request, mirroring Codex CLI (~5-minute TTL, 5-second timeout).
- **Two reasoning-effort tiers**, each a separate setting with an "inherit server default" sentinel:
  - `ai_effort_quick` → `ai_lookup` and `ai_generate_title`
  - `ai_effort_deep` → `ai_chat`, `ai_explain`, and `translate`
- **Effort options come from the selected model.** Populate each tier's dropdown from that model's `supported_reasoning_levels`, falling back to the bundled union (`low / medium / high / xhigh / max / ultra`, the set Runner verified against codex-cli 0.146.0). A saved level the current model doesn't support stays visible rather than being silently coerced.
- **Request plumbing.** `openai_responses.rs::stream_chat` takes an effort argument and emits `reasoning: { effort }` in the body; when the tier is the default sentinel, the field is omitted entirely so behavior is byte-identical to today.
- i18n in `en.json` / `zh.json` for both pickers, the Custom option, the tier labels, and the fetch-failed hint.

Out of scope:

- Other providers. API-key OpenAI, Anthropic, and Ollama keep the free-text model input and send no reasoning field. Mapping tiers onto Anthropic thinking budgets is a separate question.
- A separate *model* per tier. One model, two efforts — splitting the model as well doubles the settings surface for a benefit nobody has asked for.
- Per-book, per-chat, or per-request effort overrides.

Assumption worth flagging: `ai_generate_title` is grouped into the quick tier. It is a one-line utility call on an existing conversation, so it belongs with lookup rather than with the paths the user is actually reading.

## Implementation Phases

1. **Backend — model list.** `list_codex_models` Tauri command: GET the Codex `/models` endpoint with the stored OAuth credentials from `secrets.db`, short in-memory cache, bundled fallback on error. Return `supported_reasoning_levels` alongside `slug` / `display_name` / `description` / `visibility` so the effort pickers can key off the selected model. Unit tests for response parsing, visibility filtering, cache TTL, and fallback.

2. **Backend — effort plumbing.** Add the effort argument to `stream_chat`; emit `reasoning: { effort }` only when set. Read `ai_effort_quick` in `ai_lookup` / `ai_generate_title` and `ai_effort_deep` in `ai_chat` / `ai_explain` / `translate` (`commands/ai.rs`, `commands/translation.rs`). Unit tests: body carries `reasoning` when a tier is set, and omits the key entirely on the default sentinel.

3. **Frontend — model card.** In `AiSettings.tsx`, render the model card dropdown (+ Custom input) when `provider === "openai" && authMode === "oauth"`, populated from the command and refetched on OAuth connect. Other providers keep the existing `Input`.

4. **Frontend — effort tiers.** Two rows below the model row, following the section's existing row pattern, with copy that says what each tier governs ("Lookup" vs "Chat, explain & translate"). Options filtered by the selected model's supported levels.

5. **i18n + QA.** All strings localized; verify in light and dark themes.

## Verification

- With a connected Codex subscription: the model row shows the live catalog with per-model descriptions; picking one persists the slug to `ai_model` and chat requests use it.
- Before OAuth login, or with the network down: the picker still renders from the bundled fallback and the UI does not hang (5s timeout).
- "Custom…" accepts an arbitrary slug, persists, and round-trips on reopen; a saved model absent from the fetched list shows as Custom rather than being replaced.
- Setting the quick tier changes only lookup and title-generation requests; setting the deep tier changes only chat, explain, and translate. Verified by inspecting the outgoing request bodies.
- With both tiers left at the default sentinel, request bodies contain no `reasoning` key — identical to pre-change behavior.
- Switching to a model with a narrower `supported_reasoning_levels` keeps the saved level visible instead of silently coercing it.
- API-key OpenAI, Anthropic, and Ollama paths are untouched: free-text model input, no reasoning field.
- All new strings localized in English and Chinese.
