/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    watch: {
      ignored: [
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
