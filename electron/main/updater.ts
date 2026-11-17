import { createRequire } from "node:module";
import type { AppUpdater, ProgressInfo, UpdateCheckResult, UpdateInfo } from "electron-updater";
import type {
  GitHubProvider as GitHubProviderClass,
  computeReleaseNotes as computeReleaseNotesFn,
} from "electron-updater/out/providers/GitHubProvider";
import type {
  ProviderRuntimeOptions,
  parseUpdateInfo as parseUpdateInfoFn,
} from "electron-updater/out/providers/Provider";
import type { UpdateProgressEvent } from "../../src/platform/types";

export const GITHUB_OWNER = "yicheng47";
export const GITHUB_REPO = "quill";
export const NIGHTLY_FEED_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/nightly`;

const TAG_HREF_REGEXP = /\/tag\/(v?[^/]+)$/;

export interface AvailableUpdateInfo {
  version: string;
  body?: string;
}

export type UpdaterFeedConfig =
  | {
      kind: "nightly";
      feedUrl: string;
      allowPrerelease: false;
    }
  | {
      kind: "github";
      owner: string;
      repo: string;
      allowPrerelease: boolean;
      rcChannel: boolean;
    };

export function isNightlyVersion(version: string): boolean {
  return /-nightly(?:\.|$)/.test(version);
}

export function isRcVersion(version: string): boolean {
  return /-rc(?:\.|$)/.test(version);
}

export function resolveUpdaterFeedConfig(version: string): UpdaterFeedConfig {
  if (isNightlyVersion(version)) {
    return {
      kind: "nightly",
      feedUrl: NIGHTLY_FEED_URL,
      allowPrerelease: false,
    };
  }
  const rc = isRcVersion(version);
  return {
    kind: "github",
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    allowPrerelease: rc,
    rcChannel: rc,
  };
}

interface SemverModuleLike {
  parse(version: string): { prerelease: ReadonlyArray<string | number>; version: string } | null;
  gt(a: string, b: string): boolean;
}

/**
 * Select the highest-semver stable (`prerelease.length === 0`) or RC
 * (`prerelease[0] === "rc"`) tag from GitHub's Atom feed tags, excluding
 * rolling nightly or other non-RC prerelease channels.
 */
export function selectLatestRcOrStableTag(
  tags: ReadonlyArray<string>,
  semverLib: SemverModuleLike = loadUpdaterDeps().semver,
): string | null {
  let bestTag: string | null = null;
  let bestSemver: string | null = null;

  for (const rawTag of tags) {
    const parsed = semverLib.parse(rawTag);
    if (!parsed) {
      continue;
    }
    const isStable = parsed.prerelease.length === 0;
    const isRc = parsed.prerelease[0] === "rc";
    if (!isStable && !isRc) {
      continue;
    }
    if (bestSemver === null || semverLib.gt(parsed.version, bestSemver)) {
      bestTag = rawTag;
      bestSemver = parsed.version;
    }
  }

  return bestTag;
}

interface LoadedUpdaterInternals {
  GitHubProvider: typeof GitHubProviderClass;
  computeReleaseNotes: typeof computeReleaseNotesFn;
  parseUpdateInfo: typeof parseUpdateInfoFn;
  getChannelFilename: (channel: string) => string;
  newUrlFromBase: (pathname: string, baseUrl: URL) => URL;
  CancellationToken: new () => unknown;
  HttpError: new (...args: never[]) => Error & { statusCode?: number };
  newError: (message: string, code: string) => Error;
  parseXml: (xml: string) => {
    getElements(name: string): Array<{
      element(name: string): { attribute(name: string): string };
      elementValueOrEmpty(name: string): string;
    }>;
  };
  semver: SemverModuleLike;
}

const require = createRequire(import.meta.url);
let cachedInternals: LoadedUpdaterInternals | null = null;

function loadUpdaterInternals(): LoadedUpdaterInternals {
  if (cachedInternals) {
    return cachedInternals;
  }
  const updaterRequire = createRequire(require.resolve("electron-updater/package.json"));
  const gh = updaterRequire("./out/providers/GitHubProvider.js") as {
    GitHubProvider: typeof GitHubProviderClass;
    computeReleaseNotes: typeof computeReleaseNotesFn;
  };
  const providerMod = updaterRequire("./out/providers/Provider.js") as {
    parseUpdateInfo: typeof parseUpdateInfoFn;
  };
  const utilMod = updaterRequire("./out/util.js") as {
    getChannelFilename: (channel: string) => string;
    newUrlFromBase: (pathname: string, baseUrl: URL) => URL;
  };
  const runtimeMod = updaterRequire("builder-util-runtime") as {
    CancellationToken: new () => unknown;
    HttpError: new (...args: never[]) => Error & { statusCode?: number };
    newError: (message: string, code: string) => Error;
    parseXml: LoadedUpdaterInternals["parseXml"];
  };
  const semverMod = updaterRequire("semver") as SemverModuleLike;

  cachedInternals = {
    GitHubProvider: gh.GitHubProvider,
    computeReleaseNotes: gh.computeReleaseNotes,
    parseUpdateInfo: providerMod.parseUpdateInfo,
    getChannelFilename: utilMod.getChannelFilename,
    newUrlFromBase: utilMod.newUrlFromBase,
    CancellationToken: runtimeMod.CancellationToken,
    HttpError: runtimeMod.HttpError,
    newError: runtimeMod.newError,
    parseXml: runtimeMod.parseXml,
    semver: semverMod,
  };
  return cachedInternals;
}

function loadUpdaterDeps(): { semver: SemverModuleLike } {
  return { semver: loadUpdaterInternals().semver };
}

type CustomProviderConstructor = new (
  options: Record<string, unknown>,
  updater: AppUpdater,
  runtimeOptions: ProviderRuntimeOptions,
) => GitHubProviderClass;

let cachedRcProviderClass: CustomProviderConstructor | null = null;

/**
 * Custom GitHub provider for `-rc.` builds.
 *
 * `electron-updater`'s built-in `GitHubProvider` treats `rc` as a custom
 * prerelease channel (only `alpha`/`beta` auto-graduate to stable) and would
 * therefore ignore `v2.0.0` once shipped. This subclass selects the highest
 * valid SemVer stable or `-rc.` release while ignoring `nightly` / other channels.
 */
export function getRcGitHubProviderClass(): CustomProviderConstructor {
  if (cachedRcProviderClass) {
    return cachedRcProviderClass;
  }

  const internals = loadUpdaterInternals();
  const BaseGitHubProvider = internals.GitHubProvider;

  class QuillRcGitHubProvider extends BaseGitHubProvider {
    private readonly rcOptions: { owner: string; repo: string };
    private readonly rcUpdater: AppUpdater;

    constructor(
      options: Record<string, unknown>,
      updater: AppUpdater,
      runtimeOptions: ProviderRuntimeOptions,
    ) {
      super(options as never, updater, runtimeOptions);
      this.rcOptions = {
        owner: String(options.owner ?? GITHUB_OWNER),
        repo: String(options.repo ?? GITHUB_REPO),
      };
      this.rcUpdater = updater;
    }

    override async getLatestVersion() {
      const cancellationToken = new internals.CancellationToken();
      const repoBasePath = `/${this.rcOptions.owner}/${this.rcOptions.repo}/releases`;
      const feedXml = await this.httpRequest(
        internals.newUrlFromBase(`${repoBasePath}.atom`, this.baseUrl),
        { accept: "application/xml, application/atom+xml, text/xml, */*" },
        cancellationToken as never,
      );

      let feed: ReturnType<LoadedUpdaterInternals["parseXml"]>;
      const entriesByTag = new Map<
        string,
        ReturnType<LoadedUpdaterInternals["parseXml"]>["getElements"] extends (n: string) => Array<infer E>
          ? E
          : never
      >();
      const candidateTags: string[] = [];

      try {
        feed = internals.parseXml(feedXml ?? "");
        for (const element of feed.getElements("entry")) {
          const href = element.element("link").attribute("href");
          const match = TAG_HREF_REGEXP.exec(href);
          if (!match) {
            continue;
          }
          const entryTag = match[1];
          if (!entriesByTag.has(entryTag)) {
            entriesByTag.set(entryTag, element);
            candidateTags.push(entryTag);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.stack || e.message : String(e);
        throw internals.newError(
          `Cannot parse releases feed: ${msg},\nXML:\n${feedXml}`,
          "ERR_UPDATER_INVALID_RELEASE_FEED",
        );
      }

      const tag = selectLatestRcOrStableTag(candidateTags, internals.semver);
      const latestRelease = tag ? entriesByTag.get(tag) : undefined;
      if (!tag || !latestRelease) {
        throw internals.newError("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS");
      }

      let channelFile = "";
      let channelFileUrl = new URL(this.baseUrl.href);
      const fetchChannelData = async (channelName: string): Promise<string | null> => {
        channelFile = internals.getChannelFilename(channelName);
        channelFileUrl = internals.newUrlFromBase(
          `${repoBasePath}/download/${tag}/${channelFile}`,
          this.baseUrl,
        );
        const requestOptions = this.createRequestOptions(channelFileUrl);
        try {
          return await this.executor.request(requestOptions, cancellationToken as never);
        } catch (e) {
          if (e instanceof internals.HttpError && e.statusCode === 404) {
            throw internals.newError(
              `Cannot find ${channelFile} in the latest release artifacts (${channelFileUrl}): ${e.stack || e.message}`,
              "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
            );
          }
          throw e;
        }
      };

      const parsedTag = internals.semver.parse(tag);
      const isRcTag = parsedTag?.prerelease[0] === "rc";
      let rawData: string | null;
      try {
        // Prefer default `latest-mac.yml` / `latest.yml` (`detectUpdateChannel: false`),
        // falling back to `rc-mac.yml` / `rc.yml` only if an RC tag didn't emit default.
        rawData = await fetchChannelData(this.getDefaultChannelName());
      } catch (e) {
        if (isRcTag) {
          rawData = await fetchChannelData(this.getCustomChannelName("rc"));
        } else {
          throw e;
        }
      }

      const result = internals.parseUpdateInfo(rawData, channelFile, channelFileUrl);
      if (result.releaseName == null) {
        result.releaseName = latestRelease.elementValueOrEmpty("title");
      }
      if (result.releaseNotes == null) {
        result.releaseNotes = internals.computeReleaseNotes(
          this.rcUpdater.currentVersion,
          this.rcUpdater.fullChangelog,
          feed as never,
          latestRelease as never,
        );
      }
      return {
        tag,
        ...result,
      };
    }
  }

  cachedRcProviderClass = QuillRcGitHubProvider as unknown as CustomProviderConstructor;
  return cachedRcProviderClass;
}

function formatReleaseNotes(notes: UpdateInfo["releaseNotes"]): string | undefined {
  if (typeof notes === "string") {
    const trimmed = notes.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(notes)) {
    const joined = notes
      .map((entry) => entry.note?.trim() ?? "")
      .filter((entry) => entry.length > 0)
      .join("\n\n");
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  setFeedURL(options: Parameters<AppUpdater["setFeedURL"]>[0]): void;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(): void;
  on(event: "download-progress", listener: (info: ProgressInfo) => void): unknown;
  on(event: "error", listener: (error: Error, message?: string) => void): unknown;
  removeListener(event: "download-progress", listener: (info: ProgressInfo) => void): unknown;
  removeListener(event: "error", listener: (error: Error, message?: string) => void): unknown;
}

export interface QuillUpdaterDeps {
  isPackaged: () => boolean;
  getVersion: () => string;
  loadAutoUpdater: () => UpdaterLike;
  markQuitting: () => void;
  registerNativeQuitForUpdate?: (onQuitForUpdate: () => void) => void;
}

export class QuillUpdaterService {
  private readonly deps: QuillUpdaterDeps;
  private cachedUpdater: UpdaterLike | null = null;
  private hooksRegistered = false;
  private activeDownload: Promise<void> | null = null;
  private isDownloading = false;
  private activeInstallPromise: Promise<void> | null = null;
  private activeInstallResolve: (() => void) | null = null;
  private activeInstallReject: ((error: Error) => void) | null = null;
  private installPhaseActive = false;
  private pendingInstallError: Error | null = null;

  constructor(deps: QuillUpdaterDeps) {
    this.deps = deps;
  }

  private settleActiveInstallSuccess(): void {
    const resolve = this.activeInstallResolve;
    this.activeInstallPromise = null;
    this.activeInstallResolve = null;
    this.activeInstallReject = null;
    this.installPhaseActive = false;
    this.pendingInstallError = null;
    resolve?.();
  }

  private settleActiveInstallError(error: Error): void {
    const reject = this.activeInstallReject;
    this.activeInstallPromise = null;
    this.activeInstallResolve = null;
    this.activeInstallReject = null;
    this.installPhaseActive = false;
    if (reject) {
      this.pendingInstallError = null;
      reject(error);
    } else if (!this.isDownloading) {
      // Captured after downloadUpdate() resolved (e.g. Squirrel async validation
      // failure before quitAndInstall runs); surface it when relaunchAndInstall runs.
      this.pendingInstallError = error;
    }
  }

  private readonly handleUpdaterError = (err: unknown, message?: string): void => {
    if (!this.installPhaseActive && !this.activeInstallReject) {
      return;
    }
    const normalized =
      err instanceof Error
        ? err
        : new Error(typeof message === "string" && message.trim().length > 0 ? message : String(err));
    this.settleActiveInstallError(normalized);
  };

  private getConfiguredUpdater(): UpdaterLike {
    if (!this.cachedUpdater) {
      this.cachedUpdater = this.deps.loadAutoUpdater();
    }
    if (!this.hooksRegistered) {
      this.hooksRegistered = true;
      this.cachedUpdater.on("error", this.handleUpdaterError);
      this.deps.registerNativeQuitForUpdate?.(() => {
        this.deps.markQuitting();
        this.settleActiveInstallSuccess();
      });
    }

    const updater = this.cachedUpdater;
    const config = resolveUpdaterFeedConfig(this.deps.getVersion());
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = config.allowPrerelease;
    if (config.kind === "nightly") {
      updater.setFeedURL({ provider: "generic", url: config.feedUrl });
    } else if (config.rcChannel) {
      updater.setFeedURL({
        provider: "custom",
        owner: config.owner,
        repo: config.repo,
        updateProvider: getRcGitHubProviderClass(),
      } as Parameters<AppUpdater["setFeedURL"]>[0]);
    } else {
      updater.setFeedURL({
        provider: "github",
        owner: config.owner,
        repo: config.repo,
      });
    }
    return updater;
  }

  async checkForUpdate(): Promise<AvailableUpdateInfo | null> {
    if (!this.deps.isPackaged()) {
      return null;
    }

    this.installPhaseActive = false;
    this.pendingInstallError = null;
    const updater = this.getConfiguredUpdater();
    const result = await updater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) {
      return null;
    }

    return {
      version: result.updateInfo.version,
      body: formatReleaseNotes(result.updateInfo.releaseNotes),
    };
  }

  async downloadAndInstall(onProgress: (event: UpdateProgressEvent) => void): Promise<void> {
    if (!this.deps.isPackaged()) {
      throw new Error("In-app updates are only available in packaged builds");
    }
    if (this.activeDownload) {
      return this.activeDownload;
    }

    this.pendingInstallError = null;
    this.installPhaseActive = true;

    const updater = this.getConfiguredUpdater();
    let started = false;
    let emittedBytes = 0;

    const handleProgress = (info: ProgressInfo) => {
      if (!started && info.total > 0) {
        started = true;
        onProgress({
          event: "Started",
          data: { contentLength: info.total, chunkLength: 0 },
        });
      }
      const chunkLength =
        typeof info.delta === "number" && info.delta > 0
          ? info.delta
          : Math.max(0, info.transferred - emittedBytes);
      if (chunkLength > 0) {
        emittedBytes += chunkLength;
        onProgress({
          event: "Progress",
          data: { chunkLength },
        });
      }
    };

    updater.on("download-progress", handleProgress);
    const run = (async () => {
      this.isDownloading = true;
      try {
        await updater.downloadUpdate();
        this.isDownloading = false;
        onProgress({
          event: "Finished",
          data: { chunkLength: 0 },
        });
      } catch (err) {
        this.isDownloading = false;
        this.installPhaseActive = false;
        this.pendingInstallError = null;
        throw err;
      } finally {
        this.isDownloading = false;
        updater.removeListener("download-progress", handleProgress);
        this.activeDownload = null;
      }
    })();

    this.activeDownload = run;
    return run;
  }

  async relaunchAndInstall(): Promise<void> {
    if (!this.deps.isPackaged()) {
      return;
    }
    if (this.pendingInstallError) {
      const err = this.pendingInstallError;
      this.pendingInstallError = null;
      this.installPhaseActive = false;
      throw err;
    }
    if (this.activeInstallPromise) {
      return this.activeInstallPromise;
    }

    const updater = this.getConfiguredUpdater();
    this.installPhaseActive = true;

    const installPromise = new Promise<void>((resolve, reject) => {
      this.activeInstallResolve = resolve;
      this.activeInstallReject = reject;
    });
    this.activeInstallPromise = installPromise;

    try {
      updater.quitAndInstall();
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error(String(err));
      this.settleActiveInstallError(normalized);
    }

    return installPromise;
  }
}

export function createElectronUpdaterService(options: {
  isPackaged: () => boolean;
  getVersion: () => string;
  markQuitting: () => void;
}): QuillUpdaterService {
  return new QuillUpdaterService({
    isPackaged: options.isPackaged,
    getVersion: options.getVersion,
    markQuitting: options.markQuitting,
    loadAutoUpdater: () => {
      const mod = require("electron-updater") as typeof import("electron-updater");
      return mod.autoUpdater;
    },
    registerNativeQuitForUpdate: (onQuitForUpdate) => {
      try {
        const electron = require("electron") as typeof import("electron");
        electron.autoUpdater?.on?.("before-quit-for-update", onQuitForUpdate);
      } catch {
        // Not running inside Electron's autoUpdater runtime.
      }
    },
  });
}
