import fs from "node:fs";
import path from "node:path";
import type { Configuration } from "electron-builder";
import {
  PROVISIONING_PROFILE_PATH,
  resolveMacBundleVersion,
  stageNativeResourcesIntoPack,
} from "./electron/packaging/artifacts";

const hasProvisioningProfile = fs.existsSync(
  path.resolve(process.cwd(), PROVISIONING_PROFILE_PATH),
);
const pkgJson = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
) as { version: string };

const config: Configuration = {
  appId: "com.wycstudios.quill",
  productName: "Quill",
  copyright: "Copyright © 2026 wyc studios",
  directories: {
    buildResources: "build",
    output: "dist-electron",
  },
  asar: true,
  files: [
    "out/**/*",
    "!out/native/**",
    "!out/renderer/foliate-js/.git*",
    "!out/renderer/foliate-js/.github/**",
    "package.json",
  ],
  publish: [
    {
      provider: "github",
      owner: "yicheng47",
      repo: "quill",
    },
  ],
  // Keep latest-mac.yml / latest.yml filenames even on -rc. and -nightly. builds.
  detectUpdateChannel: false,
  fileAssociations: [
    {
      ext: "epub",
      name: "EPUB Ebook",
      description: "EPUB Ebook",
      mimeType: "application/epub+zip",
      role: "Viewer",
    },
    {
      ext: "pdf",
      name: "PDF Document",
      description: "PDF Document",
      mimeType: "application/pdf",
      role: "Viewer",
    },
  ],
  mac: {
    icon: "build/icons/icon.icns",
    target: ["dmg", "zip"],
    artifactName: "${productName}-${version}-${arch}-mac.${ext}",
    bundleShortVersion: pkgJson.version,
    bundleVersion: resolveMacBundleVersion(pkgJson.version),
    darkModeSupport: true,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    strictVerify: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    ...(hasProvisioningProfile ? { provisioningProfile: PROVISIONING_PROFILE_PATH } : {}),
    binaries: [
      "Contents/Resources/quill-mcp",
      "Contents/Resources/libpdfium.dylib",
      "Contents/Resources/quill-node/index.node",
    ],
  },
  dmg: {
    icon: "build/icons/icon.icns",
    artifactName: "${productName}-${version}-${arch}.${ext}",
  },
  win: {
    icon: "build/icons/icon.ico",
    target: ["nsis"],
  },
  nsis: {
    artifactName: "${productName}-Setup-${version}-${arch}.${ext}",
    installerIcon: "build/icons/icon.ico",
    uninstallerIcon: "build/icons/icon.ico",
  },
  afterPack: stageNativeResourcesIntoPack,
};

export default config;
