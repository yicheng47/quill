# Auto-Update — Implementation Plan

## Context

Quill currently distributes macOS builds via GitHub Releases (draft → manual publish), but users must manually download new versions. Adding Tauri 2's built-in updater plugin enables the app to check for updates on launch, prompt the user, and self-update — using the same GitHub Releases infrastructure already in place.

Also introduces a proper version-tracked DB migration system to ensure schema changes are safe across auto-updates.

---

## Prerequisites (manual, one-time)

1. **Generate Ed25519 signing keypair** locally:
   ```bash
   npx @tauri-apps/cli signer generate -w ~/.tauri/quill.key
   ```
2. **Add GitHub repo secrets**:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/quill.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — password (or empty if none)
3. Save the **public key** (printed to stdout) — it goes in `tauri.conf.json`

---

## Phase 1: Version-Tracked DB Migrations

### Files

| File | Action |
|------|--------|
| `src-tauri/src/db.rs` | MODIFY (rewrite `init()` with migration runner) |

### Details

Replace the current "run all SQL on every startup" approach with a versioned migration runner.

**Add a `schema_version` table** (bootstrapped before migrations run):
```sql
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
```

**Migration runner** in `db.rs`:
- On startup, read current version from `schema_version` (default 0 if empty)
- Define an ordered list of migrations: `[(1, "001_init.sql"), (2, "002_vocab.sql"), (3, "003_chats.sql"), (4, "004_pdf_support.sql")]`
- Run each migration with `version > current` inside a transaction
- After each migration, update `schema_version` to the new version
- Future migrations just add a new entry to the list + a new `.sql` file

**Handling existing users** (no `schema_version` table yet):
- `001_init.sql` through `003_chats.sql` use `CREATE TABLE IF NOT EXISTS` — safe to re-run
- `004_pdf_support.sql` uses `ALTER TABLE` — needs error-handling for "column already exists"
- After running all 4, set version = 4
- Future migrations (5, 6, ...) run normally from there

---

## Phase 2: Updater Plugin (Backend)

### Files

| File | Action |
|------|--------|
| `src-tauri/Cargo.toml` | MODIFY (add dependencies) |
| `src-tauri/tauri.conf.json` | MODIFY (add updater config) |
| `src-tauri/src/lib.rs` | MODIFY (register plugins) |
| `src-tauri/capabilities/default.json` | MODIFY (add permissions) |

### Details

**`Cargo.toml`** — Add:
```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

**`tauri.conf.json`** — Add `"updater"` to bundle targets:
```json
"targets": ["dmg", "app", "updater"]
```

Add `plugins` section at the top level:
```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/yicheng47/quill/releases/latest/download/latest.json"
    ],
    "pubkey": "<PUBLIC_KEY_FROM_PREREQUISITES>"
  }
}
```

The endpoint works because `tauri-apps/tauri-action` auto-generates and uploads `latest.json` as a release asset. The `/releases/latest/download/` URL resolves to the most recent **published** (non-draft) release — so the existing draft→publish workflow naturally gates when users see updates.

**`lib.rs`** — Add after existing `.plugin()` calls:
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

**`capabilities/default.json`** — Add to the `permissions` array:
```json
"updater:default",
"process:allow-restart"
```

---

## Phase 3: Updater UI (Frontend)

### Files

| File | Action |
|------|--------|
| `package.json` | MODIFY (add npm dependencies) |
| `src/hooks/useUpdateChecker.ts` | CREATE |
| `src/components/UpdateBanner.tsx` | CREATE |
| `src/App.tsx` | MODIFY (wire in hook + banner) |

### Details

**npm dependencies:**
```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

**Figma design first** — Design the update banner in Figma before implementing.

Style reference: **Arc browser's update banner**.
- **Bottom banner**, not a centered modal — non-intrusive, doesn't block the app
- **Compact**: single-line title ("New Quill Version Available"), progress bar, and a "Restart and Update" button
- **No dismiss button** — stays at bottom unobtrusively until the user acts
- **Inline progress bar** that fills as the update downloads
- Minimal, clean — fits Quill's existing aesthetic

**`useUpdateChecker.ts`** — Custom hook:
- Calls `check()` from `@tauri-apps/plugin-updater` on mount (3s delay to let app load)
- Returns: `update` object, `status` (idle/checking/available/downloading/ready/error), `progress`, `error`
- Exposes `downloadAndInstall()` and `restart()` callbacks
- Errors during auto-check are silently logged (don't bother the user)

**`UpdateBanner.tsx`** — Implement from the Figma design. Arc-style bottom banner:
- **Available/Downloading**: Title + progress bar + "Restart and Update" button
- Progress bar fills inline as download progresses
- Non-blocking — user can continue using the app

**`App.tsx`** — Add `useUpdateChecker()` hook and `<UpdateBanner>` as a fixed-bottom element. The banner appears when an update is detected and stays until the user restarts.

---

## Phase 4: Release Workflow

### Files

| File | Action |
|------|--------|
| `.github/workflows/release.yml` | MODIFY (add signing env vars) |

### Details

Add two env vars to the "Build Tauri app" step:
```yaml
TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

The `tauri-apps/tauri-action` detects these and automatically:
- Signs the `.tar.gz` update bundles
- Generates `latest.json` with version, download URLs, and signatures
- Merges both arch targets (aarch64 + x86_64) into the same `latest.json`

No other workflow changes needed.

---

## Notes

- The first release with updater support can't self-update (no prior version knows to check). Auto-update becomes functional from the second release onward.
- Draft releases are invisible to the updater endpoint — updates only appear after you publish the release on GitHub.
- No entitlements changes needed — app is not sandboxed and already makes outbound HTTPS (AI features).

## Verification

1. Generate signing keys and add secrets to GitHub
2. Apply all code changes, `cargo check` + `npm run build` to verify compilation
3. Tag and push a release (`v0.5.0`), let CI build, publish the draft release
4. Install the published build, then tag `v0.5.1`, build and publish
5. Launch the v0.5.0 build — should see update banner at the bottom
6. Click "Restart and Update" — app restarts on new version
