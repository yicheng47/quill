# Milestone 2 — Depth

Deepen the reading experience. Make the assistant feel like a persistent study companion, not a stateless chatbot.

---

## Features

### Chat persistence
Save and restore AI chats per book. Multiple chat threads per book, each message retains the highlighted passage that triggered it.

- **Status:** Complete

### Auto-update & migration
In-app auto-update via Tauri updater plugin, plus a version-tracked DB migration system to ensure schema changes are safe across updates.

- **Status:** Planned
- **Issue:** [#45](https://github.com/yicheng47/quill/issues/45)

### Internationalization (i18n)
Externalize all UI strings, add language switcher (English / 简体中文), adapt AI responses to the user's preferred language.

- **Status:** Planned
- **Issue:** [#44](https://github.com/yicheng47/quill/issues/44)

### Translation
Bilingual word lookup — when reading in a foreign language, the AI includes a native-language translation alongside the definition. Powered by the user's language setting.

- **Status:** Planned

### Notes (AI-Assisted)
Rich note-taking tied to books — capture thoughts, annotations, and reflections beyond simple highlights. AI serves as a writing assistant (grammar, flow, expansion) and can respond to notes in a conversational thread, creating a dialogue anchored to the user's reflection rather than a standalone Q&A.

- **Status:** Planned
- **Issue:** [#70](https://github.com/yicheng47/quill/issues/70)
- **Spec:** [14 — Notes](../features/14-notes.md)

### Onboarding
Simple first-launch flow guiding new users to set up their AI provider in Settings.

- **Status:** Planned

### Region screenshot for AI
Capture a selected region of the page (screenshot crop) and send it to the AI assistant as an image. Useful for magazines and image-heavy PDFs where text selection is unreliable and photos/diagrams can't be copied. The user draws a rectangle over the reader area, the captured image is attached to the AI chat as context.

- **Status:** Planned

### User profile in sidebar + Settings modal
Move settings access to a bottom-left user avatar section (name + initials). Replaces the current settings gear, prepares the local user identity for Milestone 3 persona engine integration. Settings become a ChatGPT-style modal dialog instead of a full page.

- **Status:** Planned
- **Issue:** [#59](https://github.com/yicheng47/quill/issues/59)
