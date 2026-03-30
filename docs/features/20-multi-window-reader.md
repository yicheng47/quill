# 20 — Multi-Window Reader & Enhanced Reader Chrome

GitHub Issue: https://github.com/yicheng47/quill/issues/103

## Motivation

Currently Quill only supports reading one book at a time — opening a new book replaces the current reader view. This is limiting for users who want to cross-reference multiple books, compare translations, or simply switch between reads without losing their place. The ideal behavior mirrors iBooks/Apple Books, where each book opens in its own dedicated window that can be independently positioned, resized, and closed.

Additionally, the reader view currently renders content edge-to-edge without proper header/footer chrome. A well-designed reader chrome (title bar, progress footer, navigation controls) would improve the reading experience and bring Quill closer to native reader app quality.

## Scope

### In Scope

1. **Multi-window support** — Each book opens in a separate Tauri window. Users can have multiple books open simultaneously.
2. **Window lifecycle management** — Track open reader windows, restore positions on relaunch, handle window close gracefully (save reading position).
3. **Reader header chrome** — Display book title and/or chapter title at the top of the reader view.
4. **Reader footer chrome** — Display reading progress (page number, percentage, or time remaining) at the bottom of the reader view.
5. **Theme-aware chrome** — Header and footer styling matches the active reader theme (light, dark, sepia, etc.) seamlessly.
6. **Home window behavior** — The main/home window remains the library. Double-clicking or selecting "Read" opens a new reader window (or focuses an existing one for that book).
7. **Window-to-window communication** — Reading progress updates from reader windows sync back to the library view (e.g., progress bars update in real time or on window close).

### Out of Scope

- Split-view / side-by-side reading within a single window (future enhancement).
- Tabbed reading within a single window.
- Cross-device sync of window positions.

## Implementation Phases

### Phase 1: Multi-Window Infrastructure

- Add Tauri multi-window support: create new `WebviewWindow` instances for each reader.
- Define a URL scheme for reader windows (e.g., `/reader/:bookId`).
- Pass book ID and initial state to new windows via URL params or Tauri window labels.
- Ensure each reader window loads independently with its own React root.
- Track open windows in backend state to prevent duplicate windows for the same book.
- Handle window close events: save reading position, clean up state.

### Phase 2: Reader Chrome (Header & Footer)

- Design and implement a reader header bar: book title, chapter title, close/back button.
- Design and implement a reader footer bar: current page/location, total pages, progress percentage.
- Make chrome auto-hide on scroll or tap (distraction-free mode), show on hover or tap.
- Ensure chrome is theme-aware — inherits colors from the active reader theme.
- Chrome should overlay the content, not push it — reading area remains full-height.

### Phase 3: Window State Persistence & Polish

- Persist window positions and sizes per book in SQLite.
- On app launch, optionally restore previously open reader windows.
- Add keyboard shortcuts for window management (close reader, cycle between windows).
- Ensure proper focus management — library window vs. reader windows.
- Handle edge cases: deleting a book that has an open reader window, importing a book while reader is open.

## Verification

- [ ] Opening a book from the library creates a new window with the reader view.
- [ ] Opening the same book again focuses the existing reader window instead of creating a duplicate.
- [ ] Multiple books can be open simultaneously in separate windows.
- [ ] Reader header displays book/chapter title correctly.
- [ ] Reader footer displays accurate reading progress.
- [ ] Header/footer style matches all reader themes (light, dark, sepia).
- [ ] Chrome auto-hides during reading and reappears on interaction.
- [ ] Reading progress is saved when a reader window is closed.
- [ ] Window positions and sizes persist across app restarts.
- [ ] Closing the library window does not close reader windows (or prompts appropriately).
- [ ] All i18n strings are properly localized.
