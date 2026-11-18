import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

export const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
export const LAST_LAUNCHED_VERSION_KEY = "last_launched_version";
const LSREGISTER_TIMEOUT_MS = 5000;

export interface ShouldRefreshMacBundleIconInput {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  currentVersion: string;
  lastLaunchedVersion: string | null | undefined;
}

export function shouldRefreshMacBundleIcon(input: ShouldRefreshMacBundleIconInput): boolean {
  if (!input.isPackaged || input.platform !== "darwin") {
    return false;
  }
  if (!input.currentVersion) {
    return false;
  }
  const previous = input.lastLaunchedVersion || null;
  return input.currentVersion !== previous;
}

export function resolveMacAppBundlePath(execPath: string): string | null {
  if (!execPath) return null;
  let dir = path.posix.dirname(execPath);
  while (dir && dir !== path.posix.dirname(dir)) {
    if (path.posix.basename(dir).endsWith(".app")) {
      return dir;
    }
    dir = path.posix.dirname(dir);
  }
  return null;
}

export interface RefreshMacBundleIconDeps {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  currentVersion: string;
  execPath: string;
  dispatch: (command: string, argsJson: string) => Promise<string>;
  setDockIconFromPath: (icnsPath: string) => void;
  utimes?: (target: string, atime: Date, mtime: Date) => Promise<void>;
  execFile?: (file: string, args: string[]) => Promise<void>;
  fileExists?: (target: string) => boolean;
  now?: () => Date;
  log?: Pick<Console, "warn">;
}

export async function refreshMacBundleIconIfVersionChanged(
  deps: RefreshMacBundleIconDeps,
): Promise<boolean> {
  if (!deps.isPackaged || deps.platform !== "darwin" || !deps.currentVersion) {
    return false;
  }

  const log = deps.log ?? console;

  let lastLaunchedVersion: string | null = null;
  try {
    const raw = await deps.dispatch(
      "get_setting",
      JSON.stringify({ key: LAST_LAUNCHED_VERSION_KEY }),
    );
    lastLaunchedVersion = raw ? (JSON.parse(raw) as string | null) : null;
  } catch (err) {
    log.warn("mac-icon: failed to read last_launched_version setting:", err);
  }

  if (
    !shouldRefreshMacBundleIcon({
      isPackaged: deps.isPackaged,
      platform: deps.platform,
      currentVersion: deps.currentVersion,
      lastLaunchedVersion,
    })
  ) {
    return false;
  }

  const utimesFn = deps.utimes ?? fs.promises.utimes;
  const execFileFn =
    deps.execFile ??
    (async (file: string, args: string[]) => {
      await execFileAsync(file, args, { timeout: LSREGISTER_TIMEOUT_MS });
    });
  const fileExists = deps.fileExists ?? fs.existsSync;
  const nowFn = deps.now ?? (() => new Date());

  const bundlePath = resolveMacAppBundlePath(deps.execPath);
  if (!bundlePath) {
    log.warn("mac-icon: could not resolve .app bundle from execPath:", deps.execPath);
  } else {
    const now = nowFn();
    try {
      await utimesFn(bundlePath, now, now);
    } catch (err) {
      log.warn("mac-icon: failed to update bundle mtime:", err);
    }

    try {
      await execFileFn(LSREGISTER_PATH, ["-f", bundlePath]);
    } catch (err) {
      log.warn("mac-icon: failed to re-register bundle with LaunchServices:", err);
    }

    const icnsPath = path.posix.join(bundlePath, "Contents", "Resources", "icon.icns");
    try {
      if (fileExists(icnsPath)) {
        deps.setDockIconFromPath(icnsPath);
      }
    } catch (err) {
      log.warn("mac-icon: failed to set Dock icon:", err);
    }
  }

  try {
    await deps.dispatch(
      "set_setting",
      JSON.stringify({ key: LAST_LAUNCHED_VERSION_KEY, value: deps.currentVersion }),
    );
  } catch (err) {
    log.warn("mac-icon: failed to store last_launched_version:", err);
  }

  return true;
}
