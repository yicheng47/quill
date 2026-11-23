import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import yaml from "js-yaml";
import { assertBinaryArch } from "./binary-arch.mjs";

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const platform = args.platform ?? process.platform;
const arch = args.arch ?? (process.arch === "arm64" ? "arm64" : "x64");
const distDir = path.resolve(args.dist ?? "dist-electron");

if (!["darwin", "win32"].includes(platform)) {
  throw new Error(`Unsupported platform for pack validation: ${platform}`);
}
if (!["arm64", "x64"].includes(arch)) {
  throw new Error(`Unsupported arch for pack validation: ${arch}`);
}

const forbiddenTauriUpdate = path.join(distDir, "latest.json");
if (fs.existsSync(forbiddenTauriUpdate)) {
  throw new Error(`Unexpected Tauri latest.json found in ${distDir}`);
}

if (platform === "darwin") {
  const macOutDir = arch === "arm64" ? path.join(distDir, "mac-arm64") : path.join(distDir, "mac");
  const appDir = path.join(macOutDir, "Quill.app");
  if (!fs.existsSync(appDir)) {
    throw new Error(`Unpacked macOS app not found at ${appDir}`);
  }
  const contentsDir = path.join(appDir, "Contents");
  const resourcesDir = path.join(contentsDir, "Resources");

  const requiredFiles = [
    path.join(contentsDir, "MacOS", "Quill"),
    path.join(contentsDir, "Info.plist"),
    path.join(resourcesDir, "app.asar"),
    path.join(resourcesDir, "icon.icns"),
    path.join(resourcesDir, "quill-mcp"),
    path.join(resourcesDir, "libpdfium.dylib"),
    path.join(resourcesDir, "dict.db"),
    path.join(resourcesDir, "quill-node", "index.node"),
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing expected packaged file: ${file}`);
    }
  }

  assertBinaryArch(path.join(contentsDir, "MacOS", "Quill"), arch);
  assertBinaryArch(path.join(resourcesDir, "quill-mcp"), arch);
  assertBinaryArch(path.join(resourcesDir, "libpdfium.dylib"), arch);
  assertBinaryArch(path.join(resourcesDir, "quill-node", "index.node"), arch);

  const infoPlist = fs.readFileSync(path.join(contentsDir, "Info.plist"), "utf8");
  for (const expected of ["com.wycstudios.quill", "epub", "pdf"]) {
    if (!infoPlist.includes(expected)) {
      throw new Error(`Info.plist missing expected entry "${expected}"`);
    }
  }

  const dictDbPath = path.join(resourcesDir, "dict.db");
  const appUpdateYmlPath = path.join(resourcesDir, "app-update.yml");
  if (args["require-app-update"] === "true") {
    const dictBytes = fs.statSync(dictDbPath).size;
    if (dictBytes < 1_000_000) {
      throw new Error(
        `Production bundle contains a stub/fixture dict.db (${dictBytes} bytes); expected full production dict.db`,
      );
    }
    if (!fs.existsSync(appUpdateYmlPath)) {
      throw new Error(`Missing ${appUpdateYmlPath}`);
    }
    const updateCfg = yaml.load(fs.readFileSync(appUpdateYmlPath, "utf8"));
    if (updateCfg?.provider !== "github" || updateCfg?.owner !== "yicheng47" || updateCfg?.repo !== "quill") {
      throw new Error(`Unexpected app-update.yml contents: ${JSON.stringify(updateCfg)}`);
    }
  }

  console.log(`Validated macOS (${arch}) unpacked bundle at ${appDir}`);
} else {
  const winOutDir = path.join(distDir, "win-unpacked");
  if (!fs.existsSync(winOutDir)) {
    throw new Error(`Unpacked Windows app not found at ${winOutDir}`);
  }
  const resourcesDir = path.join(winOutDir, "resources");

  const requiredFiles = [
    path.join(winOutDir, "Quill.exe"),
    path.join(resourcesDir, "app.asar"),
    path.join(resourcesDir, "quill-mcp.exe"),
    path.join(resourcesDir, "pdfium.dll"),
    path.join(resourcesDir, "dict.db"),
    path.join(resourcesDir, "quill-node", "index.node"),
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing expected packaged file: ${file}`);
    }
  }

  if (args["require-app-update"] === "true") {
    const dictBytes = fs.statSync(path.join(resourcesDir, "dict.db")).size;
    if (dictBytes < 1_000_000) {
      throw new Error(
        `Production bundle contains a stub/fixture dict.db (${dictBytes} bytes); expected full production dict.db`,
      );
    }
  }

  assertBinaryArch(path.join(winOutDir, "Quill.exe"), "x64");
  assertBinaryArch(path.join(resourcesDir, "quill-mcp.exe"), "x64");
  assertBinaryArch(path.join(resourcesDir, "pdfium.dll"), "x64");
  assertBinaryArch(path.join(resourcesDir, "quill-node", "index.node"), "x64");

  console.log(`Validated Windows (${arch}) unpacked bundle at ${winOutDir}`);
}
