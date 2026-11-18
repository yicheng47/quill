# 331 — Design Map & Token Reference (`331-rebrand.pen`)

Design source: `quill/desktop/specs/331-rebrand.pen` at revision `fd7c334` in `YeelinksCo/yeelinks_design`. Read frames through the Pencil MCP by the node IDs below, after pulling the design repo; when a reference image helps, export or screenshot the node into your own scratch directory. No local exports are kept.

## 1. Complete Frame & Board Inventory (60 Nodes)

| Section | Node ID | Frame / Board Name | Size | Owning Mission | Key States & Details |
|---|---|---|---|---|---|
| Design System | `t405CC` | `331 / Design system — Foundations` | `2980×2883` | **M1** | Dawn atmosphere, glass surfaces, violet/semantic/highlight swatches, Geist / Geist Mono / Literata type scale (`28px` page titles, `22px` settings pane headers) |
| Design System | `Owck6` | `331 / Design system — Components` | `1720×4485` | **M1** (`eY7n3` in **M4**) | All 29 reusable `cmp/*` controls, `cmp/TopBar` (`pL47g` with gear `qPeyq`), `cmp/Menu` (`L18aJ`), `cmp/SettingsNav` (`eY7n3`) |
| Home | `m2srt` | `331 / Home` | `1440×960` | **M3** | Populated bento: `Now reading`, `Saved words`, `Last conversation`, `Library` 5-up shelf, `Also reading` + `Collections` chips |
| Home | `CjQ94` | `331 / Home — Global Search (⌘K)` | `1440×960` | **M2** (Books) / **M3** (All) | Centered 680px glass palette, scope chips (`All · Books · Highlights · Words · Chats`), grouped hits, keyboard hint bar |
| Home | `BC0DA` | `331 / Home — Drag & Drop Overlay` | `1440×960` | **M2** | Centered 500px `Drop books to add to Quill` dashed `$accent` card over blurred scrim (`isDragging`) |
| Home | `BUxUo` | `331 / Home — Importing Progress` | `1440×960` | **M2** | Centered 440px `Importing <N> books…` spinner card + `>5s` large-PDF hint over blurred scrim (`importing`) |
| Home | `J6aW1P` | `331 / Home — Import Error Toast` | `1440×960` | **M2** | Un-dimmed interactive window with top-center 560px dismissible `Couldn't import book` danger toast (`importError`) |
| Home | `XkjMq` | `331 / Home — First Launch (Empty Library)` | `1440×960` | **M3** | `Your quiet reading room` welcome hero (`zGWcv`) + `Empty Bento Trio` (`OqN9H`: `I4cPVe` highlight/note specimen, `Gh64n` `palimpsest` lookup specimen, `f6Yyeq` quoted chat specimen) |
| Library | `RhsF8` | `331 / Library` | `1440×960` | **M2** | 6-up `cmp/BookCard` grid, `All / Reading / Finished / Unread` count segments, `Collections` trigger, `Grid / List` toggle |
| Library | `A03E8` | `331 / Library — List View & iCloud Books` | `1440×960` | **M2** | Rich glass list container (`hx6EF`): cover, collection chips, description, pages, progress bar, `Finished` check, undownloaded iCloud row (`Download from iCloud` pill + cloud badge) |
| Library | `Zzvta` | `331 / Library — Collections & Add New Collection` | `1440×960` | **M2** | Active collection header (`+ Add Books` pill + tinted `Collections` trigger) and open 348px `Collections & Create Popover` (`w1Xj8J`: `All books`, drag-reorder `⋮⋮`, edit/delete icons, inline `NEW COLLECTION` form `ZTS5T`) |
| Library | `F7B1gQ` | `331 / Library — Book Context Menu & Add to Collection` | `1440×960` | **M2** | `BookContextMenu` (`rFUsR`) + cascading `Add to Collection Submenu` (`aoADt`: multi-collection checkmarks + inline `+ NEW COLLECTION & ADD BOOK` row `WlcB8`) |
| Library | `r532a5` | `331 / Library — Collection Flows, Add Books Picker, Edit Metadata & Empty States` | `2480×563` | **M2** | Col 1: default `New collection…` footer, inline rename, `Delete collection` non-destructive modal; Col 2: empty collection card + multi-select `Add Books Picker Modal` (`PCIT1`); Col 3: `Edit Book Info` modal (`b4om2`), `Delete Book` modal (`MQihI`), no-match search state (`ig0MO`) |
| Reader | `ECLAp` | `331 / Reader — Chat open` | `1440×960` | **M7** | Paper page + open right `Ask Quill` glass island (quoted passage, streaming bubbles, follow-up chips, composer, model footer) |
| Reader | `yvlbP` | `331 / Reader — Chat closed` | `1440×960` | **M6** | 64px Dawn reader toolbar, centered Paper island (`#FDFCFA`), floating bottom `Progress pill` |
| Reader | `U3KZf8` | `331 / Reader — Contents` | `1440×960` | **M6** | Left `Contents` TOC glass island + `← Back to p. N` jump-back pill next to `Progress pill` |
| Reader | `pB71W` | `331 / Reader — Highlights & Toolbar` | `1440×960` | **M6** | Right `Highlights` tab of `BookmarksPanel` (color filter dots + search + cards) + inline 5-dot `HighlightToolbar` (`hxqCJ`) |
| Reader | `rdcDH` | `331 / Reader — Selection Menu` | `1440×960` | **M7** | Floating `ReaderContextMenu` (`B2siF`: `Look Up`, `Explain`, `Quote in Chat`, `Translate`, 5 highlight dots, `Copy ⌘C`) |
| Reader | `xqqVr` | `331 / Reader — Word Lookup & Book Words` | `1440×960` | **M7** | Floating `LookupPopover` (`tS7gX`) + right `Words in Book` glass island (`N0gxbh` with `Open in Words →`) |
| Reader | `ZpzpR` | `331 / Reader — Explain & Quote in Chat` | `1440×960` | **M7** | Floating `ExplainPopover` (`Z9ULVg`) + `Ask Quill` starter-prompts empty state + `Pending Quote Chip` (`hPfVt`) |
| Reader | `GWA41` | `331 / Reader — Translate & Bookmarks Tab` | `1440×960` | **M6** (Bookmarks) / **M7** (Translate) | Floating `TranslationPopover` (`t0TRJ` with language chip & context toggle) + right `Bookmarks` tab (`Y8okGe`) |
| Reader | `Zd3OK` | `331 / Reader — Typography & Sepia Theme (Sepia shell)` | `1440×960` | **M6** | Sepia page (`#F4ECD8` / `#EFE6D5`) on the parchment shell + `Typography Popover` (`j9ODh`: font size slider, 4 theme swatches, font select, layout mode, spacing steppers, margins) |
| Reader | `N4bEY` | `331 / Reader — Dark Page & Thread Switcher (Nocturne shell)` | `1440×960` | **M6** (Dark page) / **M7** (Switcher) | Dark page (`#1E1D24` / `#1B1B1F`) in the Nocturne shell + `Ask Quill` `Thread Switcher Dropdown` (`pp2Tt`) |
| Reader | `ZKLDp` | `331 / Reader — PDF Spread & Zoom` | `1440×960` | **M6** | Two-page PDF spread on Dawn + `PDF Progress & Zoom Pill` (`EoKCM`: `Page X–Y of N`, `− 100% · Fit +`) + compact PDF `Aa` popover (`aCUa5`) |
| Reader | `IjTTv` | `331 / Reader — Book in iCloud` | `1440×960` | **M6** | Evicted iCloud book view: cover card, `In iCloud` metadata pill, `Download Book` primary CTA + `Back to Library` |
| Highlights | `eKFrn` | `331 / Highlights` | `1440×960` | **M3** | Book-scoped view: left `Books` rail (`t8712W`) + right book header (`Open book`) and passage list (`FIjT2`) |
| Highlights | `zWiKF` | `331 / Highlights — All Books Stream, Color Filter & Hover Actions` | `1440×960` | **M3** | `All highlights` active in left rail, 4-color swatch filter pill (`t9XZk`), `Filter highlights…` search, cross-book attribution cards, hover action bar (`gMXYM`) |
| Highlights | `SiLV6` | `331 / Highlights — Inline Note Editor, Sort Menu & Delete Confirm` | `1440×960` | **M3** | Expanded inline margin-note editor (`Xh0Fy`), `Sort Popover` (`diueu`: `Newest first · Oldest first · Book chapter order`), `Remove this highlight & note?` popover (`utGLD`) |
| Highlights | `JSI0p` | `331 / Highlights — Empty State (No Highlights Yet)` | `1440×960` | **M3** | Full-pane glass empty state with 4 color-bar preview swatches + `Open a Book to Start Reading` CTA |
| Words | `rylLh` | `331 / Words` | `1440×960` | **M3** | Month-grouped left list (`s4IRPk`) + right detail pane (`YX6Fh`: headword, audio/IPA/POS, `MEANING`, `IN CONTEXT` paper card + `Go to passage`, `IN THIS PASSAGE`) |
| Words | `A4GWjG` | `331 / Words — A–Z Sort & Book Filter Popover` | `1440×960` | **M3** | `A–Z` alphabetical letter headers (`C · E · G · I · L · P`) + open `Book Filter Popover` (`E5Ldme` with per-book counts) |
| Words | `l6BCnh` | `331 / Words — Timed 2-Click Delete & Filtered No-Match` | `1440×960` | **M3** | Armed 3-second `Click again to delete` danger pill (`jsJ47`) in detail header + left-rail `No saved words match` search empty state |
| Words | `DjXY3` | `331 / Words — Empty State (No Saved Words Yet)` | `1440×960` | **M3** | Full-pane glass empty state (`No saved words yet` + `Browse Library`) |
| Chats | `ETt8K` | `331 / Chats` | `1440×960` | **M3** | Month-grouped left list (`hUOWK`) + right conversation pane (`S1OFzC`: header with `Open in book` + `⋯`, quoted passage, bubbles, live composer) |
| Chats | `BsJqG` | `331 / Chats — Book Filter, Inline Rename & Thread Menu` | `1440×960` | **M3** | Open `Chat Book Filter Popover` (`u1nC3` with counts), inline header title-rename input (`WCcae`), and `Thread More Menu` (`SGaEg`: `Rename`, `Open in book`, `Copy as Markdown`, `Delete`) |
| Chats | `S4d1bF` | `331 / Chats — Auto-Titling State & Delete Conversation Modal` | `1440×960` | **M3** | `Generating title…` header spinner state (`f5BTo`) + centered `Delete conversation?` confirmation modal (`u68JKl`) |
| Chats | `y4fAJ` | `331 / Chats — Empty State (No Conversations Yet)` | `1440×960` | **M3** | Full-pane glass empty state (`No conversations yet` + `Open a Book`) |
| Settings (APP) | `xEUTG` | `331 / Settings — General` | `1440×960` | **M4** (`#276` separate) | `PROFILE` (`Display name` + `Edit`, `Interface language`); `DATA` (`Reset all data`) stays hidden until `#276` ships |
| Settings (APP) | `MR9Fc` | `331 / Settings — Appearance` | `1440×960` | **M4** (Light) / **M8** (All) | `System` / `Light` / `Dark` theme preview cards + `App zoom` stepper (`HL8wn`) |
| Settings (APP) | `a1k3n` | `331 / Settings — Reading` | `1440×960` | **M4** | Default theme swatches, `Literata` font option, size/line/character steppers, margin selector, auto-save progress |
| Settings (APP) | `dkFHc` | `331 / General — Inline Name Edit & Reset All Data (#276)` | `1160×610` | **M4** (1) / **#276** (2) | Section 1 (`dZCgL`): inline `Display name` edit (`Cancel` / `Save`) in **M4**; Section 2 (`kMNwv`): 2-step `RESET` modals reserved for **#276** |
| Settings (AI) | `k9Vj9` | `331 / Settings — AI Assistant` | `1440×960` | **M5** | ChatGPT OAuth connected (`Connected` pill, email, `Sign out`), model & reasoning effort selects, `Temperature` stepper |
| Settings (AI) | `XIfpn` | `331 / Settings — AI Assistant (Signed out)` | `1440×960` | **M5** | ChatGPT disconnected state (`Sign in with ChatGPT` primary CTA + privacy note) |
| Settings (AI) | `lXiaG` | `331 / Settings — AI Assistant (API Key)` | `1440×960` | **M5** | Masked API key (`Saved` badge + `Clear`), `Base URL`, `Model`, `Temperature` |
| Settings (AI) | `qbLwo` | `331 / Settings — Tools` | `1440×960` | **M4** | Lookup & translation target-language and dictionary preferences |
| Settings (AI) | `o04NH` | `331 / AI Auth — Browser Sign-in, Sign-out & Session Expiry` | `2404×687` | **M5** & **M7** | Waiting for browser sign-in + `Cancel`, failed sign-in + `Try again`, `Ollama` local server card (`Running` badge + keep-alive), `Sign out` modal, and `#325` `AI_REAUTH_REQUIRED` / `AI_NOT_CONFIGURED` prompt cards |
| Settings (INT) | `HUr9u` | `331 / Settings — iCloud Sync` | `1440×960` | **M4** | Healthy synced state (`Synced` pill, `Compact log`, `Sync now`), `DEVICES` card (`This Mac`, pending badge, peer trash), `REPAIR` (`Rebuild from iCloud`) |
| Settings (INT) | `MpBgt` | `331 / Settings — iCloud Sync (Off & Signed-out)` | `1440×960` | **M4** | Local-only `Off` card + `!available` macOS not-signed-into-iCloud-Drive disabled state with amber System Settings hint |
| Settings (INT) | `stXkC` | `331 / Settings — iCloud Sync (Paused & Error)` | `1440×960` | **M4** | Queue-only offline session (`sync_enabled` toggle stays ON, `Paused` pill, actions disabled), failed move banner + `Retry`, manifest-cached offline `DEVICES`, disabled `REPAIR` |
| Settings (INT) | `t47BM` | `331 / Settings — MCP` | `1440×960` | **M4** | Claude Code / Codex integration switches, write-access toggle, and copyable `quill-mcp` JSON snippet |
| Settings (INT) | `tcZmU` | `331 / iCloud Sync — Active Progress, Safe Local Copy & Confirmations` | `1928×801` | **M2** (TopBar chip) / **M4** | TopBar `%` sync chip (`yMmME`), active replay card + `Cancel sync`, single-device empty peers (`J7RzUE`), `Turn on`/`Turn off` modals, blocking `Copying library to this Mac…` modal (`gFwqY`), Cancel-focused `Remove Device` & `Rebuild Library` modals |
| Settings (SYS) | `HnSex` | `331 / Settings — Updates` | `1440×960` | **M4** | `Up to date` hero card (`Check Now`), `AUTOMATIC UPDATES` switches, `RELEASE NOTES` link |
| Settings (SYS) | `TL2Mh` | `331 / Settings — About` | `1440×960` | **M4** | App identity card (`v2.0.0` + `macOS · arm64` pill), `DIAGNOSTICS` (`Application logs` → `Reveal in Finder`), `LINKS & LICENSE` |
| Settings (SYS) | `Rh6Ai` | `331 / Updates — TopBar Indicator, Ready Popover & Hero States` | `2248×845` | **M2** (left) / **M4** (right) | Left: `$accent` violet 24px `TopBar` indicator (`ArdQm`) & 264px `Ready` popover; Right: 6 `Settings → Updates` hero cards (`Checking`, `Available` + skip, `Downloading` + cancel, `Ready` + open-books count, `Failed`) |
| Dark Mode | `q62MgQ` | `331 / Dark Mode — Home` | `1440×960` | **M8** | `theme: {mode: "dark"}` Nocturne validation on `Home` bento |
| Dark Mode | `Y803E5` | `331 / Dark Mode — Library` | `1440×960` | **M8** | `theme: {mode: "dark"}` Nocturne validation on `Library` grid |
| Dark Mode | `T1qAJe` | `331 / Dark Mode — Reader (Chat open)` | `1440×960` | **M8** | `theme: {mode: "dark"}` Nocturne validation on `Reader` + `#1B1A23` dark paper + `Ask Quill` |
| Dark Mode | `CPGY5` | `331 / Dark Mode — Settings (Appearance)` | `1440×960` | **M8** | `theme: {mode: "dark"}` Nocturne validation on `Settings` with `Dark` card active (`$accent` border + check badge) |
| Decisions | `EiiRQ` | `331 / Dawn Background — Violet Mist` | `1600×2332` | **M2** | Chosen Dawn background (one violet glow); Home and Library on the new tokens |
| Decisions | `luJ5A` | `331 / Reader Shell by Page Theme` | `6112×1356` | **M6** | Reader shell per page theme: Original → Dawn, Sepia → parchment, Gray → gray, Dark → Nocturne |

## 2. Reusable Component Map (29 `cmp/*` Nodes)

| ID | Component | Notes & Key Child IDs |
|---|---|---|
| `YJzBT` | `cmp/AppIcon` | 160×160 rounded gradient tile (`200deg` `#6D5BFF` → `#9D7BFF`) + Lens Q path (`zT8k4` / `Zl9lU`) |
| `Qn3yN` | `cmp/Logo` | 28×28 TopBar brand mark |
| `dQPy4` / `bxuJY` / `hgP6m` / `sSlcb` | `cmp/Button/{Primary,Secondary,Tonal,Ghost}` | Pill buttons (`radius-pill`, Geist 13–14px medium/semibold) |
| `zAQ2O` | `cmp/IconButton` | Circular glass/ghost icon button (icon child `mHMFs`) |
| `ftSdu` / `f9etJ` | `cmp/NavItem`, `cmp/NavItem/Selected` | TopBar center route pills (`Ng4xY` / `SqeCo`) |
| `u0iDEV` / `J6vdqm` | `cmp/Segment`, `cmp/Segment/Selected` | Segmented filter pills with count (`L6wQde`/`t8uqp6`, `AbYXw`/`OlSuM`) |
| `J4HUSJ` / `X7qEu` | `cmp/Chip`, `cmp/Chip/Selected` | Compact word/collection/prompt chips |
| `s4jyn` / `YzNir` / `u186N` | `cmp/SearchField`, `cmp/TextField`, `cmp/Select` | Glass/inset inputs (`tlvlC`, optional trailing icon `U9tFa4`; select icon `dOy7C`, label `m6n53R`) |
| `Hrl33` | `cmp/ProgressBar` | Track + `$progress` fill (`WLsTJ`) |
| `cUO8L` / `FZj9a` / `p7qVy9` | `cmp/Badge/{Percent,Done,Status}` | Cover progress pill, finished check pill, status dot pill (`O5Kmrs`) |
| `rOfOl` / `mAXDg` | `cmp/BookCard`, `cmp/ListRow/Book` | Cover (`L4UzP` with spine sheen + shadow), title (`Rqyni`), author (`QQjNA`) |
| `JNL75` / `L18aJ` | `cmp/Tile`, `cmp/Menu` | Frosted glass bento card (`blur: 30`); frosted context menu (`blur: 34`) |
| `k2vkv` / `mpX3l` / `t8bou` | `cmp/Switch`, `cmp/Stepper`, `cmp/SettingsRow` | Settings row (`72px`, title `WFl1V`, hint `bF73k`, control slot `MiZTL`) |
| `pL47g` | `cmp/TopBar` | 71px top bar: nav tabs `bYZ7l` Home, `qslzy` Library, `QETwa` Highlights, `iTtJW` Words, `Wodic` Chats; right actions `HSHBm` Search, `CG99X` Import, `qPeyq` Settings |
| `eY7n3` | `cmp/SettingsNav` | 4-group (`APP · AI · INTEGRATIONS · SYSTEM`), 9-item left glass rail + footer version badge |

## 3. Dawn (`light`) & Nocturne (`dark`) Semantic Tokens

| Token | Dawn (`light`) | Nocturne (`dark`) | Usage |
|---|---|---|---|
| `bg-start` / `bg-end` | `#EEEBF8` / `#F7F5F3` | `#12111A` / `#17151F` | `135deg` base window gradient |
| `bg-glow-violet` | `#D4CCFF73` | `#42358A4D` | Radial glow at `10% 5%` (`110% × 110%`) |
| `bg-glow-peach` | — (removed) | `#59352E33` | Radial glow at `95% 15%` (`90% × 90%`) |
| `bg-glow-mint` | — (removed) | `#1D474233` | Radial glow at `55% 105%` (`120% × 80%`) |
| `surface-glass` | `#FFFFFFB8` | `#1E1D29CC` | Primary islands/panes (`backdrop-filter: blur(30px)`) |
| `surface-glass-border` | `#FFFFFFE6` | `#FFFFFF17` | 1px outer glass border |
| `surface-inset` | `#FFFFFF99` | `#15141DB3` | Recessed settings/specimen cards (`1px border-subtle`) |
| `surface-chip` | `#FFFFFFCC` | `#282636E6` | Pills, icon buttons, subtle tags |
| `surface-solid` | `#FFFFFF` | `#232130` | Elevated popovers, modals, active hover cards |
| `paper` / `paper-edge` | `#FDFCFA` / `#15151A0F` | `#1B1A23` / `#FFFFFF12` | Reader page & `In context` quote cards |
| `reader-shell-sepia-start` / `end` / `glow` | `#F0E7D4` / `#F6F0E5` / `#E8CFA659` | — | Reader shell around the `Sepia` page (`135deg` base, glow at `12% 0%`) |
| `reader-shell-gray-start` / `end` | `#D2D2D8` / `#D8D8DE` | — | Reader shell around the `Gray` page (`135deg`, no glow) |
| `reader-island-sepia` / `-border` | `#F7F0E1` / `#E4D8BE` | — | Side panels, pills and popovers on the `Sepia` page |
| `reader-island-gray` / `-border` | `#EDEDF0` / `#D4D4DA` | — | Side panels, pills and popovers on the `Gray` page |
| `text-primary` | `#15151A` | `#F3F1F8` | Headings, body copy |
| `text-secondary` | `#3B3B45` | `#B5B2C4` | Supporting labels, definitions |
| `text-tertiary` | `#6E6E7A` | `#7E7B8F` | Metadata, hints, section eyebrows |
| `text-disabled` | `#A9A9B4` | `#524F61` | Disabled labels/icons |
| `border-subtle` / `default` / `strong` | `#15151A14` / `#15151A1F` / `#15151A33` | `#FFFFFF12` / `#FFFFFF1F` / `#FFFFFF33` | Dividers, input borders, off-toggle tracks |
| `accent` / `hover` / `pressed` | `#6F63D2` / `#6357C4` / `#574CB5` | `#8477EE` / `#9387F5` / `#7366DF` | Primary CTAs, active switches, focus borders |
| `accent-tint` / `tint-hover` / `on-tint` | `#E4DEFF` / `#D8D0FF` / `#4334C4` | `#8477EE2B` / `#8477EE3D` / `#C8C0FF` | Selected nav pills, active badges, tonal buttons |
| `progress` / `track` / `focus-ring` | `#7B70DE` / `#15151A14` / `#6F63D266` | `#8E82F5` / `#FFFFFF17` / `#8477EE80` | Progress bars, sliders, keyboard focus rings |
| `success` / `success-tint` | `#2F9E6B` / `#DDF3E8` | `#45C088` / `#2F9E6B29` | `Synced`, `Saved`, `Finished` states |
| `warning` / `warning-tint` | `#B7740A` / `#FBEFD9` | `#F0AC3C` / `#B7740A2E` | `Paused` sync, unavailable iCloud hints |
| `danger` / `danger-tint` | `#D93F4C` / `#FBE3E5` | `#F26470` / `#D93F4C2B` | Destructive actions, failed sync/auth banners |
| `hl-yellow` / `green` / `blue` / `pink` / `violet` | `#FBE7A1` / `#CDEFD5` / `#CFE3FF` / `#FAD3E3` / `#E4DEFF` | `#E5B83B66` / `#3BB86E59` / `#4A8FE759` / `#E05A9459` / `#8477EE59` | Reader & Highlights passage colors |

- **Typography:** `--font-ui: "Geist"`, `--font-mono: "Geist Mono"`, `--font-reading: "Literata"`. Headed views use `4px` top body padding above `Header`, `28px` (`font-weight: 600`, `letter-spacing: -0.75px`) page titles with `14px` inline subtitles, and `22px` (`-0.4px`) Settings right-pane section titles. Chat messages (user bubbles and Quill replies) are `16px` in `Chats` and `Ask Quill`, line height `1.5` for bubbles and `1.6` for replies; the `Chats` passage quote is `16px` Literata, the `Ask Quill` quote `15px`, and chat composers `15px`.
- **Radii:** `xs` `4px`, `sm` `6px` (covers), `md` `10px`, `control` `12px` (buttons and icon buttons), `lg` `14px`, `xl` `24px` (glass panes/tiles), `pill` `999px` (tabs, segments, chips, badges).
