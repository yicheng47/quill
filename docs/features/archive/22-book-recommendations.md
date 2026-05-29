# 22 — AI Book Recommendations

GitHub Issue: https://github.com/yicheng47/quill/issues/106

## Motivation

Readers often finish a book and wonder "what should I read next?" Quill already knows what books the user owns, what they've finished, and what genres they gravitate toward. By feeding this library context to the AI, Quill can suggest new books tailored to the user's taste — turning the app from a reader into a reading companion.

## Scope

### In Scope

1. **Library-based recommendations** — AI analyzes the user's existing library (titles, authors, genres, descriptions, reading status) to suggest books they might enjoy.
2. **Discover tab** — A new top-level tab/page in the app where recommendations are displayed.
3. **Recommendation cards** — Each recommendation shows: title, author, genre, and a short description of why the AI thinks the user would like it.
4. **Refresh/regenerate** — User can request new recommendations at any time.
5. **Discovery settings** — A new section in Settings to configure recommendation behavior:
   - Enable/disable discovery
   - Preferred recommendation language
   - Genres to exclude (e.g., user doesn't want horror recommendations)
   - Number of recommendations per request (e.g., 5, 10, 15)
6. **Reading status awareness** — The AI should weigh finished books more heavily (confirmed taste) and consider the user's current reads for variety.

### Out of Scope

- Actionable links (buy/download) — informational only for now.
- Social recommendations (based on what other Quill users read).
- Automatic/push recommendations (only generated on user request or tab visit).
- Caching recommendations across sessions (can be added later).

## UX Flow

1. User navigates to the "Discover" tab.
2. If first visit (or no cached recommendations), app shows a loading state and calls the AI.
3. AI returns a list of book recommendations with metadata and reasoning.
4. Recommendations display as cards in a grid or list layout.
5. User can click "Refresh" to get new suggestions.
6. Discovery settings accessible from the Discover tab or Settings modal.

## AI Prompt Design

Input to the AI:
- User's library: `{ title, author, genre?, description?, status, progress }`
- Discovery settings: excluded genres, preferred language, count
- Instruction to return structured JSON:
  ```json
  {
    "recommendations": [
      {
        "title": "The Left Hand of Darkness",
        "author": "Ursula K. Le Guin",
        "genre": "Science Fiction",
        "reason": "Based on your interest in speculative world-building from your collection of Asimov and Herbert novels."
      }
    ]
  }
  ```
- Guidelines: avoid recommending books already in the library; diversify across genres unless the user's library is very focused; give specific, personalized reasons (not generic blurbs).

## Implementation Phases

### Phase 1: Backend Command & Settings

- Add discovery settings to the settings table:
  - `discovery_enabled` (bool, default true)
  - `discovery_language` (string, default follows UI locale)
  - `discovery_excluded_genres` (JSON array, default empty)
  - `discovery_count` (int, default 10)
- Add a new Tauri command `ai_recommend_books(db, secrets, app)` that:
  1. Reads the user's library metadata and discovery settings.
  2. Builds a prompt with library context and preferences.
  3. Calls the AI provider (non-streaming, structured JSON response).
  4. Parses and returns the recommendations.
- Handle: no AI configured, empty library, API failure, malformed response.

### Phase 2: Discover Tab

- Add a new "Discover" route/page to the frontend.
- Add navigation to the Discover tab (sidebar or top nav).
- Display recommendation cards with: title, author, genre, personalized reason.
- Loading state while AI generates recommendations.
- "Refresh" button to regenerate.
- Empty state for: no AI configured, discovery disabled, empty library.

### Phase 3: Discovery Settings

- Add a "Discovery" section to the Settings modal.
- Toggle to enable/disable discovery.
- Language preference selector.
- Genre exclusion list (multi-select or tag input).
- Recommendation count selector.
- Follow the existing settings row pattern (73px rows, flex justify-between, 1px dividers).

### Phase 4: Polish

- Cache last recommendations in memory so switching tabs doesn't re-fetch.
- Consider persisting recommendations to SQLite for offline access.
- Add i18n keys for all Discover tab and settings strings.
- Handle large libraries: summarize or sample if token limits are a concern.

## Verification

- [ ] Discover tab is accessible from main navigation.
- [ ] AI returns valid book recommendations based on library content.
- [ ] Recommendation cards display title, author, genre, and personalized reason.
- [ ] Recommendations do not include books already in the user's library.
- [ ] "Refresh" generates a new set of recommendations.
- [ ] Discovery settings (enable/disable, language, excluded genres, count) are saved and respected.
- [ ] Works with all supported AI providers.
- [ ] Graceful handling: no AI configured, empty library, API error.
- [ ] All strings use i18n keys.
- [ ] Settings section follows the existing row pattern.
