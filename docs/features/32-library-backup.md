# 32 — External Device Library Sync

**Issue:** [#228](https://github.com/yicheng47/quill/issues/228)
**Status:** Planned

## Motivation

"Library backup" is too narrow an abstraction. Quill has one active reading library, while a NAS archive and a Kindle/KOReader are external devices that exchange books with that library. They share the same lifecycle—configure, connect, preview, sync, and inspect status—but need different sync rules.

The NAS is the durable archive: users browse and import books from it, and may archive Quill books back to it. Removing a book from Quill must not delete the archived copy. A Kindle/KOReader is a reading device: it receives a managed mirror of the current Quill library, organized from Quill collections, and can remove books that are no longer selected for the device.

This is separate from Quill's iCloud event-log sync. External devices exchange book files and library organization; they do not become Quill peers or receive the app database, highlights, bookmarks, vocabulary, chats, or reading state.

## Product Model

- Quill exposes a **Devices** settings surface instead of a single backup destination.
- A device has a name, type, configured root path, availability state, last-sync result, and sync action.
- Each device adapter owns its direction, deletion policy, filesystem layout, and verification rules. "Sync" does not imply that every device is a symmetric two-way mirror.
- Before changing an external device, Quill shows a plan: files to add, update, keep, or remove, plus required space and any conflicts.
- The Quill database is the source of truth for the active reading set, metadata, and collections exported to reading devices. The NAS remains the durable archive of available books.

## Scope

### Shared device management

- Settings → Devices list with **Add device**.
- Configure a display name, device type, and mounted folder/root.
- Show connected/offline, ready, syncing, and error states.
- Show last sync time and summary counts.
- Manual **Preview sync** and **Sync now** actions.
- Incremental file comparison and post-copy verification.
- Clear offline/unmounted handling without changing Quill state.

### NAS archive

- Configure any mounted NAS share or folder as a NAS library.
- Browse/search supported EPUB and PDF files on the NAS and import selected books into Quill.
- Archive selected Quill books to the NAS without deleting the Quill copy.
- Treat NAS synchronization as additive by default. Removing a book from Quill never deletes it from the NAS archive.
- Preserve existing NAS files and organization; exact organization rules for newly archived books can be chosen during implementation.

### Kindle / KOReader

- Configure a mounted Kindle and its books directory.
- Mirror all Quill books by default, with the option to limit the device to selected collections.
- Build collection folders from current Quill membership and place uncollected books under `Unsorted/`.
- Add and update selected books; preview removal of books no longer in the device set before applying it.
- Preserve KOReader `.sdr` sidecar directories for books that remain at the same relative path.
- Verify the staged result, available space, destination checksums, and book count before reporting success.

### Out of scope

- Replacing Quill's iCloud sync or making NAS/Kindle full Quill peers.
- Syncing highlights, bookmarks, vocabulary, chats, reading progress, or application settings with external devices.
- A generic bidirectional conflict engine across all device types.
- Mounting network shares or storing SMB/NFS credentials; v1 works with paths already mounted by the OS.
- Cloud-provider APIs, wireless Kindle delivery, Calibre protocols, encryption, or compression.

## Implementation Phases

### Phase 1 — Device framework

- Add the Settings → Devices surface and persisted device records.
- Implement availability checks, preview/sync states, progress, errors, last-sync summaries, and a common adapter boundary.
- Build a verified staging-and-apply flow so device-specific adapters can plan changes before writing.

### Phase 2 — NAS archive adapter

- Index supported books from a configured NAS root.
- Add browse/search/import into Quill.
- Add manual archival from Quill to NAS with additive, non-destructive behavior.

### Phase 3 — Kindle/KOReader adapter

- Generate the export set from current Quill books and collection membership.
- Stage the collection-folder tree, preserve valid KOReader sidecars, preview removals, then mirror and verify.
- Support all-books and selected-collection device scopes.

### Phase 4 — Connection-triggered sync

- Optionally detect when a configured device becomes available and offer to sync.
- Keep automatic destructive mirroring opt-in; always surface the planned removals.

## Verification

- [ ] Add a mounted NAS folder → it appears as an available NAS device with a successful connection check.
- [ ] Browse the NAS → import one EPUB/PDF → Quill owns its local copy and leaves the NAS original untouched.
- [ ] Archive a Quill book to NAS → file is copied and verified; deleting the Quill book later does not delete the archive copy.
- [ ] Add a mounted Kindle → preview shows the exact Quill books and collection folders to add/update/remove.
- [ ] Sync Kindle → selected books appear under collection folders and uncollected books under `Unsorted/`.
- [ ] Re-sync unchanged Kindle → no book files are recopied.
- [ ] Remove a book from the Kindle scope → preview reports the removal before it is applied.
- [ ] Existing KOReader `.sdr` data for retained books survives a sync.
- [ ] Disconnect either device mid-sync → Quill reports failure without corrupting its library or claiming success.
- [ ] Device is offline/unmounted → Devices shows a clear unavailable state and Quill remains usable.
