import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import { findRepoRoot, resolveDictPath, resolveMcpBinaryPath, resolvePdfiumPath } from "./paths";
import { isSafeHttpUrl } from "./urlSecurity";

export { findRepoRoot };

export interface JsBootConfig {
  appDataBaseDir: string;
  logDir: string;
  isDev: boolean;
  mcpBinaryPath: string;
  pdfiumPath?: string;
  dictPath?: string;
}

export interface JsHostEvent {
  kind: "emit" | "emit_to" | "open_url" | "reveal_path";
  window?: string;
  event?: string;
  payloadJson?: string;
  target?: string;
}

export interface QuillCoreInstance {
  dispatch(command: string, argsJson: string): Promise<string>;
  allowedMediaRoots(): Promise<string[]>;
  localDir(): string;
  logDir(): string;
  shutdown(): void;
}

interface QuillNodeModule {
  QuillCore: {
    boot(
      config: JsBootConfig,
      onHostEvent: (event: JsHostEvent) => void,
    ): Promise<QuillCoreInstance>;
  };
  resolveDefaultLogDir(isDev: boolean): string;
}

const require = createRequire(import.meta.url);

function loadQuillNode(): QuillNodeModule {
  if (app.isPackaged) {
    const packagedPath = path.join(process.resourcesPath ?? "", "quill-node/index.node");
    if (fs.existsSync(packagedPath)) {
      return require(packagedPath) as QuillNodeModule;
    }
    throw new Error(`Unable to locate packaged quill-node native addon at ${packagedPath}`);
  }

  const repoRoot = findRepoRoot([__dirname, process.cwd(), app.getAppPath()]);
  const candidates = [
    path.join(repoRoot, "crates/quill-node/index.node"),
    path.resolve(__dirname, "../../crates/quill-node/index.node"),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return require(candidate) as QuillNodeModule;
    }
  }
  throw new Error(`Unable to locate quill-node native addon (checked ${candidates.join(", ")})`);
}

export interface HostCallbacks {
  emitAll(event: string, payload: unknown): void;
  emitTo(windowLabel: string, event: string, payload: unknown): void;
}

let cachedModule: QuillNodeModule | null = null;

function getModule(): QuillNodeModule {
  if (!cachedModule) {
    cachedModule = loadQuillNode();
  }
  return cachedModule;
}

export function getLogDir(isDev: boolean): string {
  return getModule().resolveDefaultLogDir(isDev);
}

export async function bootQuillCore(callbacks: HostCallbacks): Promise<QuillCoreInstance> {
  const mod = getModule();
  const isDev = !app.isPackaged;
  const repoRoot = findRepoRoot([__dirname, process.cwd(), app.getAppPath()]);
  const logDir = mod.resolveDefaultLogDir(isDev);

  const config: JsBootConfig = {
    appDataBaseDir: app.getPath("appData"),
    logDir,
    isDev,
    mcpBinaryPath: resolveMcpBinaryPath(repoRoot, {
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      cargoTargetDir: process.env.CARGO_TARGET_DIR,
    }),
    pdfiumPath: resolvePdfiumPath(repoRoot, {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    dictPath: resolveDictPath(repoRoot, {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      envDictPath: process.env.QUILL_DICT_PATH,
    }),
  };

  return mod.QuillCore.boot(config, (ev) => {
    if (ev.kind === "emit" && ev.event) {
      const payload = ev.payloadJson ? JSON.parse(ev.payloadJson) : null;
      callbacks.emitAll(ev.event, payload);
    } else if (ev.kind === "emit_to" && ev.window && ev.event) {
      const payload = ev.payloadJson ? JSON.parse(ev.payloadJson) : null;
      callbacks.emitTo(ev.window, ev.event, payload);
    } else if (ev.kind === "open_url" && ev.target) {
      if (isSafeHttpUrl(ev.target)) {
        void shell.openExternal(ev.target);
      }
    } else if (ev.kind === "reveal_path" && ev.target) {
      void shell.openPath(ev.target);
    }
  });
}
