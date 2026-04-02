# Close reader windows when main window closes

## Context

When the user closes the main library window, reader windows stay open as orphans. The main window is the app's primary entry point — closing it should exit the application entirely, including all reader windows. The root cause is that `app.run(|_app_handle, _event| {})` in `lib.rs:140` does nothing, and reader windows are created as independent windows with no parent-child relationship.

Issue: #118

## Approach

Handle the `WindowEvent::Destroyed` event for the `"main"` window in the Tauri `app.run` callback. When the main window is destroyed, iterate over all remaining windows and close them. This is the simplest fix — no parent/owner API needed, no frontend changes.

---

## Step 1: Handle main window destroy in the app event loop

**File: `src-tauri/src/lib.rs`**

Replace the empty `app.run` callback (line 140) with one that listens for the main window's `Destroyed` event:

```rust
app.run(|app_handle, event| {
    if let tauri::RunEvent::WindowEvent {
        label,
        event: tauri::WindowEvent::Destroyed,
        ..
    } = &event
    {
        if label == "main" {
            // Close all remaining windows (reader windows)
            for (_, window) in app_handle.webview_windows() {
                let _ = window.close();
            }
        }
    }
});
```

- `webview_windows()` returns all open webview windows (from `tauri::Manager` trait, already imported at line 13).
- `window.close()` is infallible for already-closing windows — ignoring the error with `let _` is fine.
- No new imports needed; `tauri::RunEvent` and `tauri::WindowEvent` are available from the `tauri` crate already in scope.

## Files to modify

| File | Change |
|------|--------|
| `src-tauri/src/lib.rs` | Replace empty `app.run` callback with main-window destroy handler |

## Verification

1. `cargo check` in `src-tauri/` — confirm it compiles.
2. Manual test:
   - Open Quill, open 2+ books in reader windows.
   - Close the main library window.
   - Verify all reader windows close and the app exits.
3. Edge cases:
   - Close a reader window first, then close main — should still work.
   - Close main with no reader windows open — should exit cleanly.
