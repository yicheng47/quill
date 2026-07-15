# 243 — Update Experience: Pill, App-Menu Check, Formal About

Issue: https://github.com/yicheng47/quill/issues/243

## Problem

The update experience is bundled into **Settings → About**: a "Software update" row (check/download/restart), a download progress bar, and an "Auto-check" toggle. Update availability is surfaced by a **top-center toast** (`UpdateToast`). Three things are off:

1. **Discoverability/placement.** Check-for-update is buried in About; the toast floats top-center, detached from the app's chrome.
2. **About is cluttered.** It mixes app identity with update controls, so it reads like a settings form rather than an identity card.
3. **The auto-check toggle is in the wrong place** — it's a general app behavior, not an "About" fact.

This issue originally proposed a *new Updates settings pane* + top-center toast (mirroring Runner). The direction has since changed (see below).

## Direction (overrides the issue's original scope)

- **Update-available → the existing top-center toast, extended** to carry the full lifecycle (available → downloading → auto-relaunch) plus manual-check feedback. (A titlebar pill in the sidebar's top drag band was considered and dropped: ~150px of usable width after the traffic lights is too narrow for the download label + progress bar. The toast has the room.)
- **No update controls in Settings at all.** Not in About, and **no** new Updates pane.
- **Check for Updates lives in the native app menu** (the "Quill" menu on macOS), next to About. This is the one deliberate divergence from Runner, which keeps it in Settings → Updates.
- **Auto-check toggle moves to General settings.**
- **After download → auto-relaunch.** No manual "Restart" step.
- **About becomes a formal identity card**, modeled on Runner's About pane: centered icon + name + tagline, version/platform pills, link rows (GitHub, Documentation, License), © footer. No update UI.

Design reference: the `Update Toast` frame in `design/quill-desktop.pen`.

## Fix

### 1. Update toast (extended `UpdateToast.tsx`)

The top-center toast stays where it is but becomes one persistent surface whose copy/action swap with `status`:

| view | copy | action |
|---|---|---|
| `available` | "Quill v{ver} available" | **Update** → `downloadAndInstall()` |
| `downloading` (incl. `ready`) | "Downloading update… {progress}%" | thin progress bar; auto-relaunches on finish |
| `checking` *(manual only)* | "Checking for updates…" | spinner |
| `uptodate` *(manual only)* | "You're up to date" | auto-dismiss (~4s) |
| `error` *(manual only)* | error / "Update check failed" | **Retry** |

The **Update** action drives the lifecycle inline (no longer opens settings), so the `onOpenSettings` / `open-settings("about")` wiring is removed from `App.tsx`. `downloadAndInstall()` calls `relaunch()` once the download finishes.

**Auto vs manual feedback.** The launch auto-check stays silent unless an update is found — the toast only appears for `available`/`downloading`. A **manual** check (from the menu) additionally surfaces the transient `checking` / `uptodate` / `error` states so the click visibly does something. Tracked via a `manual` flag:

```ts
// useUpdateChecker
checkForUpdate: (opts?: { manual?: boolean }) => Promise<void>;
manualCheck: boolean; // toast gates the transient states on it
```

The toast detects "up to date" by watching the `checking → idle` transition while `manualCheck` is set, and shows the confirmation for ~4s.

### 2. Check for Updates in the app menu

`src-tauri/src/lib.rs` currently augments only the Help submenu of `Menu::default`. Add a `check_for_updates` item to the **app submenu** (first submenu on macOS, the "Quill" menu), inserted just after About:

```rust
// inside the .menu(|handle| { ... }) closure, after building `menu`
if let Some(app_kind) = menu.items()?.first() {        // app menu is items[0] on macOS
    if let Some(app_sub) = app_kind.as_submenu() {
        let item = MenuItem::with_id(handle, "check_for_updates", "Check for Updates…", true, None::<&str>)?;
        app_sub.insert(&item, 1)?;                     // 0 = About, 1 = our item
    }
}
```

`on_menu_event` handles `"check_for_updates"` by showing/focusing the main window and emitting an event the frontend listens for:

```rust
if event.id() == "check_for_updates" {
    if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
    let _ = app.emit("menu:check-for-updates", ());
}
```

`UpdateContext` listens for `menu:check-for-updates` and calls `checkForUpdate({ manual: true })`. (Label stays English at boot — same limitation/precedent as the existing `reveal_logs` item; tracked under the menu-i18n follow-up.)

### 3. Auto-check toggle → General

Move the toggle (and its `auto_check_updates` setting key — unchanged) from `AboutSettings` into `GeneralSettings`, following the 73px row pattern. Behavior is identical; only its home moves. `UpdateContext` keeps reading `auto_check_updates` to decide whether to run the launch check.

### 4. Formal About

Rewrite `AboutSettings.tsx` as an identity card (Runner-modeled):

- Centered block: `QuillLogo` (~56px), "Quill" wordmark, tagline (`settings.about.description`), then a row of mono pills — `v{version}` and a platform label (`darwin · arm64`, derived from `navigator.userAgent`, informational).
- Divider, then link rows: **GitHub** (`github.com/yicheng47/quill`), **Documentation** (README), **License** (MIT, trailing label). Links open via the `opener` plugin (already a dependency).
- `© 2026 wyc studios` footer.
- Remove: software-update row, progress bar, auto-check toggle, and all `useUpdate()` usage from this file.

### 5. i18n

- Move `settings.about.autoCheck` / `autoCheckHint` → `settings.general.*` keys.
- Add pill strings under `update.pill.*` (available / downloading / ready / checking / upToDate / error / update / restart / retry); retire the `update.toast.*` keys.
- Add About link labels (`settings.about.github` / `documentation` / `license`).
- en.json + zh.json both.

## Out of scope

- Localizing the native menu item (pre-existing English-at-boot limitation).
- Auto-install-on-download behavior (Runner has it; Quill stays manual: pill shows Update → user clicks).
- Windows/Linux menu placement of Check-for-Updates (this pass targets the macOS app menu; the pill itself is cross-platform).

## Verification

1. Launch with an update available → toast appears; **Update** → progress bar → auto-relaunch into the new version.
2. Launch up-to-date → no pill, no flicker.
3. Menu → Check for Updates (up-to-date) → window focuses, pill shows "Checking…" then "You're up to date" and auto-dismisses.
4. Menu → Check for Updates (update available) → pill shows Update.
5. General has the auto-check toggle; turning it off suppresses the launch check.
6. About shows only identity + links; no update controls. Links open externally.
7. `tsc` clean; `cargo build` clean (menu compiles).

## Open design choices (for review / Pencil)

- Pill exact position within the top band (right-aligned vs. offset) and styling (filled accent vs. subtle surface).
- Whether the "up to date" confirmation is a pill state or a lighter inline note.
