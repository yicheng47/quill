.PHONY: dev dev-web build package lint typecheck clean-rust-stale clean install

# Start Tauri app (frontend + backend) with dev-mode config overlay
dev:
	npm run tauri dev -- --config src-tauri/tauri.dev.conf.json

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

# Lint frontend
lint:
	npm run lint

# Type-check frontend
typecheck:
	npx tsc --noEmit

# Install dependencies
install:
	npm install

# Remove accumulated Quill dev generations while keeping dependency
# artifacts, so the next build stays warm
clean-rust-stale:
	cargo clean --manifest-path src-tauri/Cargo.toml -p quill --profile dev

# Clean build artifacts
clean:
	rm -rf dist node_modules/.vite src-tauri/target/debug

# Clean everything including release builds
clean-all: clean
	rm -rf src-tauri/target/release
