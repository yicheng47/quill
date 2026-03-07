.PHONY: dev dev-web build lint typecheck clean install

# Start Tauri app (frontend + backend)
dev:
	npm run tauri dev

# Start frontend only (browser)
dev-web:
	npm run dev

# Build production app
build:
	npm run tauri build

# Lint frontend
lint:
	npm run lint

# Type-check frontend
typecheck:
	npx tsc --noEmit

# Install dependencies
install:
	npm install

# Clean build artifacts
clean:
	rm -rf dist node_modules/.vite src-tauri/target/debug
