# 369 — Unified Explain & New Vocab System (Offline Dictionaries, Lemmatization, Chinese Integration)

GitHub issue: https://github.com/yicheng47/quill/issues/369 (supersedes https://github.com/yicheng47/quill/issues/259)

Design: `quill/desktop/specs/369-unify-lookup-explain.pen` in `YeelinksCo/yeelinks_design`, signed off by Jason on 2026-11-22 (**Adaptive M1 + C1-B Smart Lens + P1 + W1 + S1**, with built-in + user-imported dictionaries, lemmatization, multi-encounter Vocab entries, `Words → Vocab` rename, and updated Settings IA). Key frames: `369 / 01 · Selection Menu — Single Adaptive Row` (`G76QzL`), `369 / 01b · Chosen Icon — Smart Lens (C1-B Open-Rim Star)` (`V50ckK`), `369 / 02 · Unified Popover — Dictionary + Lemma + AI Context & Edge States (P1 Chosen)` (`ioX1r`), `369 / 03 · Vocab Grouping (W1 Chosen vs W2) & Book Vocab Search` (`Y4Vmu`), `369 / 03b · Vocab — Canonical Lemma, Full Dictionary & Multi-Passage Encounters` (`PZLxf`), `369 / 03c · Vocab — Chinese Entry Detail (潜移默化)` (`GcgWf`), `369 / 04a · Settings — Dictionary (New Tab under TOOLS)` (`Lwfaf`), `369 / 04b · Settings — Look Up & Translate (under TOOLS)` (`NpCRQ`), `369 / 04c · Settings — AI Assistant Models under INTEGRATIONS (S1 Chosen vs S2)` (`s2AAh`), and `369 / 05 · Ember Dark Mode — Menu & Unified Popovers` (`GIJYC`).

## Motivation

Quill's selection lookup and saved vocabulary have four tightly linked gaps that make vocabulary building feel second-class compared to dedicated e-readers:

1. **Redundant menu split:** `ReaderContextMenu` shows **Look Up** (`wordCount <= 5`) and **Explain** side by side, forcing readers to choose between two near-synonymous buttons while breaking on CJK selections that have no whitespace word boundaries.
2. **LLM-only definitions instead of real offline dictionaries:** Word lookups wait on an LLM call, fail offline or without AI configured, only return a single improvised gloss instead of an authoritative multi-sense dictionary entry, and give readers no way to import their own dictionaries (StarDict / MDict).
3. **No lemmatization or canonical Vocab deduplication:** Looking up `mortified`, `mortifying`, and `mortify` saves three separate rows instead of resolving inflected English forms to the canonical lemma (`mortify`), checking whether `mortify` is already in Vocab, showing one full dictionary entry for all senses, and attaching each reading passage + LLM contextual note underneath.
4. **English-centric Vocab UX, naming, and Settings IA:** Chinese saved entries lack pinyin/POS parsing, shatter A–Z grouping into one section per distinct Hanzi character, and cannot be found with substring or pinyin search. Meanwhile, because offline dictionaries work without AI, **Tools** deserves its own Settings section with a dedicated **Dictionary** tab and **Explain & Translate**, while **AI Assistant** belongs under **Integrations** alongside iCloud Sync and MCP. This feature also establishes Quill's new **Vocab** model (`Words` → `Vocab`).

## Data-Safety & Zero-DB-Change Constraint

No `quill.db` schema migrations (`crates/quill-core/migrations/`) and no iCloud sync event changes (`crates/quill-core/src/sync/events.rs`) are made in this feature.

- **Separate read-only built-in dictionary (`dict.db`) & local imported dictionaries:** The bundled offline English + Chinese dictionary and English lemmatizer live in a read-only SQLite resource (`dict.db`) separate from `quill.db`. User-imported dictionaries (StarDict / MDict) are stored locally under `<app_data_dir>/dictionaries/<id>/` with their own local lookup index and are never synced via iCloud.
- **Canonical lemma + multiple encounters in existing `vocab_words`:** `vocab_words` already has no unique constraint on `(book_id, word)` (`crates/quill-core/src/commands/vocab.rs`). Each saved reading encounter is stored in `vocab_words` with `word = canonical_lemma` (e.g. `mortify` even when selected as `mortified`), `book_id`, `context_sentence`, `context_explanation`, `cfi`, and a compact fallback `definition`. `Vocab` groups rows by `word.trim().toLowerCase()` into a single entry with live dictionary meanings at top and all saved reading encounters underneath.
- **Settings compatibility:** Existing keys in `settings` (`lookup_language`, `show_translation`, `lookup_translation_language`, `explain_language`, `ai_codex_model_*`, `ai_codex_effort_*`) are reused without migration; dictionary ordering, enabled state, and lookup behavior preferences store as ordinary key-value rows in `settings` (`dictionaries_config`, `dictionary_lemmatize`, `dictionary_show_all_matches`).

## Scope

### 1. Rename `Words` → `Vocab` across the desktop app

Rename the user-facing English feature label from **Words** to **Vocab** consistently across every surface (keeping Chinese as `词汇` / `本书词汇` / `生词本` where established):

- Top navigation (`TopBar`): **Home · Library · Highlights · Vocab · Chats** (`nav.words` → `"Vocab"`).
- Main screen (`WordsView.tsx` / route): page title **Vocab**, search placeholder **Filter vocab…**, summary **`{{count}} saved · {{passages}} passages from {{booksLabel}}`** (or `{{count}} saved from {{booksLabel}}` when counts match).
- Reader side panel (`DictionaryPanel.tsx`): title **Vocab in Book**, footer link **Open in Vocab →**, search placeholder **Search saved vocab…**.
- Selection popover buttons: **Save to Vocab**, **Add passage to Vocab**, **Saved**, header status pill **In Vocab · N**.
- Home view card (**Saved vocab**, **Open Vocab**), Command Search (`⌘K` scope/group/tag **Vocab**), and empty-state hints (also update `home.empty.specimenWordsBody` in `en.json` / `zh.json` to mention offline dictionaries + contextual meaning).

### 2. Single adaptive selection action & custom Smart Lens (`C1-B`) icon in `ReaderContextMenu`

- Replace the two competing **Look Up** and **Explain** rows in `src/components/ReaderContextMenu.tsx` with **one** top row using Quill's custom **Smart Lens (`C1-B`, Open-Rim Star)** SVG icon (`src/components/ui/SmartLensIcon.tsx`, frame `V50ckK`) and an adaptive label driven by `classifySelection`:
  - Word / idiom selections (`mode === "word"`) display **Look Up** (`en`) / **查词** (`zh`).
  - Passage / sentence selections (`mode === "passage"`) display **Explain** (`en`) / **解释** (`zh`).
- **Smart Lens (`C1-B`) SVG geometry** (`viewBox="0 0 24 24"`, `stroke="currentColor"`, `strokeWidth={2}`, `strokeLinecap="round"`, `strokeLinejoin="round"` matching Lucide):
  - Open magnifying ring + handle (stroked, `fill="none"`): `M 17.93 10.46 A 7.5 7.5 0 1 1 11.54 4.07 M 20.8 21.8 L 15.8 16.8`
  - Top-right 4-point star nestled in the rim gap (`fill="currentColor"`): `M 17.2 1.6 C 17.5 3.7 18.7 4.9 20.8 5.2 C 18.7 5.5 17.5 6.7 17.2 8.8 C 16.9 6.7 15.7 5.5 13.6 5.2 C 15.7 4.9 16.9 3.7 17.2 1.6 Z`
- Menu rows reduce from 6 to 5: **Look Up / Explain**, **Quote in Chat**, **Translate**, **Highlight** (5 swatches), **Copy**.
- Remove the English-only `wordCount <= 5` gate; the top slot and `SmartLensIcon` stay fixed while the label naturally previews word lookup vs. passage explanation.

### 3. Language-aware selection router (`src/utils/selectionRouting.ts`)

Pure, unit-tested classifier `classifySelection(rawText: string)` returning `{ mode: "word" | "passage", grayZone: boolean, normalizedTerm: string }`:

1. **Multi-line guard:** Trim whitespace; if the selection contains a newline with non-empty text on both sides, return `{ mode: "passage", grayZone: false }`.
2. **Outer punctuation trim:** Strip balanced surrounding quotes/brackets (`"`, `'`, `“”`, `‘’`, `「」`, `『』`, `《》`, `()`, `（）`) and trailing sentence punctuation (`.`, `,`, `;`, `:`, `!`, `?`, `。`, `，`, `；`, `：`, `！`, `？`, `…`) to obtain `normalizedTerm`, so dragging a trailing period onto a word (`mortifying.` / `潜移默化。`) still routes to **word**.
3. **Internal clause/sentence punctuation:** If `normalizedTerm` still contains internal sentence/clause punctuation (`.`, `!`, `?`, `;`, `:`, `,`, `。`, `！`, `？`, `；`, `：`, `，`, `、`, `——`), route to **passage** (`grayZone: true` only for short proverb/idiom lengths: ≤ 10 CJK chars or ≤ 5 non-CJK words).
4. **Script-aware length:** Detect CJK (`\p{Script=Han}`, `\p{Script=Hiragana}`, `\p{Script=Katakana}`, `\p{Script=Hangul}`).
   - **CJK-dominant** (contains CJK and either no spaces or ≥ 50% CJK among non-space chars): let `len` be non-space characters in `normalizedTerm`.
     - `len <= 6`: `mode = "word"`, `grayZone = len >= 4`.
     - `7 <= len <= 10`: `mode = "passage"`, `grayZone = true`.
     - `len > 10`: `mode = "passage"`, `grayZone = false`.
   - **Non-CJK (English / alphabetic):** let `words` be whitespace tokens and `chars = normalizedTerm.length`.
     - `words <= 3 && chars <= 40`: `mode = "word"`, `grayZone = words >= 2`.
     - `4 <= words <= 5 && chars <= 60`: `mode = "passage"`, `grayZone = true`.
     - Otherwise: `mode = "passage"`, `grayZone = false`.

### 4. Offline dictionaries (Built-in default + User-imported StarDict & MDict) & English lemmatizer

Provide instant (`<2 ms`), offline, cross-platform (macOS + Windows) traditional dictionary lookup and English lemmatization in `crates/quill-core`:

#### 4a. Built-in default dictionary (`dict.db`, EN + ZH)

- **Open data sources & licensing:**
  - **English:** Wiktionary via `kaikki.org` (English wiktextract, CC-BY-SA 4.0) for canonical lemmas, IPA pronunciation, parts of speech, numbered senses, and explicit `form_of` inflection mappings (`mortified → mortify`, `ran → run`, `better → good`, `children → child`), enriched with **ECDICT (MIT)** for crisp English→Chinese brief glosses and word-frequency ranking (trimming to the top ~80k–100k real reading lemmas).
  - **Chinese:** Open Chinese dictionary built from `kaikki.org` Chinese Wiktionary + **CC-CEDICT** (CC-BY-SA 4.0) — Simplified and Traditional headwords (Traditional forms mapped so looking up either Simplified or Traditional resolves), tone-marked pinyin, Chinese POS (`名词`, `动词`, `形容词`, `成语`, etc.), Chinese definitions, and English brief glosses.
  - Display CC-BY-SA 4.0 / MIT attribution in **Settings → Dictionary** footer and **Settings → About**.
- **Read-only SQLite format (`dict.db`, separate from `quill.db`):**
  - `entries(id INTEGER PRIMARY KEY, lang TEXT NOT NULL, lemma TEXT NOT NULL, pron TEXT, senses_json BLOB/TEXT NOT NULL, gloss_en TEXT, gloss_zh TEXT)` (optionally storing `senses_json` zstd-compressed with a trained dictionary to keep on-disk size around **~12–18 MB**).
  - `forms(form TEXT NOT NULL, lang TEXT NOT NULL, entry_id INTEGER NOT NULL, is_lemma INTEGER NOT NULL, relation TEXT)` indexed on `(form, lang)` and `(entry_id)` — where optional `relation` labels inflected links (e.g. `"past tense"`, `"plural"`).
  - `senses_json` stores grouped POS senses: `[{"pos":"verb","defs":["...","..."]},{"pos":"noun","defs":["..."]}]`.
  - **Build & staging:** Reproducible offline builder (`scripts/build-dict.*`) produces a compact `dict.db` targeting **≤ 20 MB** compressed (~80k–100k English lemmas + ~60k–100k Chinese words/idioms). The compiled binary is not checked into git history; packaging (`electron/packaging/artifacts.ts`) stages it into `Contents/Resources/dict.db` (macOS) / `resources/dict.db` (Windows), and dev builds resolve `QUILL_DICT_PATH` or `crates/quill-core/resources/dict.db`. A small deterministic `dict-test.db` fixture lives in the repo for Rust tests and CI.

#### 4b. User-imported dictionaries (StarDict & MDict)

- **Supported formats:**
  - **StarDict:** `.ifo` + `.idx` + `.dict` or dictzip-compressed `.dict.dz` (plus optional `.syn` synonyms), selected either as a `.zip` archive, a folder, or an `.ifo` file (reading sibling `.idx`/`.dict[.dz]`/`.syn`). Supports `sametypesequence` `m` (plain text), `h` (HTML), `g` (Pango markup), and `x` (XDXF).
  - **MDict:** Unencrypted `.mdx` (v1.2 and v2.0, UTF-8 / UTF-16LE / GBK, zlib/LZO record blocks). Encrypted/DRM v3.0 `.mdx` files return a clear, actionable unsupported-format error on import. (Embedded `.mdd` media/audio assets are out of scope for v1; missing `.mdd` references strip cleanly without broken images.)
- **Import & local storage (zero `quill.db` migration):**
  - Import copies or extracts the dictionary into `<app_data_dir>/dictionaries/<id>/` and builds a fast local SQLite index (`index.db` inside that dictionary folder) or key-offset index so runtime lookup stays `<2 ms` without parsing large `.mdx`/`.idx` files on every app launch.
  - Registry, priority order, and enabled flags persist in `settings` key `dictionaries_config` (JSON array including `{ id: "builtin", name, format: "builtin", enabled: true }` plus imported entries `{ id, name, format: "stardict" | "mdx", sizeBytes, entryCount, enabled }`).
  - Removing an imported dictionary deletes `<app_data_dir>/dictionaries/<id>/` and removes its entry from `dictionaries_config`. The built-in dictionary cannot be deleted, only reordered or toggled off.
- **Safe HTML sanitization & theme normalization:**
  - Imported HTML entries (MDict / StarDict `h`) are strictly sanitized before rendering (allow-listed structural tags such as `p`, `div`, `span`, `b`, `strong`, `i`, `em`, `br`, `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `sub`, `sup`; strip `<script>`, `<style>`, `<iframe>`, `<img>` external/missing refs, inline event handlers, and hardcoded light/dark `color`/`background` inline styles) so imported entries inherit Quill's Dawn light and Ember dark typography and colors cleanly.

#### 4c. Lemmatization & multi-dictionary lookup (`lookup_dictionary`)

- **Lemmatization runs first (100% deterministic offline, no AI; runs even when custom dictionaries are above built-in or built-in display is toggled off):**
  - When `dictionary_lemmatize` is enabled (default `"true"`), Quill resolves the normalized selection against the built-in `forms` index (plus lightweight English suffix rule fallback `-ies → -y`, `-ied → -y`, `-ing`, `-ed`, `-es`, `-s` validated against known lemmas) to find the canonical `lemma` (e.g. `mortified → mortify`, `went → go`, `children → child`) and `inflected_from`.
  - For ambiguous homographs where a word is both an independent lemma and an inflected form of another lemma (e.g. `left` adj. vs. past tense of `leave`, `saw` noun vs. past tense of `see`), return the alternate candidate(s) in `alternate_lemmas: [{ lemma, relation }]` so the popover can render a quiet one-click cross-reference link (`Also past tense of “leave”`) without calling AI.
  - Enabled dictionaries are then queried in priority order for `lemma` (and if an imported dictionary misses on `lemma`, also checked on the raw `normalizedTerm` so exact surface-form entries in custom dictionaries still hit).
- **Backend commands (`crates/quill-core/src/dictionary.rs` + `dispatch.rs`):**
  - `lookup_dictionary({ term, langHint? })` → returns `{ lemma, lang, inflected_from, alternate_lemmas, forms, matches: DictionaryMatch[] }`, where each `DictionaryMatch` carries `{ dictId, dictName, format, pronunciation, senses?, html?, plainText?, gloss_en?, gloss_zh? }`.
  - `list_dictionaries()` → returns ordered list of installed dictionaries (built-in + imported) with metadata, size, entry count, and enabled state.
  - `import_dictionary({ path })` → validates StarDict/MDict, copies to `<app_data_dir>/dictionaries/<id>/`, builds its local index, appends/prepends to `dictionaries_config`, and returns the new descriptor.
  - `update_dictionaries_config({ items })` → saves reordered/toggled dictionary list to `settings`.
  - `remove_dictionary({ id })` → refuses `"builtin"`, deletes the local directory for an imported dictionary, and updates `dictionaries_config`.

### 5. Unified selection popover (`ExplainSelectionPopover`, P1)

Unify `LookupPopover` and `ExplainPopover` under one coordinator in `Reader.tsx`, using `SmartLensIcon` (`C1-B`) in the `ReaderPopover` header with matching adaptive titles: **Look Up** (`查词`) in word mode and **Explain** (`解释`) in passage mode. Only **Look Up** entries save into **Vocab**; **Explain** (passage mode) remains **ephemeral** and is never persisted to SQLite (users can **Quote in Chat** or **Copy**).

- **Word mode (`mode === "word"` — `Look Up` / `查词`, savable to Vocab):**
  1. Immediately invoke local `lookup_dictionary({ term: normalizedTerm })` + `check_vocab_lemma({ lemma })`.
  2. **If at least one enabled dictionary matches:**
     - Render canonical `lemma` headword (24px reading font), pronunciation (IPA `/.../` for EN, slash-free pinyin `qián yí mò huà` for ZH), and quiet **`from “mortified”`** pill whenever `inflected_from` differs from `lemma`.
     - If `show_translation` is enabled and the active match carries a gloss in `lookup_translation_language`, render the violet gloss line immediately.
     - When `dictionary_show_all_matches` is `"true"` (default) and **> 1** enabled dictionary matched, show a compact segmented source switcher (`Oxford` | `Quill Built-in`) right-aligned on the POS/dictionary header line; when only 1 dictionary matched (or the setting is off), render zero switcher chrome.
     - Render structured senses (for built-in `dict.db`, grouped POS pills + numbered senses with `+ N more senses` expand toggle) or sanitized, theme-normalized HTML/text (for imported StarDict / MDict entries, capped to a clean scrollable body height).
     - **Parallel AI context stream:** Call ONLY `ai_lookup(..., kind: "context")` to stream the **`IN THIS PASSAGE`** (`句中解析`) lavender box beneath the dictionary meanings.
     - **Offline / AI-unconfigured graceful degradation:** If AI returns a sentinel or fails offline while a dictionary matched, keep the full dictionary entry visible and **Save to Vocab** / **Add passage to Vocab** enabled; show only a compact one-line prompt (`Connect AI for in-context explanation · AI Settings →`) in the context slot.
  3. **If no enabled dictionary matches** (proper nouns like `Crystal Palace`, multi-word concepts, rare terms):
     - Fall back automatically to running both `ai_lookup(kind: "definition")` and `ai_lookup(kind: "context")` in the same popover layout, with the updated bilingual prompt emitting `/pīnyīn/ 词性.` for Chinese and `/IPA/ pos.` for English.
  4. **Existing Vocab status & Footer actions:**
     - Header right shows a subtle green **`✓ In Vocab · N`** pill when the canonical `lemma` already exists in `vocab_words` (checked across all books).
     - Footer left (primary tonal button):
       - Not yet in Vocab → **`Save to Vocab`** (`存入词汇`)
       - Already in Vocab from another passage/book → **`Add passage to Vocab`** (`添加此语境`)
       - Exact passage already saved → disabled **`Saved`** (`已保存`)
     - Saving stores `word = lemma`, compact plain-text fallback `definition` (synthesized from the active dictionary match so MCP and legacy clients stay readable), `context_sentence`, `context_explanation` (nullable if offline/no AI), `book_id`, and `cfi`.
     - Footer right (ghost buttons): **`Quote`** (`引用`) + **`Copy`** (`复制`).
- **Passage mode (`mode === "passage"` — `Explain` / `解释`, ephemeral / not saved to DB):**
  - Renders italic quoted passage + `ai_explain` prose stream, with **`Quote in Chat`** + **`Copy`** in footer (never written to `vocab_words` or any DB table).
- **Gray-zone escape hatch (P1):**
  - Only when `grayZone === true`, show a quiet secondary switch button in the header left of `×` (`Explain passage` / `按段落解释` in word mode; `Look up` / `按词语查询` in passage mode). Clicking cancels active streams via `ai_cancel` and flips in place.

### 6. New Vocab View (`Vocab`, W1) & Vocab in Book (`DictionaryPanel`)

- **Backend encounter dedup & lemma check (`crates/quill-core/src/commands/vocab.rs`):**
  - Update `add_vocab_word` dedup check from `(book_id, word)` to `(book_id, word, cfi)` (falling back to `(book_id, word, context_sentence)` when `cfi` is `None`), allowing multiple distinct passages of the same canonical lemma across pages or books with zero DB schema changes.
  - Add read-only `check_vocab_lemma(lemma, book_id?, cfi?, context_sentence?)` returning `{ total_count, matches_this_passage }` and `remove_vocab_lemma(word)` (deletes all encounters of that lemma inside one sync transaction emitting `VocabDelete` per row). Keep `check_vocab_exists` and `remove_vocab_word` intact.
- **Lemma grouping & detail pane (`WordsView.tsx` → Vocab, frames `PZLxf`, `GcgWf`):**
  - Group `vocab_words` rows by `word.trim().toLowerCase()` into canonical `VocabGroup` items; left rail renders one row per lemma with a subtle mono `×N` badge when `encounters.length > 1`.
  - Detail header: giant serif `lemma`, CJK-aware TTS speaker button (`zh-CN` / `ja-JP` / `ko-KR` / default), pronunciation (`/IPA/` for EN, slash-free pinyin for ZH), optional violet gloss, and 2-click timed **Delete** button (removes the whole lemma entry).
  - **`DICTIONARY` section:** Queries `lookup_dictionary({ term: lemma })` on selection; shows the compact source switcher (`Oxford` | `Quill Built-in`) when >1 dictionary matches and `dictionary_show_all_matches` is on; renders full senses (collapsing >4 senses behind `Show more senses`) or sanitized imported HTML; falls back to `parseSavedVocabDefinition(latestEncounter.definition)` if no dictionary matches.
  - **`IN YOUR READING · N` section:** Renders one bound card per saved encounter (newest first), each pairing:
    - Paper quote block highlighting the lemma **or any of its inflected forms** (`mortifying`, `mortified`, etc. from `lookup_dictionary`'s `forms` list) in `$hl-violet`.
    - Book cover thumbnail, `Title · Author · saved Date`, **`Go to passage`**, and a quiet per-encounter delete button when `N > 1`.
    - Attached tinted Quill AI contextual note (`context_explanation`) when present.
- **Chinese Vocab grouping, parsing & search (W1):**
  - Pure-JS client-side pinyin utility (`src/utils/pinyin.ts` using `pinyin-pro`) provides unified Pinyin **A–Z** grouping (`潜移默化` → `Q`, `执拗` → `Z`, `悖论` → `B`, `缄默` → `J`, symbols → `#`), pinyin-interleaved A–Z sorting, and substring + full pinyin + pinyin initials + gloss search (`matchesVocabSearch`) across **Vocab**, **Vocab in Book**, and **Command Search**.
  - Extend `src/utils/vocabParse.ts` for Chinese POS/pinyin parsing, `formatPronunciation`, `parseSavedVocabDefinition`, CJK-aware `speakWord`, and multi-form sentence highlighting.

### 7. Reorganized Settings Navigation IA & New `Dictionary` Tab (`Lwfaf`, `NpCRQ`, `s2AAh`)

Reorganize `SettingsNav.tsx` and `SettingsView.tsx` into four balanced groups:

| Group | Tabs | Notes |
| --- | --- | --- |
| **APP** (`应用`) | General · Appearance · Reading | Unchanged |
| **TOOLS** (`工具`) | **Dictionary** (`词典`, `BookA`) · **Look Up & Translate** (`查词与翻译`, `SmartLensIcon`) | New standalone Tools section; Dictionary gets its own tab; former `tools` tab renamed to **Look Up & Translate** |
| **INTEGRATIONS** (`集成`) | **AI Assistant** (`AI 助手`, `Bot`) · **iCloud Sync** (`iCloud 同步`, `Cloud`, macOS only) · **MCP** (`MCP`, `Terminal`) | Moves **AI Assistant** into Integrations; removes the standalone `AI` group |
| **SYSTEM** (`系统`) | Updates · About | Unchanged |

- **`Settings → Dictionary` (`src/components/settings/DictionarySettings.tsx`, frame `Lwfaf`):**
  - **`INSTALLED DICTIONARIES`** section with **`+ Import dictionary…`** button (opens native file picker for `.mdx`, `.ifo`, `.zip`; shows import progress/error toast).
  - Card listing enabled/imported dictionaries + `Quill Built-in (EN / ZH)` with drag-to-reorder handles (or up/down keyboard controls), format/size metadata, `Built-in` badge on default, remove button on imported dictionaries, and enable/disable switch.
  - **`LOOKUP BEHAVIOR`** section:
    - **Match inflected English forms** (`dictionary_lemmatize`, default `"true"`) — *"Resolve tenses and plurals (e.g. mortified → mortify) before querying dictionaries and Vocab"*.
    - **Show all matching dictionaries** (`dictionary_show_all_matches`, default `"true"`) — *"Display compact source tabs when more than one enabled dictionary matches a word"*.
  - Footer attribution note for Wiktionary (`kaikki.org`) and CC-CEDICT (CC-BY-SA 4.0) plus local-only storage caveat.
- **`Settings → Look Up & Translate` (`ToolsSettings.tsx`, frame `NpCRQ`):**
  - Keeps section ID `"tools"` for deep-link compatibility (`open_settings_on_main({ section: "tools" })`), updates title to **Look Up & Translate** (`查词与翻译`).
  - Merges `LOOK UP` + `EXPLAIN` into one **`LOOK UP & EXPLAIN`** (`查词与解释`) group (Response language writing `lookup_language` + normalizing `explain_language = "lookup"`, Brief translation, Gloss target) plus **`TRANSLATE`** (Translate to).
- **`Settings → AI Assistant` (`AiSettings.tsx`, `src/lib/codexFeatures.ts`, frame `s2AAh`):**
  - Now located under **Integrations**. Keeps all 4 Codex feature rows (S1) with clarified labels/hints:
    - `lookup`: **Word look-up** / **词语查询** — *"Context explanations, fallback definitions, and chat titles"*
    - `explain`: **Passage explain** / **段落解释** — *"Sentences and longer passages"*

### Out of scope

- SQLite `quill.db` migrations, new `vocab_words` columns, or iCloud sync event format changes.
- Syncing user-imported dictionary files over iCloud.
- Embedded `.mdd` audio/image resource packs or encrypted MDict v3.0 DRM files.
- Multi-surface unauthenticated AI redesign across Ask Quill and Chats (tracked in #348).
- Persisting passage explanations into a standalone tools page (tracked in #257).
- Spaced-repetition scheduling / flashcard review UI.

## Implementation Phases

1. **Built-in offline dictionary pipeline, Rust lookup/lemmatizer & StarDict/MDict importers (`crates/quill-core`, `scripts/`, `electron/packaging/`):**
   - Add reproducible offline dictionary builder (`scripts/build-dict.*`) producing compact read-only `dict.db` from `kaikki.org` (EN + ZH) and CC-CEDICT, plus a checked-in `dict-test.db` fixture.
   - Implement `crates/quill-core/src/dictionary/` (read-only built-in `dict.db` reader, English lemmatizer + suffix fallback, StarDict `.ifo`/`.idx`/`.dict[.dz]`/`.syn` parser, unencrypted MDict `.mdx` v1.2/v2.0 parser, per-dictionary local index builder, priority multi-dictionary query, HTML sanitizer/normalizer, and commands `lookup_dictionary`, `list_dictionaries`, `import_dictionary`, `update_dictionaries_config`, `remove_dictionary`).
   - Stage `dict.db` in `electron/packaging/artifacts.ts` and `scripts/validate-pack.mjs`.
   - Rust unit tests: regular/irregular lemmatization, Chinese Simplified/Traditional lookup, StarDict `.dict` & `.dict.dz` import/query, MDict v1.2/v2.0 import/query, encrypted `.mdx` rejection, priority ordering, HTML sanitization, and graceful behavior when `dict.db` is absent.
2. **Backend vocab encounter dedup & bilingual fallback prompt (`crates/quill-core`):**
   - Update `add_vocab_word` in `crates/quill-core/src/commands/vocab.rs` to dedupe by `(book_id, word, cfi)` (or `context_sentence` when `cfi` is `None`), add `check_vocab_lemma` and `remove_vocab_lemma`.
   - Update `lookup_system_prompt` in `crates/quill-core/src/commands/ai.rs` so fallback Chinese definitions emit `/pīnyīn/ 词性.`.
   - Rust unit tests covering multi-encounter saves under one lemma, duplicate-passage idempotency, `check_vocab_lemma`, `remove_vocab_lemma`, and prompt formatting.
3. **Selection routing, pinyin & vocab-parse frontend utilities:**
   - Add `src/utils/selectionRouting.ts` (`classifySelection`) and `src/utils/pinyin.ts` (`getVocabGroupKey`, `getVocabSortKey`, `matchesVocabSearch` via `pinyin-pro`) with EN + CJK unit tests.
   - Extend `src/utils/vocabParse.ts` (Chinese POS/pinyin parsing, `formatPronunciation`, `parseSavedVocabDefinition`, CJK-aware `speakWord`, multi-form sentence highlighting).
4. **Unified selection menu & Look Up / Explain popover (`SmartLensIcon`, `ReaderContextMenu`, `ExplainSelectionPopover`, `Reader.tsx`):**
   - Add reusable `src/components/ui/SmartLensIcon.tsx` (`C1-B` Open-Rim Star) and collapse separate `Look Up` and `Explain` rows into one adaptive top row (`SmartLensIcon` + **Look Up** / `查词` for words & idioms, **Explain** / `解释` for passages) in `ReaderContextMenu.tsx`.
   - Build `ExplainSelectionPopover` coordinating `lookup_dictionary` + `check_vocab_lemma` + `ai_lookup(context)` (matching adaptive **Look Up** / **Explain** header, multi-dictionary source switcher pills, `from “inflected”` pill, `✓ In Vocab · N` header pill, `Save to Vocab` / `Add passage to Vocab` / `Saved`, Word-footer `Quote` + `Copy`, offline/no-AI graceful degradation, AI fallback when no dictionary hits, ephemeral passage **Explain** with no DB write, and gray-zone header mode switch with clean `ai_cancel`).
   - Wire into `Reader.tsx` and update `ReaderAiSurfaces.test.tsx` and `AiSessionPrompts.test.tsx`.
5. **New Vocab view, Vocab in Book, Command Search, Settings IA & `Words → Vocab` i18n:**
   - Update `WordsView.tsx` to group encounters by canonical lemma, render live `DICTIONARY` (with optional source switcher + expand toggle) + `IN YOUR READING · N` bound encounter cards (with inflected-form highlighting and per-encounter delete), unified Pinyin A–Z grouping/sorting, and `matchesVocabSearch`.
   - Update `DictionaryPanel.tsx` (`Vocab in Book`) and `CommandSearchModal.tsx` with substring + pinyin search, `parseSavedVocabDefinition`, and `Vocab` labels.
   - Reorganize `SettingsNav.tsx` and `SettingsView.tsx` (`APP`, `TOOLS`: `Dictionary` + `Look Up & Translate`, `INTEGRATIONS`: `AI Assistant` + `iCloud Sync` + `MCP`, `SYSTEM`), implement `DictionarySettings.tsx` (import, drag-reorder, toggle, remove, behavior switches), simplify `ToolsSettings.tsx` into `LOOK UP & EXPLAIN` + `TRANSLATE`, update Codex feature labels/hints, and update all EN/ZH strings in `en.json` and `zh.json` + tests (`SettingsView.test.tsx`, `AiSettings.test.tsx`, `MainViews.test.tsx`).

## Verification

Automated checks:

- `make typecheck`, `make lint`, `npm test`, and `cargo test -p quill-core` pass with all new unit and component tests green.
- Unpacked packaging check (`CSC_IDENTITY_AUTO_DISCOVERY=false QUILL_PACK_ALLOW_DEBUG=1 npx electron-builder --mac --dir --publish never && node scripts/validate-pack.mjs`) confirms `dict.db` is staged inside app resources.
- `git diff` contains zero changes under `crates/quill-core/migrations/` and `crates/quill-core/src/sync/`.

Live checks (required because the feature alters the reader context menu, selection popovers, offline & imported dictionaries, Vocab view, Vocab in Book panel, TopBar navigation, and Settings navigation/tabs; run in the development app with iCloud sync off and tiny prompts on an inexpensive model):

| Check | What it verifies | Reason |
| --- | --- | --- |
| F-1 | Selecting an English word (`mortified`) or 4-char Chinese idiom (`潜移默化`) shows one top **Look Up** (`查词`) row with the custom `SmartLensIcon` (`C1-B`); selecting a multi-sentence passage shows one top **Explain** (`解释`) row with `SmartLensIcon` — never both rows at once. | Selection menu uses a single adaptive row with the custom C1-B icon and language-aware classification. |
| F-2 | Clicking **Look Up** on `mortified` immediately renders the built-in offline dictionary under lemma `mortify` with `from “mortified”`, IPA, numbered senses, and streams **In this passage** below; **Quote** inserts into Ask Quill. | Built-in offline dictionary, lemmatization, single-context streaming, and Word-footer Quote are new. |
| F-3 | Saving `mortify` from one passage and later looking up `mortified` on another page/book shows `✓ In Vocab · 1` and `Add passage to Vocab`; adding it attaches a second encounter under one `mortify` entry in **Vocab** (`×2` badge, single `DICTIONARY` section, two `IN YOUR READING` cards highlighting `mortifying` and `mortified`, per-encounter delete). | Multi-encounter lemma grouping and inflected-form highlighting are new. |
| F-4 | Turning off/clearing AI config and looking up a dictionary word (`mortify`) still renders the offline dictionary instantly with `Save to Vocab` working and a quiet inline AI prompt; looking up a proper noun absent from dictionaries (`Crystal Palace`) falls back cleanly to AI definition + context. | Offline dictionary independence and AI fallback paths are new. |
| F-5 | Looking up a Chinese idiom (`潜移默化`) renders slash-free pinyin (`qián yí mò huà`), Chinese POS (`成语`), dictionary sense, and `句中解析`; saving groups under `Q` in **Vocab** A–Z alongside English; searching `默化`, `qianyi`, or `qymh` matches in **Vocab** and **Vocab in Book**; TTS pronounces Chinese. | Chinese offline dictionary, unified Pinyin A–Z, substring/pinyin search, and CJK TTS are new. |
| F-6 | In **Settings → Tools → Dictionary**, importing a test StarDict and/or `.mdx` dictionary adds it to the list, dragging it above `Quill Built-in` changes default source order, toggling `Show all matching dictionaries` shows/hides the `Oxford \| Quill Built-in` switcher in both popover and Vocab detail, and removing the imported dictionary cleans it up cleanly. | New Dictionary settings tab, StarDict/MDict import, priority ordering, and multi-dictionary UI are new. |
| F-7 | Settings sidebar shows `APP`, `TOOLS` (**Dictionary**, **Look Up & Translate**), `INTEGRATIONS` (**AI Assistant**, **iCloud Sync**, **MCP**), `SYSTEM`; **Look Up & Translate** shows 2 groups (`LOOK UP & EXPLAIN`, `TRANSLATE`); **AI Assistant** keeps 4 clarified rows; TopBar/Home/Command Search/Reader panel consistently use **Vocab**; gray-zone header switch works cleanly; passage **Explain** stays ephemeral (not saved to Vocab); Ember dark mode contrast passes on menu, EN/ZH popovers, Dictionary settings, and Vocab detail. | Settings navigation IA, `Words → Vocab` rename, gray-zone switch, ephemeral Explain invariant, and Ember dark styling changed. |
| AI-01, AI-02 | Word explanation (save to Vocab) and passage explanation (Quote in Chat) stream and complete end-to-end. | Both flows are unified behind `ExplainSelectionPopover`. |
| VOC-01 | Vocab master-detail browsing, book filter, Newest/Oldest/A–Z sort, Go to passage, and 2-click delete work without regression. | Vocab grouping, detail rendering, and search were rewritten. |
| SET-04 | All Settings tabs open, save, and switch languages/themes cleanly under the new 4-group sidebar (`APP`, `TOOLS`, `INTEGRATIONS`, `SYSTEM`). | Settings navigation groups and tab count changed. |
