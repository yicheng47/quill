# Quill

A modern eBook reader with a built-in AI reading assistant. Import EPUB and PDF files, organize your library into collections, and use AI to help you understand passages, themes, and characters as you read.

Built with Tauri 2 (Rust) and React.

<p>
  <img src="assets/home.png" width="49%" />
  <img src="assets/reader.png" width="49%" />
</p>

## Features

- **EPUB & PDF Reader** — Paginated and scrolled reading modes with customizable fonts, spacing, and margins
- **AI Reading Assistant** — Ask questions about passages, get explanations, discuss themes with contextual AI chat
- **AI Lookup** — Select a word for instant definitions, contextual meaning, or full explanations
- **Highlights & Bookmarks** — Color-coded highlights with notes, bookmarks for important passages
- **Vocabulary Management** — Save words with context, track mastery with spaced repetition
- **Library Management** — Grid/list views, search, status filters (reading/finished), collections
- **iCloud Sync** — Sync books, reading progress, and settings across Macs
- **Multi-Provider AI** — Ollama (local), Anthropic, OpenAI (API key or OAuth), OpenAI-compatible, MiniMax
- **i18n** — English and Simplified Chinese
- **Auto-Update** — In-app update notifications with one-click install
- **Drag & Drop Import** — Drop EPUB/PDF files to add them to your library

## Download

Grab the latest `.dmg` from the [Releases](https://github.com/yicheng47/quill/releases) page:

| File | Platform |
|------|----------|
| `Quill_x.x.x_aarch64.dmg` | macOS Apple Silicon (M1/M2/M3/M4) |
| `Quill_x.x.x_x64.dmg` | macOS Intel |

Open the `.dmg` and drag **Quill.app** to your Applications folder.

> **Note:** The app is not code-signed. After copying to Applications, run:
> ```bash
> xattr -cr /Applications/Quill.app
> ```
> Then open the app normally. This clears the macOS quarantine flag that blocks unsigned apps.

## Install from Source

<details>
<summary>Click to expand</summary>

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- Tauri 2 system dependencies — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Ollama](https://ollama.com/) (optional, for local AI)

### Clone

```bash
git clone --recurse-submodules https://github.com/yicheng47/quill.git
cd quill
```

> The `--recurse-submodules` flag pulls the [foliate-js](https://github.com/yicheng47/foliate-js) EPUB renderer into `public/foliate-js/`.

### Install Dependencies

```bash
make install
```

### Run in Development

```bash
make dev
```

This starts the Vite dev server with hot reload and launches the Tauri window.

### Package for macOS

```bash
make package
```

This builds the frontend, compiles the Rust backend in release mode, and produces:

```
src-tauri/target/release/bundle/
├── macos/Quill.app      # macOS application
└── dmg/Quill_<version>_aarch64.dmg   # distributable disk image
```

To install, open the `.dmg` and drag **Quill.app** to your Applications folder.

### All Commands

| Command | Description |
|---------|-------------|
| `make install` | Install npm dependencies |
| `make dev` | Start Tauri app with hot reload |
| `make dev-web` | Start frontend only in the browser (no Tauri backend) |
| `make build` | Build production app (all targets) |
| `make package` | Package macOS app (`.app` + `.dmg`) |
| `make lint` | Lint frontend code |
| `make typecheck` | Type-check TypeScript |
| `make clean` | Remove debug build artifacts |
| `make clean-all` | Remove all build artifacts including release |

</details>

## AI Setup

Quill supports multiple AI providers. Configure in Settings:

| Provider | Setup |
|----------|-------|
| **Ollama** (default) | Install [Ollama](https://ollama.com/), run `ollama pull llama3.2`, no API key needed |
| **OpenAI** | Add your API key or sign in with OAuth |
| **Anthropic** | Add your API key |
| **OpenAI-compatible** | Any OpenAI-compatible endpoint (e.g. local models, third-party hosts) |
| **MiniMax** | Add your API key |

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Vite
- **EPUB Rendering**: [foliate-js](https://github.com/yicheng47/foliate-js) (Web Components + CSS multi-column layout)
- **Backend**: Rust, Tauri 2, SQLite (rusqlite)
- **AI**: Streaming via SSE, supports OpenAI-compatible APIs and Anthropic

## Project Structure

```
quill/
├── src/                  # React frontend
│   ├── pages/            # Home, Reader, Settings
│   ├── components/       # UI components
│   └── hooks/            # Data hooks (useBooks, useAiChat, etc.)
├── src-tauri/            # Rust backend
│   ├── src/commands/     # Tauri commands (books, ai, settings, etc.)
│   ├── src/ai/           # AI provider implementations
│   └── migrations/       # SQLite schema
├── public/foliate-js/    # EPUB renderer (git submodule)
└── docs/                 # Feature specs and roadmap
```

## License

[MIT](LICENSE)
