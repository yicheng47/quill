# 14 — Notes (AI-Assisted)

**Issue:** [#70](https://github.com/yicheng47/quill/issues/70)
**Status:** Planned
**Milestone:** 2 — Depth

## Motivation

Highlights capture *what* matters. Notes capture *why* it matters — your reactions, questions, connections, and reflections. Right now Quill only has highlights (with optional short annotations). There's no dedicated space for longer-form thinking while reading.

Adding AI to notes serves two distinct purposes:

1. **Writing assistant** — fix grammar, improve flow, help you articulate half-formed thoughts without leaving the reader.
2. **Conversational thread** — the AI reads your note and responds, creating a dialogue *anchored to your reflection* rather than to the book text directly.

### Notes vs. Chat — how they differ

| | Chat | Note |
|---|---|---|
| **Primary voice** | AI — you ask, it answers | You — you write, AI assists |
| **Anchored to** | A book (optionally a selected passage) | A specific passage or location |
| **Artifact** | Conversation transcript | Your written reflection (persists as an annotation) |
| **AI role** | Responder / explainer | Editor and commenter |
| **Lifespan** | Session-oriented, can be deleted freely | Long-lived, part of your reading record |

A note is yours. The AI thread inside it is a reaction to *your* thinking, not a standalone Q&A. This keeps notes and chats complementary rather than overlapping.

## Scope

### Core note-taking

- Create a note from a text selection (like creating a highlight, but opens a writing area)
- Create a free-standing note at the current reading position (no selection required)
- Rich text editing — basic formatting (bold, italic, lists, headings) via a lightweight editor
- Notes are tied to a CFI position/range and belong to a book
- Notes visible in the sidebar alongside highlights and bookmarks
- Clicking a note in the sidebar navigates to its location in the book

### AI writing assistant

- **Polish** — select text within your note and ask AI to fix grammar and improve flow
- **Expand** — ask AI to help develop a rough thought into a fuller paragraph
- **Simplify** — ask AI to make a passage more concise
- These operate as inline transformations: the AI suggests a rewrite, you accept/reject/edit before it replaces your text
- Uses the current AI provider/model from settings

### AI conversational thread

- After writing a note, you can "ask the companion" — this opens a threaded conversation below the note
- The AI receives your note content + the highlighted passage as context
- AI responses appear as replies in the thread, visually distinct from your note body
- You can continue the conversation (multi-turn), but the note body remains your authored content above the thread
- Thread messages are stored separately from the note body (note text is never mixed with AI responses)

### Data model

- `notes` table: `id`, `book_id`, `cfi`, `cfi_text` (selected passage if any), `content` (user's note body), `created_at`, `updated_at`
- `note_threads` table: `id`, `note_id`, `role` (user | assistant), `content`, `model`, `created_at`
- Notes are distinct from highlights — a highlight is a marker with an optional short annotation; a note is a standalone written artifact

## Implementation Phases

### Phase 1 — Basic notes (no AI)
1. Design the `notes` table schema and add migration
2. Create Rust commands: `create_note`, `update_note`, `delete_note`, `get_notes_for_book`
3. Build the note editor UI (inline or panel) with basic rich text
4. Add "New note" action to text selection popover and reader toolbar
5. Display notes in the sidebar list (alongside highlights/bookmarks)
6. Navigate to note location on click

### Phase 2 — AI writing assistant
1. Add inline AI actions (polish, expand, simplify) to the note editor toolbar
2. Implement diff-style preview: show the AI suggestion alongside the original, accept/reject controls
3. Wire to existing AI provider infrastructure (reuse streaming + provider selection)

### Phase 3 — AI conversational thread
1. Add `note_threads` table and migration
2. Build the thread UI beneath the note body (visually separated)
3. Construct the system prompt: include the note body + passage context
4. Wire streaming responses (reuse SSE infrastructure from chat)
5. Support multi-turn conversation within the thread

## Open Questions

- Should notes support images/drawings, or text-only for now?
- Should AI writing suggestions use a lighter/faster model by default (e.g., Haiku) to keep the editing feel snappy?
- Should note threads share conversation context with the main book chat, or remain fully isolated?

## Verification

- [ ] Can create a note from text selection and from current position
- [ ] Note content persists across app restarts
- [ ] Notes appear in sidebar and navigate to correct location
- [ ] AI polish/expand/simplify produce inline suggestions with accept/reject
- [ ] AI thread appears below note body, visually distinct
- [ ] Thread receives note + passage as context
- [ ] Multi-turn thread conversation works with streaming
- [ ] Notes and chats remain separate — no data mixing
- [ ] Works with all configured AI providers (Ollama, Anthropic, OpenAI)