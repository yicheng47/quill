.PHONY: dev dev-web build lint typecheck clean clean-all install

# Start Electron app (native core + main/preload + Vite HMR) against dev data
dev:
	npx install-electron
	npx napi build --manifest-path crates/quill-node/Cargo.toml -o crates/quill-node --dts index.d.ts
	cargo build -p quill-mcp
	npx electron-vite dev

# Start frontend only (browser)
dev-web:
	npm run dev

# Build production bundles (native addon, MCP binary, and Electron bundles)
build:
	npx napi build --manifest-path crates/quill-node/Cargo.toml -o crates/quill-node --dts index.d.ts --release
	cargo build --release -p quill-mcp
	npm run build

# Lint frontend and Electron main/preload
lint:
	npm run lint

# Type-check frontend and Electron main/preload
typecheck:
	npx tsc --noEmit
	npx tsc -p tsconfig.electron.json --noEmit

# Install dependencies
install:
	npm install

# Clean debug build artifacts
clean:
	rm -rf dist out crates/quill-node/index.node crates/quill-node/index.d.ts node_modules/.vite target/debug

# Clean all build artifacts including release builds
clean-all: clean
	rm -rf target/release
