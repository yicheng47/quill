.PHONY: dev dev-web build package lint typecheck clean-rust-stale clean install

# Start Electron app (native core + main/preload + Vite HMR) against dev data
dev:
	npx install-electron
	npx napi build --manifest-path crates/quill-node/Cargo.toml -o crates/quill-node --dts index.d.ts
	cargo build -p quill-mcp
	npx electron-vite dev

# Start frontend only (browser)
dev-web:
	npm run dev

# Build production app
build:
	npm run tauri build

# Package macOS app (.app + .dmg)
package:
	npm run tauri build -- --bundles app,dmg
	@echo "\n✓ Packaged app:"
	@ls -lh src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || true
	@ls -lh src-tauri/target/release/bundle/macos/*.app 2>/dev/null || true

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

# Remove accumulated Quill dev generations while keeping dependency
# artifacts, so the next build stays warm
clean-rust-stale:
	cargo clean --manifest-path src-tauri/Cargo.toml -p quill --profile dev

# Clean build artifacts
clean:
	rm -rf dist out crates/quill-node/index.node crates/quill-node/index.d.ts node_modules/.vite src-tauri/target/debug target/debug

# Clean everything including release builds
clean-all: clean
	rm -rf src-tauri/target/release
