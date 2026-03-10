# AI Lookup

**Version:** 0.3
**Date:** March 10, 2026
**Status:** Design
**Replaces:** 02-ai-quick-explain

---

## 1. Motivation

The current Quick Explain feature gives a brief contextual explanation in 2–3 sentences. While useful, it's often not enough — users want to understand a word's meaning at a glance (like a dictionary) *and* understand why the author used it in context.

**AI Lookup** replaces Quick Explain with a two-part response: a dictionary-style definition first, followed by a contextual explanation. This mirrors the natural reading workflow: "What does this word mean?" → "Why is it used here?"

---

## 2. What Changes

### 2.1. Renamed Throughout

- Menu item: "Quick Explain" → **"Look Up"**
- Event channel: `ai-quick-explain-chunk` → `ai-lookup-chunk`
- Tauri command: `ai_quick_explain` → `ai_lookup`
- Component: `QuickExplainPopover` → `LookupPopover`
- Popover title: "Quick Explain" → **"Look Up"**

### 2.2. New Response Format

The AI now returns a structured two-part answer:

```
┌─────────────────────────────────────────────┐
│  📖 Look Up                              ✕  │
│─────────────────────────────────────────────│
│                                             │
│  **ephemeral** /ɪˈfɛm(ə)rəl/ · adjective  │
│  Lasting for a very short time; transient.  │
│                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                             │
│  Here, the author describes the character's │
│  joy as ephemeral to foreshadow its loss —  │
│  the happiness is real but already passing. │
│                                             │
└─────────────────────────────────────────────┘
```

**Part 1 — Dictionary definition:**
- Word, pronunciation (IPA if possible), part of speech
- One-line definition, clear and concise

**Part 2 — Contextual explanation:**
- Why the author chose this word in this specific passage
- Tone, connotation, or literary significance if relevant

### 2.3. Popover Width

Increased from 320px to 360px to accommodate the slightly longer response.

---

## 3. Technical Changes

### 3.1. System Prompt

Replace the current Quick Explain prompt with:

```
You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants to understand it.

Respond in two parts:

1. **Definition** — Give a dictionary-style entry: the word, pronunciation in IPA (if it's an English word), part of speech, and a concise definition in one sentence.

2. **In context** — Explain how the word is used in the given passage. Consider the author's intent, tone, or any literary/idiomatic significance. Keep it to 2–3 sentences.

If the selection is a proper noun (person, place, historical event), replace the dictionary definition with a brief factual identification, then explain its relevance in context.

Do not use headers or labels like "Definition:" or "In context:". Separate the two parts with a line break. Be concise.
```

### 3.2. Backend Command

Rename `ai_quick_explain` → `ai_lookup` in `commands/ai.rs`:

- Same signature: `word`, `sentence`, `book_title`, `chapter`, `app`, `db`
- Same streaming pattern, same `max_tokens: 256`
- Changed event name: `ai-lookup-chunk`
- Updated system prompt as above

### 3.3. Frontend

| File | Change |
|------|--------|
| `src/components/ReaderContextMenu.tsx` | Rename prop `onQuickExplain` → `onLookup`, menu label → "Look Up" |
| `src/components/QuickExplainPopover.tsx` | Rename to `LookupPopover.tsx`, listen on `ai-lookup-chunk`, invoke `ai_lookup`, title → "Look Up" |
| `src/pages/Reader.tsx` | Update state name, handler name, component reference |

---

## 4. Migration Notes

This is a breaking rename of the Tauri command. The old `ai_quick_explain` command and `ai-quick-explain-chunk` event are removed — no backwards compatibility needed since this is a desktop app with no external API consumers.

---

## 5. Edge Cases

All edge cases from Quick Explain (02) still apply:
- Long paragraph trimming (500 char limit around selection)
- Cross-element selection fallback
- Concurrent with AI panel chat (separate event channel)
- Provider errors shown inline

New consideration:
- **Phrases and idioms:** The prompt handles multi-word selections naturally — Part 1 defines the phrase as a unit, Part 2 explains contextual usage.
- **Proper nouns:** The prompt explicitly handles names, places, and events with factual identification instead of a dictionary entry.
