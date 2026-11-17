import path from "node:path";
import { defineConfig, mergeConfig } from "electron-vite";
import type { UserConfig as ViteUserConfig } from "vite";
import viteConfig from "./vite.config";

const { plugins, clearScreen, server } = viteConfig as ViteUserConfig;
const sharedRenderer: ViteUserConfig = { plugins, clearScreen, server };

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      externalizeDeps: {
        include: ["electron-updater"],
      },
      rollupOptions: {
        input: path.resolve(__dirname, "electron/main/index.ts"),
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      externalizeDeps: true,
      rollupOptions: {
        input: path.resolve(__dirname, "electron/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: mergeConfig(sharedRenderer, {
    root: ".",
    plugins: [{
      name: "quill-app-base",
      enforce: "post",
      // electron-vite forces "./" in production; reader routes need origin-relative assets.
      config: () => ({ base: "/" }),
    }],
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: path.resolve(__dirname, "index.html"),
      },
    },
  }),
});
