# Quill

An AI-powered ebook reader for desktop. Quill combines a clean, distraction-free reading experience with intelligent features that help you understand, annotate, and engage with your books more deeply.

## Tech Stack

- **Frontend**: React + TypeScript
- **Backend**: Rust (Tauri)
- **Build Tool**: Vite

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install)

### Development

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

## Project Structure

```
quill/
├── src/           # React frontend
├── src-tauri/     # Rust backend (Tauri)
├── docs/
│   ├── guide/     # Implementation guides
│   └── features/  # Feature descriptions
└── public/        # Static assets
```

## License

[MIT](LICENSE)
