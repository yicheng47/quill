# Regression Suite

Quill's maintained list of live regression cases: actions in the running app and what to observe. It holds no results; each run is recorded in `docs/tests/runs/`, as [Recording a run](#recording-a-run) describes. Unit tests stay with the code and run in CI (`cargo test`, `npm test`).

## When to run it

- **A feature or fix** selects only the cases its diff affects, plus its own checks, under [Test Scope](../../../AGENTS.md#test-scope). The suite does not widen a feature's scope.
- **A release** runs the smoke tier on macOS, in the development app at the `main` commit being released, before the version is bumped. Jason can waive it for a release.
- **A major change** runs the full suite: a sync or storage rewrite, a schema migration, a shell change such as [#327](../../features/327-electron-shell.md), or an engine upgrade.

## Environments

- **dev** — the development app, `make dev`, with development data under `com.wycstudios.quill-dev`. Live testing here is standing-authorized under Test Scope. **iCloud sync stays off.** Only one development app runs at a time. During #327 the Electron development app, `make electron-dev`, uses the same data.
- **signed** — an installed, signed build. It uses the production identity and data directory, so it runs only in a separate macOS user account or VM that Jason prepares, never in his own account.
- **jason** — needs Jason's setup or hands, such as iCloud sync between two devices or accounts.

Platforms are macOS (`mac`) and Windows (`win`). A `win` instance runs on Jason's Windows machine.

## Tiers

- **smoke** — the short set for a release, and for every #327 phase on the shell it touched.
- **full** — everything else. A full run selects both tiers.

## Test corpus

Seven public-domain books in `~/QuillTestCorpus/`, outside the repo. Every run uses the same files, and because none is copyrighted they may appear in run records and screenshots. To rebuild the folder on another machine, download each source and check its SHA-256 prefix.

| File | Covers | Source | SHA-256 |
|---|---|---|---|
| `01-plain-frankenstein.epub` | a plain English EPUB | [Standard Ebooks](https://standardebooks.org/ebooks/mary-shelley/frankenstein/downloads/mary-shelley_frankenstein.epub?source=download) | `0b5c070e2cde4d8b` |
| `02-cjk-vertical-kusamakura.epub` | Japanese vertical writing, right-to-left page order, an embedded font | [EPUB 3 samples](https://github.com/IDPF/epub3-samples/releases/download/20230704/kusamakura-japanese-vertical-writing.epub), 17.9 MB | `6d4d4ed5eda3f612` |
| `03-notes-fonts-wasteland.epub` | 50 footnotes and three embedded fonts | [EPUB 3 samples](https://github.com/IDPF/epub3-samples/releases/download/20230704/wasteland-otf.epub) | `d99ea3b847d713a8` |
| `04-large-pride-and-prejudice-illustrated.epub` | an EPUB over 5 MB with 164 images | [Project Gutenberg](https://www.gutenberg.org/ebooks/1342.epub3.images), 24.9 MB | `fd519471687295a8` |
| `05-text-us-constitution.pdf` | a text PDF, 85 pages | [govinfo](https://www.govinfo.gov/content/pkg/CDOC-110hdoc50/pdf/CDOC-110hdoc50.pdf) | `7f29c4a79e310cc7` |
| `06-scanned-alice-1901.pdf` | a scanned PDF with an OCR layer, 290 pages | [Internet Archive](https://archive.org/download/adventuresalices00carrrich/adventuresalices00carrrich.pdf) | `7454835757666fd7` |
| `07-1000-pages-us-budget-2025-appendix.pdf` | a PDF of 1000+ pages: 1,298 | [govinfo](https://www.govinfo.gov/content/pkg/BUDGET-2025-APP/pdf/BUDGET-2025-APP.pdf) | `878f0fd2950f06a2` |

The case descriptions name these files by what they cover: "the 1000-page PDF" is file 07, "the 5 MB EPUB" is file 04, and so on.

## Cases

### Library

| ID | Tier | Platforms | Env | Check |
|---|---|---|---|---|
| LIB-01 | smoke | mac, win | dev | Import an EPUB with the Import button and file dialog: the book appears with its cover, title and author. |
| LIB-02 | smoke | mac, win | dev | Import a text PDF and a scanned PDF: covers and metadata appear, and the import never hangs (#216, #222). |
| LIB-03 | full | mac, win | dev | Drag an EPUB and a PDF onto the library window: the drop overlay shows, and both import. |
| LIB-04 | full | mac, win | signed | Open an EPUB from Finder or Explorer with Quill (file association) and drop one on the macOS dock icon: it imports or opens. |
| LIB-05 | full | mac | dev | With 300+ books, the library scrolls through every page, search filters, and grid and list views both render. |
| LIB-06 | full | mac | dev | All books, Currently reading and Finished filter correctly. Mark finished, mark unread and continue reading from the book menu. |
| LIB-07 | full | mac | dev | Create, rename and delete a collection; add a book to it and remove it. |
| LIB-08 | full | mac | dev | Edit a book's title and author: the change persists after restart. |
| LIB-09 | full | mac | dev | Delete a book: it disappears, and reopening the app does not bring it back. |

### Reader

| ID | Tier | Platforms | Env | Check |
|---|---|---|---|---|
| RDR-01 | smoke | mac, win | dev | Open an EPUB in its reader window, turn pages, close, reopen: it resumes at the same position. |
| RDR-02 | full | mac | dev | Reader settings apply live and persist: font, line, character and word spacing, margins, the four themes, scrolling vs page turning, one vs two pages. |
| RDR-03 | full | mac | dev | The table of contents panel opens, expands sections and jumps to a chapter. |
| RDR-04 | smoke | mac, win | dev | Open the 1000-page PDF: pages render, fit and zoom work, scroll mode works, and position resumes after reopening. |
| RDR-05 | full | mac | dev | PDF text selection follows the pointer precisely, after zoom and resize too (#52, #153). Record any difference from the baseline. |
| RDR-06 | smoke | mac, win | dev | Highlight text in an EPUB and in a PDF: each appears in the highlights panel and re-renders in place after reopening. |
| RDR-07 | full | mac | dev | Add bookmarks, list them, and jump to one. |
| RDR-08 | full | mac, win | dev | Open two books in two reader windows. Clicking an already open book in the library focuses its window, and restores it when minimized (#323). Closing a reader window leaves the others. |
| RDR-09 | full | mac, win | dev | ⌘/Ctrl +, − and 0 zoom the content of the focused reader only. App zoom in Appearance scales the whole UI of every window (#318, #319, #295). |
| RDR-10 | full | mac | dev | Time to first page for the 1000-page PDF and the 5 MB EPUB, recorded against the baseline. |
| RDR-11 | full | mac | dev | The CJK and vertical-writing EPUB renders, paginates and accepts highlights correctly. |

### AI

Use an inexpensive model with tiny prompts.

| ID | Tier | Platforms | Env | Check |
|---|---|---|---|---|
| AI-01 | smoke | mac, win | dev | Look up a word: the definition streams in, and Save adds it to vocabulary. |
| AI-02 | full | mac | dev | Explain a passage: the answer streams, and Quote puts the passage in the chat composer. |
| AI-03 | full | mac | dev | Translate a selection: the translation streams in the configured language. |
| AI-04 | smoke | mac, win | dev | In a reader, chat with the AI panel: the reply streams, the chat gets a generated title, and "open in reader" from a message jumps to the passage. |
| AI-05 | full | mac | dev | The Chats page loads more chats as it scrolls, search filters, a chat opens in detail, and deleting one removes it. |
| AI-06 | full | mac | dev | Providers: an API-key provider works; the ChatGPT login opens the browser, returns to Quill, loads the model list, and the effort tiers apply (#294). Ollama if available. Restore the provider settings afterwards. |
| AI-07 | full | mac | dev | With no provider configured, AI actions show the "open settings" prompt instead of failing silently. Restore the provider afterwards. |

### Vocabulary

| ID | Tier | Platforms | Env | Check |
|---|---|---|---|---|
| VOC-01 | full | mac | dev | The Words list searches and filters by book. The detail modal opens, "open in reader" jumps to the saved location, and delete removes the word. |

### Settings

| ID | Tier | Platforms | Env | Check |
|---|---|---|---|---|
| SET-01 | smoke | mac, win | dev | Every settings tab opens and saves. Switching the language to 中文 and back re-renders the UI. Theme light, dark and system apply. About shows the version, and its links open in the browser. |
| SET-02 | full | mac | dev | The theme and language survive a restart, with no flash of the wrong theme at launch. |
| SET-03 | full | mac, win | dev | Reveal Logs, from settings and from the Help menu, opens the log folder, and `quill.log` is being written. |

### MCP

The integration toggles write the same `quill` entry into `~/.claude.json` and `~/.codex/config.toml` that the installed Quill uses, so the development app's toggles repoint Jason's real integration, and turning one off removes the entry. Record both `quill` entries before these cases and put them back afterwards, changing nothing else in either file: running Claude Code sessions rewrite `~/.claude.json` all the time, so restoring a whole-file backup would lose their changes. Then confirm with `claude mcp list` and `codex mcp list` that the entry runs the installed app again.

| ID | Tier | Platforms | Env | Check |
|---|---|---|---|---|
| MCP-01 | full | mac | dev | Turn on the Claude Code and Codex integrations: each client lists Quill's tools, and `list_books` returns the dev library. The copied config snippet works when pasted by hand. |
| MCP-02 | full | mac | dev | With write access off, write tools are refused. With it on, a book added through MCP appears in the open app without a restart. |

### App lifecycle

| ID | Tier | Platforms | Env | Check |
|---|---|---|---|---|
| APP-01 | smoke | mac, win | dev | Launch: the main window appears at its size with no white flash, and the library is populated. |
| APP-02 | full | mac, win | dev | macOS: closing the main window hides it, the dock click brings it back, and ⌘Q quits with reader windows open. Windows: closing the main window closes every window. |
| APP-03 | full | mac, win | dev | Menus: Check for Updates shows the update toast; Reveal Logs works; Edit-menu copy and paste work in text fields and the reader. |
| APP-04 | full | mac | dev | Traffic lights sit correctly in the main and reader windows, including at app zoom other than 100%. Windows drag by their titlebar regions, and the chat titlebar drags (#321). |
| APP-05 | full | mac, win | dev | Launching Quill again focuses the running app instead of starting a second one. On Windows, a second launch with a book argument opens the book. |
| APP-06 | full | mac, win | signed | Update in-app from the previous build to the candidate: the download, install and relaunch complete, and the app opens on the new version. |

### Sync

These cases need Jason's environment and never run in the development app.

| ID | Tier | Platforms | Env | Check |
|---|---|---|---|---|
| SYN-01 | full | mac | jason | Turn sync on: the copy-to-iCloud progress runs to completion, and the library is intact afterwards. |
| SYN-02 | full | mac | jason | A change on device A (import, highlight, progress, collection) appears on device B, covers included. Sync now and the status line work. |
| SYN-03 | full | mac | jason | Turn sync off, rebuild from iCloud, and remove a peer device. Each completes, and the library is intact. |
| SYN-04 | full | mac | jason | A book evicted from local iCloud storage downloads when opened. |

### Measurements

Recorded, not pass/fail; a large regression is raised with Jason before release. A debug build is not representative, so sizes come from the release artifacts and the rest run in the signed environment.

| ID | What |
|---|---|
| MEAS-01 | Installed app size, and download size per platform |
| MEAS-02 | Memory at idle with the library open, and with one EPUB and one PDF open |
| MEAS-03 | Cold start time to a populated library |

## Automation

Nothing can drive the Tauri app on macOS, because WKWebView has no WebDriver, so every case runs by hand or through computer use. From #327's phase 3, Playwright drives the Electron app, and the suite gains an Auto column naming the test that covers each case whose whole Check a test asserts; CI then runs those tests on macOS and Windows. Rendering quality, PDF selection feel, native window chrome, signed builds, upgrades and sync stay with computer use.

## Recording a run

Each run is one file, `docs/tests/runs/YYYY-MM-DD-<platform>.md`, where platform is `mac`, `win` or `both`. A second run on the same day adds its own block to that file. A run records:

- the candidate: commit, build, shell, environment, and what the run is for, such as a release or a #327 phase
- one row per selected case and platform: the ID, the result and its reason. A result is Passed, Failed, Blocked (a prerequisite was missing) or Skipped (outside the run's scope).
- any setting a case changed, its backup, and confirmation it was restored
- the measurements, when taken

Screenshots stay outside the repo, at a path the record names. Every failure has one, and so does every pass that differs from the run it is compared with. A failure keeps its row after it is fixed; the rerun is a new row. Keep API keys, account names and private book content out of the record.

## Changing the suite

IDs are stable and never reused. Add a case with the next unused number in its area. A case whose expectation changes is retired, keeping its row with the reason and its replacement, and the new expectation gets a new ID. A feature's lasting live checks are added here in the release's docs sweep.
