# Auto-Update — Implementation Plan

## Reference

- **Issue:** [#45](https://github.com/yicheng47/quill/issues/45)
- **Feature spec:** `docs/features/12-auto-update.md`
- **Style reference:** ChatGPT desktop app's update toast

---

## Design (Figma)

- Toast: https://www.figma.com/design/IXgVUmavwDruSjI9btPb1V/Quill?node-id=158-344
- Settings: https://www.figma.com/design/IXgVUmavwDruSjI9btPb1V/Quill?node-id=158-3

### Update Toast

Fixed top-center of the main content area. Small card with popover shadow and rounded-14px corners.

Content: purple accent dot with glow effect + "Quill v0.7.1 available" text + purple "Update" text link + X dismiss icon.

Slide-down entrance animation. Auto-dismisses after 30s. Dismissible by user (hidden for session).

### Settings > About Section

Section header subtitle: "Version information and updates". Follows the same row layout pattern as GeneralSettings.

**Row 1 — App Identity**: "Quill" + "An elegant eBook reader" on left. Version in a gray pill badge with monospace font (Menlo) on right, e.g. `v0.7.0`.

**Row 2 — Software Update**: Changes based on state:
- **idle**: "You're up to date" subtitle, "Check Now" bordered button on right
- **checking**: "Checking for updates..." subtitle, spinner
- **available**: "Quill v0.7.1 is available" subtitle (accent color), "Download & Install" primary button
- **downloading**: "Downloading update... 45%" subtitle, thin progress bar below (accent fill)
- **ready**: "Update ready — restart to apply" subtitle (green), "Restart to Update" primary button
- **error**: "Update check failed" subtitle, "Retry" bordered button

**Row 3 — Auto-check Toggle**: "Check for updates automatically" + "Check on app launch" subtitle, Toggle on right (default on).

Use existing design tokens and components (Button, Toggle) from the design system.

---

## Phase 1: Version-Tracked DB Migrations

**File:** `src-tauri/src/db.rs` (MODIFY)

Current state: `Db::init()` runs all 4 SQL files via `execute_batch()` / `let _ =` on every startup — no version tracking.

### Changes

1. Bootstrap a `schema_version` table before anything else:
   ```sql
   CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
   ```

2. Read current version (`SELECT version FROM schema_version` — default 0 if empty).

3. Define ordered migrations array:
   ```rust
   const MIGRATIONS: &[(i64, &str)] = &[
       (1, include_str!("../migrations/001_init.sql")),
       (2, include_str!("../migrations/002_vocab.sql")),
       (3, include_str!("../migrations/003_chats.sql")),
       (4, include_str!("../migrations/004_pdf_support.sql")),
   ];
   ```

4. Run each migration with `version > current` inside a transaction. After each, `INSERT OR REPLACE` the version.

5. Migration 004 uses `ALTER TABLE` — wrap in `execute_batch` and ignore errors (same as today's `let _ =` approach) since "column already exists" is expected for existing users.

6. Keep `migrate_to_relative_paths()` call after migrations (unchanged).

---

## Phase 2: Updater Plugin (Backend)

### `src-tauri/Cargo.toml` (MODIFY)
Add:
```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

### `src-tauri/tauri.conf.json` (MODIFY)
- Add `"updater"` to bundle targets: `["dmg", "app", "nsis", "updater"]`
- Add top-level `plugins` section:
  ```json
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/yicheng47/quill/releases/latest/download/latest.json"
      ],
      "pubkey": "<PUBLIC_KEY — filled in after key generation>"
    }
  }
  ```

### `src-tauri/src/lib.rs` (MODIFY)
Register plugins after existing `.plugin()` calls:
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

### `src-tauri/capabilities/default.json` (MODIFY)
Add to permissions array:
```json
"updater:default",
"process:allow-restart"
```

---

## Phase 3: Updater UI (Frontend)

### npm dependencies
```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

### New file: `src/hooks/useUpdateChecker.ts`

Custom hook that manages the entire update lifecycle:

- **State:** `status` enum: `idle | checking | available | downloading | ready | error`
- **On mount:** 3-second delay, then call `check()` from `@tauri-apps/plugin-updater`
- **Returns:** `{ update, status, progress, error, checkForUpdate, downloadAndInstall, restart }`
- `checkForUpdate()` — manual trigger (for "Check Now" button)
- `downloadAndInstall()` — starts download, tracks progress via `onEvent` callback, calls `update.install()` when done
- `restart()` — calls `relaunch()` from `@tauri-apps/plugin-process`
- Auto-check errors are silently logged (no user disruption)
- Shared via React context (`UpdateProvider` wrapping `<App>`) so both toast and About section access the same state

### New file: `src/contexts/UpdateContext.tsx`

React context provider wrapping the `useUpdateChecker` hook. Exposes the update state and actions to any consumer via `useUpdate()`.

### New file: `src/components/UpdateToast.tsx`

ChatGPT desktop-style toast notification:
- Fixed position overlay (bottom-left, above any potential bottom UI)
- Compact: "Quill vX.Y.Z available" + "Update" button + dismiss X
- Appears when `status === "available"`
- "Update" button opens Settings modal to About section
- Auto-dismisses after 30 seconds
- Dismiss persists for session (doesn't re-show until next app launch)
- Smooth enter/exit animation (translate + opacity)

### Modify: `src/App.tsx`

- Wrap router with `<UpdateProvider>`
- Add `<UpdateToast />` as sibling to `<Routes>`
- Toast needs a callback to open Settings modal — pass `onOpenSettings` prop that navigates to About section

### Modify: `src/components/settings/AboutSettings.tsx`

Expand from minimal version display to full update management:

1. **App identity row** (existing) — Quill name, description, version badge
2. **Update status section:**
   - When idle/checking: "Check for Updates" button (secondary variant), shows spinner when checking
   - When available: new version number, "Download & Install" button (primary variant)
   - When downloading: progress bar (thin, accent-colored) with percentage
   - When ready: "Restart to Update" button (primary variant)
   - When error: error message with "Retry" button
3. **Auto-check toggle** — "Check for updates automatically" with Toggle component (persisted via settings `auto_check_updates`)

`AboutSettings` needs access to the update context — use `useUpdate()` from context.

### Modify: `src/i18n/en.json` (and `zh.json`)

Add keys:
```json
"settings.about.updateAvailable": "Quill {{version}} is available",
"settings.about.downloading": "Downloading update...",
"settings.about.readyToInstall": "Update ready — restart to apply",
"settings.about.restartToUpdate": "Restart to Update",
"settings.about.downloadInstall": "Download & Install",
"settings.about.upToDate": "You're up to date",
"settings.about.checking": "Checking for updates...",
"settings.about.autoCheck": "Check for updates automatically",
"settings.about.autoCheckHint": "Check on app launch",
"settings.about.updateError": "Update check failed",
"settings.about.retry": "Retry",
"update.toast.available": "Quill {{version}} available",
"update.toast.update": "Update"
```

---

## Phase 4: Release Workflow

### `.github/workflows/release.yml` (MODIFY)

Add signing env vars to **both** the macOS and Windows "Build Tauri app" steps:
```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

The `tauri-apps/tauri-action` automatically detects these and:
- Signs `.tar.gz` update bundles
- Generates `latest.json` with version, URLs, and signatures
- Merges both arch targets into one `latest.json`

---

## Implementation Order

1. **Phase 1** (DB migrations) — independent, safe to land first
2. **Phase 2** (backend plugin) — depends on nothing, can parallel with Phase 1
3. **Phase 3** (frontend UI) — depends on Phase 2 npm packages
4. **Phase 4** (CI workflow) — independent, can go any time

All phases in one branch (`feat/auto-update`).

---

## Files Summary

| File | Action |
|------|--------|
| `src-tauri/src/db.rs` | MODIFY — versioned migration runner |
| `src-tauri/Cargo.toml` | MODIFY — add updater + process plugins |
| `src-tauri/tauri.conf.json` | MODIFY — updater config + bundle target |
| `src-tauri/src/lib.rs` | MODIFY — register plugins |
| `src-tauri/capabilities/default.json` | MODIFY — add permissions |
| `package.json` | MODIFY — add npm deps |
| `src/hooks/useUpdateChecker.ts` | CREATE — update lifecycle hook |
| `src/contexts/UpdateContext.tsx` | CREATE — React context provider |
| `src/components/UpdateToast.tsx` | CREATE — toast notification |
| `src/components/settings/AboutSettings.tsx` | MODIFY — full update UI |
| `src/App.tsx` | MODIFY — wire provider + toast |
| `src/i18n/en.json` | MODIFY — add i18n keys |
| `src/i18n/zh.json` | MODIFY — add i18n keys |
| `.github/workflows/release.yml` | MODIFY — signing env vars |

---

## Prerequisites (manual, one-time)

1. Generate Ed25519 signing keypair: `npx @tauri-apps/cli signer generate -w ~/.tauri/quill.key`
2. Add GitHub repo secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
3. Paste public key into `tauri.conf.json` `plugins.updater.pubkey`

---

## Verification

1. `cargo check` — Rust compiles with new plugin deps
2. `npm run build` — frontend compiles
3. Dev mode: toast won't appear (no update endpoint in dev), but About section should render with "Check for Updates" button
4. Full E2E: publish v0.7.0 with updater, then v0.7.1 — launch v0.7.0 and confirm toast + download + restart cycle
