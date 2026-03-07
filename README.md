# Quill

A desktop ebook reader with a built-in AI reading assistant. Import EPUB files, organize your library into collections, and use AI to help you understand passages, themes, and characters as you read.

Built with Tauri 2 (Rust) and React.

<!-- ![Quill Screenshot](docs/screenshot.png) -->

## Features

- **EPUB Reader** — Paginated reading with customizable fonts, spacing, and margins
- **AI Reading Assistant** — Ask questions about passages, get explanations, discuss themes (supports Ollama, OpenAI, Anthropic)
- **Library Management** — Grid/list views, search, status filters (reading/finished), collections
- **Bookmarks & Highlights** — Save and revisit important passages
- **Drag & Drop Import** — Drop EPUB files to add them to your library
- **Reading Progress** — Auto-saves your position and tracks progress

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install)
- [Ollama](https://ollama.com/) (optional, for local AI)

### Development

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

## AI Setup

Quill supports multiple AI providers. Configure in Settings:

| Provider | Setup |
|----------|-------|
| **Ollama** (default) | Install Ollama, run `ollama pull llama3.2`, no API key needed |
| **OpenAI** | Add your API key, set model (e.g. `gpt-4o`) |
| **Anthropic** | Add your API key, set model (e.g. `claude-sonnet-4-20250514`) |

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS 4, epub.js
- **Backend**: Rust, Tauri 2, SQLite (rusqlite)
- **AI**: Streaming via SSE, supports OpenAI-compatible APIs and Anthropic

## Project Structure

```
quill/
├── src/                # React frontend
│   ├── pages/          # Home, Reader, Settings
│   ├── components/     # UI components
│   └── hooks/          # Data hooks (useBooks, useAiChat, etc.)
├── src-tauri/          # Rust backend
│   ├── src/commands/   # Tauri commands (books, ai, settings, etc.)
│   ├── src/ai/         # AI provider implementations
│   └── migrations/     # SQLite schema
└── docs/               # Documentation
```

## License

[MIT](LICENSE)
