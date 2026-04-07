# 27 — Reading Stats

**GitHub Issue:** https://github.com/yicheng47/quill/issues/142

## Motivation

Quill currently has no visibility into how a user actually reads. Time spent per book, total library reading time, finished-book counts, and annotation activity all live implicitly in the data but are never surfaced. This is a missed opportunity:

- **Motivation loop** — visible reading time and streaks make readers want to keep going (Kindle, Bookly, StoryGraph all lean on this).
- **Self-knowledge** — users want to know "how long did this book actually take me?" and "which books did I annotate the most?"
- **Quality signal** — time-per-book + highlight counts together describe how *deeply* a book was read, not just whether it was opened.

The data needed for all of this is cheap to capture — we already have `books`, `highlights`, and a long-running reader view. We just need a sessions table and a stats page.

## Scope

### In scope

- **Per-book reading time** — total active reading time per book, with idle pause-after-inactivity.
- **Library-wide totals** — total time read, books finished, current/longest streak, books-per-month, time-per-day rolling average.
- **Highlight & note stats** — total highlights across library, per-book counts, breakdown by color, count of highlights with notes.
- **Stats page** — new top-level page (alongside Home / Reader) with the above, charts included.
- **Settings → Stats tab** — minimal subset (totals + reset/export controls), tucked under Settings for users who want a quieter surface.
- **Local-only storage** — all stats live in `quill.db`. Future cloud sync (#16) will pick this up alongside the rest of the data.

### Out of scope

- **Cloud sync** — handled later by feature #16.
- **Social features** — no sharing, comparison with friends, or public profiles.
- **Goal-setting / streaks notifications** — streaks are *displayed* but not enforced via push/system notifications.
- **Per-chapter or per-section breakdowns** — would require deeper foliate-js integration; revisit later.
- **Backfilling historical data** — sessions only start being tracked from the version this ships in. Existing highlights count from day one (already in the DB), but reading time starts at zero.

## Key decisions

- **Idle threshold:** pause the session timer after **60 seconds** with no scroll, page-turn, key, or pointer event. Resume on next activity. This avoids inflating numbers when the user steps away with the reader open.
- **Session granularity:** one row per *active* session (start, end, duration, book_id). Idle gaps split a session into two rows. Keeps math simple and lets us draw daily/weekly aggregates without re-deriving from raw events.
- **No event log:** we do *not* store every page-turn / scroll event. The frontend tracks idle in memory and only writes a row when a session ends (or every N minutes as a heartbeat to survive a crash).
- **Highlight stats are derived, not stored:** we already have the `highlights` table — counts are just `SELECT COUNT(*) … GROUP BY …`. No new schema for highlights.

## Implementation Phases

### Phase 1 — Backend: schema + session tracking

1. **Migration `008_reading_sessions.sql`** — new table:
   ```sql
   CREATE TABLE IF NOT EXISTS reading_sessions (
     id TEXT PRIMARY KEY,
     book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
     started_at TEXT NOT NULL,   -- ISO 8601 UTC
     ended_at TEXT NOT NULL,     -- ISO 8601 UTC
     duration_secs INTEGER NOT NULL CHECK (duration_secs >= 0)
   );
   CREATE INDEX IF NOT EXISTS idx_reading_sessions_book ON reading_sessions(book_id);
   CREATE INDEX IF NOT EXISTS idx_reading_sessions_started ON reading_sessions(started_at);
   ```
2. **`commands/stats.rs`** — new command module exposing:
   - `record_reading_session(book_id, started_at, ended_at, duration_secs)` — append-only insert.
   - `get_book_stats(book_id)` → `{ total_secs, session_count, last_read_at, highlight_count, note_count, highlights_by_color }`.
   - `get_library_stats()` → `{ total_secs, total_books_finished, total_highlights, total_notes, current_streak_days, longest_streak_days, daily_minutes_last_30d: [{date, minutes}], books_started_per_month_last_12m: [...] }`.
   - `reset_stats()` — clears `reading_sessions` (keeps highlights). Confirm in UI before calling.
3. **Unit tests** in `commands/stats.rs` for: insert, per-book aggregation, streak calculation, empty-library case.

### Phase 2 — Frontend: session tracker hook

- New `useReadingSession(bookId)` hook in `src/hooks/`:
  - Starts a session when the reader mounts with a book loaded.
  - Listens for activity events (`scroll`, `keydown`, `pointermove`, `wheel`, plus foliate-js `relocate` events).
  - Maintains `lastActivityAt` and an `activeSecs` counter ticking every second while not idle.
  - On 60s of inactivity → flush current segment via `record_reading_session`, mark session as paused.
  - On next activity → start a new segment.
  - On unmount / book change / app blur for >60s → flush.
  - Heartbeat flush every 5 minutes to survive a crash.
- Wire into `Reader.tsx`. No UI in this phase — just data collection.

### Phase 3 — Stats page

- New route `/stats` and `src/pages/StatsPage.tsx`. Add nav entry on Home (small icon button next to existing controls).
- Sections (top to bottom):
  1. **Hero totals row** — total time read, books finished, total highlights, current streak. Big numbers, label underneath.
  2. **Daily activity** — last 30 days, minutes per day, simple bar chart (no chart library — hand-rolled SVG, ~100 LOC).
  3. **Per-book leaderboard** — table of books sorted by time read: cover, title, author, total time, highlight count, last read.
  4. **Highlights breakdown** — count by color (yellow/green/blue/pink), count with notes vs without.
  5. **Books per month** — last 12 months, books started, simple SVG bar chart.
- All strings via `i18n` keys in `en.json` / `zh.json` under a new `stats.*` namespace.
- No new chart library — use SVG primitives. Three similar bars > a pulled-in dependency.

### Phase 4 — Settings → Stats tab

- New `src/components/settings/StatsSettings.tsx` following the row pattern in `GeneralSettings.tsx`.
- Rows:
  - "Total time read" — read-only display.
  - "Total books finished" — read-only display.
  - "Total highlights" — read-only display.
  - "Reset reading time" — destructive button, confirms before calling `reset_stats`. Note: does not delete highlights.
  - "Open full stats page" — link to `/stats`.

### Phase 5 — Polish

- Empty states on Stats page when there's no data ("Read your first book to see stats here").
- i18n review pass — both languages.
- Verify reset flow really only nukes sessions, not highlights or progress.
- Verify session flushes survive: app close, reload, navigating away from Reader, system sleep.

## Verification

- [ ] Opening a book starts a session; closing the reader flushes it within 1s.
- [ ] Walking away (no input) for 60s pauses the session — duration stops growing.
- [ ] Returning resumes tracking as a new session segment.
- [ ] App crash mid-session loses at most 5 minutes (heartbeat interval).
- [ ] System sleep / lid close does not inflate the timer when the machine wakes.
- [ ] Per-book total time on the Stats page matches the sum of all session rows for that book.
- [ ] Highlight counts on the Stats page match `SELECT COUNT(*) FROM highlights WHERE book_id = ?`.
- [ ] Streak calculation: a day with ≥1 minute counts; gaps reset the current streak; longest streak persists.
- [ ] `reset_stats` clears `reading_sessions` only — highlights, bookmarks, and `progress` are untouched.
- [ ] Stats page renders an empty state for a fresh install with no sessions.
- [ ] All user-facing strings have i18n keys in both `en.json` and `zh.json`.
- [ ] Settings → Stats tab numbers match the Stats page.
- [ ] No measurable frame-rate impact on the reader from the activity listeners (smoke test on a long PDF).
