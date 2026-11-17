/// <reference types="vitest/config" />
import process from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. expect a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching Rust/Electron dirs and nested worktrees
      ignored: [
        "**/src-tauri/**",
        "**/crates/**",
        "**/electron/**",
        "**/target/**",
        "**/.worktrees/**",
      ],
    },
  },
  test: {
    // Vitest globs dot-directories, so without this a run would pick up
    // the tests of every worktree nested under `.worktrees/`.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "electron/**/*.{test,spec}.ts"],
  },
});
