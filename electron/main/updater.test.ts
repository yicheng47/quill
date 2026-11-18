import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NsisUpdater, type ProgressInfo, type UpdateCheckResult } from "electron-updater";
import type { AppAdapter } from "electron-updater/out/AppAdapter";
import type { UpdateProgressEvent } from "../../src/platform/types";
import {
  NIGHTLY_FEED_URL,
  QuillUpdaterService,
  getRcGitHubProviderClass,
  resolveUpdaterFeedConfig,
  type UpdaterLike,
} from "./updater";

class FakeAutoUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  feedCalls: unknown[] = [];
  checkImpl = vi.fn<() => Promise<UpdateCheckResult | null>>();
  downloadImpl = vi.fn<(cancellationToken?: unknown) => Promise<string[]>>();
  quitImpl = vi.fn<() => void>();

  setFeedURL(options: Parameters<UpdaterLike["setFeedURL"]>[0]): void {
    this.feedCalls.push(options);
  }

  checkForUpdates(): Promise<UpdateCheckResult | null> {
    return this.checkImpl();
  }

  downloadUpdate(cancellationToken?: unknown): Promise<string[]> {
    return this.downloadImpl(cancellationToken);
  }

  quitAndInstall(): void {
    this.quitImpl();
  }
}

function buildAtomFeedXml(tags: string[]): string {
  const entries = tags
    .map(
      (tag) => `
  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <title>Quill ${tag}</title>
    <link rel="alternate" type="text/html" href="https://github.com/yicheng47/quill/releases/tag/${tag}" />
    <content type="html">Release ${tag}</content>
  </entry>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">${entries}
</feed>`;
}

function createProviderTestUpdater(
  runningVersion: string,
  atomTags: string[],
  yamlByUrl: Record<string, string>,
): { updater: NsisUpdater; requestedUrls: string[] } {
  const tmpBase = path.join(os.tmpdir(), "quill-updater-test");
  const appAdapter: AppAdapter = {
    version: runningVersion,
    name: "Quill",
    isPackaged: true,
    appUpdateConfigPath: path.join(tmpBase, "app-update.yml"),
    userDataPath: tmpBase,
    baseCachePath: tmpBase,
    whenReady: async () => {},
    relaunch: () => {},
    quit: () => {},
    onQuit: () => {},
  };

  const updater = new NsisUpdater(null, appAdapter);
  const requestedUrls: string[] = [];
  (updater as unknown as { _testOnlyOptions: unknown })._testOnlyOptions = { platform: "darwin" };
  (updater as unknown as { httpExecutor: unknown }).httpExecutor = {
    request: async (options: { hostname?: string; path?: string }) => {
      const fullUrl = `https://${options.hostname ?? "github.com"}${options.path ?? ""}`;
      requestedUrls.push(fullUrl);
      if (fullUrl === "https://github.com/yicheng47/quill/releases.atom") {
        return buildAtomFeedXml(atomTags);
      }
      const yamlBody = yamlByUrl[fullUrl];
      if (yamlBody !== undefined) {
        return yamlBody;
      }
      throw new Error(`Unexpected test HTTP request: ${fullUrl}`);
    },
  };
  return { updater, requestedUrls };
}

describe("resolveUpdaterFeedConfig", () => {
  it("routes stable 2.0.0 to GitHub releases with allowPrerelease disabled", () => {
    expect(resolveUpdaterFeedConfig("2.0.0")).toEqual({
      kind: "github",
      owner: "yicheng47",
      repo: "quill",
      allowPrerelease: false,
      rcChannel: false,
    });
  });

  it("routes -rc. builds to GitHub RC/stable channel with allowPrerelease enabled", () => {
    expect(resolveUpdaterFeedConfig("2.0.0-rc.1")).toEqual({
      kind: "github",
      owner: "yicheng47",
      repo: "quill",
      allowPrerelease: true,
      rcChannel: true,
    });
  });

  it("routes nightly builds to the rolling generic nightly feed", () => {
    expect(resolveUpdaterFeedConfig("2.0.0-nightly.202611171930")).toEqual({
      kind: "nightly",
      feedUrl: NIGHTLY_FEED_URL,
      allowPrerelease: false,
    });
  });
});

describe("QuillRcGitHubProvider (real electron-updater provider integration)", () => {
  it("graduates 2.0.0-rc.2 to stable v2.0.0 instead of staying stuck on the rc channel", async () => {
    const { updater, requestedUrls } = createProviderTestUpdater(
      "2.0.0-rc.2",
      ["v2.0.0", "v2.0.0-rc.2", "v2.0.0-rc.1", "nightly"],
      {
        "https://github.com/yicheng47/quill/releases/download/v2.0.0/latest-mac.yml": `version: 2.0.0
files:
  - url: Quill-2.0.0-arm64-mac.zip
    sha512: stableSha
    size: 1234
path: Quill-2.0.0-arm64-mac.zip
sha512: stableSha
releaseDate: '2026-11-18T00:00:00.000Z'
`,
      },
    );

    const service = new QuillUpdaterService({
      isPackaged: () => true,
      getVersion: () => "2.0.0-rc.2",
      loadAutoUpdater: () => updater as unknown as UpdaterLike,
      markQuitting: vi.fn(),
    });

    await expect(service.checkForUpdate()).resolves.toMatchObject({
      version: "2.0.0",
    });
    expect(requestedUrls).toEqual([
      "https://github.com/yicheng47/quill/releases.atom",
      "https://github.com/yicheng47/quill/releases/download/v2.0.0/latest-mac.yml",
    ]);
  });

  it("advances 2.0.0-rc.1 to 2.0.0-rc.2 while excluding nightly and beta prereleases", async () => {
    const { updater, requestedUrls } = createProviderTestUpdater(
      "2.0.0-rc.1",
      ["v2.0.0-nightly.202611180000", "v2.0.0-beta.9", "v2.0.0-rc.2", "v2.0.0-rc.1"],
      {
        "https://github.com/yicheng47/quill/releases/download/v2.0.0-rc.2/latest-mac.yml": `version: 2.0.0-rc.2
files:
  - url: Quill-2.0.0-rc.2-arm64-mac.zip
    sha512: rc2Sha
    size: 1234
path: Quill-2.0.0-rc.2-arm64-mac.zip
sha512: rc2Sha
releaseDate: '2026-11-18T00:00:00.000Z'
`,
      },
    );

    const service = new QuillUpdaterService({
      isPackaged: () => true,
      getVersion: () => "2.0.0-rc.1",
      loadAutoUpdater: () => updater as unknown as UpdaterLike,
      markQuitting: vi.fn(),
    });

    await expect(service.checkForUpdate()).resolves.toMatchObject({
      version: "2.0.0-rc.2",
    });
    expect(requestedUrls).toContain(
      "https://github.com/yicheng47/quill/releases/download/v2.0.0-rc.2/latest-mac.yml",
    );

    // Running rc.2 with only newer nightly/beta releases reports no available update.
    const noUpdate = createProviderTestUpdater(
      "2.0.0-rc.2",
      ["v2.0.0-nightly.202611180000", "v2.0.0-beta.9", "v2.0.0-rc.2"],
      {
        "https://github.com/yicheng47/quill/releases/download/v2.0.0-rc.2/latest-mac.yml": `version: 2.0.0-rc.2
files:
  - url: Quill-2.0.0-rc.2-arm64-mac.zip
    sha512: rc2Sha
    size: 1234
path: Quill-2.0.0-rc.2-arm64-mac.zip
sha512: rc2Sha
releaseDate: '2026-11-18T00:00:00.000Z'
`,
      },
    );
    const upToDateService = new QuillUpdaterService({
      isPackaged: () => true,
      getVersion: () => "2.0.0-rc.2",
      loadAutoUpdater: () => noUpdate.updater as unknown as UpdaterLike,
      markQuitting: vi.fn(),
    });
    await expect(upToDateService.checkForUpdate()).resolves.toBeNull();
  });
});

describe("QuillUpdaterService", () => {
  it("returns null without touching electron-updater when !isPackaged", async () => {
    const loadAutoUpdater = vi.fn();
    const service = new QuillUpdaterService({
      isPackaged: () => false,
      getVersion: () => "2.0.0",
      loadAutoUpdater,
      markQuitting: vi.fn(),
    });

    await expect(service.checkForUpdate()).resolves.toBeNull();
    expect(loadAutoUpdater).not.toHaveBeenCalled();
  });

  it("configures custom RC provider, stable GitHub feed, and generic nightly feed by version", async () => {
    const fake = new FakeAutoUpdater();
    const info = {
      version: "2.0.0",
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-11-17T00:00:00.000Z",
    };
    fake.checkImpl.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: info,
      versionInfo: info,
    });

    let currentVersion = "2.0.0-rc.1";
    const service = new QuillUpdaterService({
      isPackaged: () => true,
      getVersion: () => currentVersion,
      loadAutoUpdater: () => fake,
      markQuitting: vi.fn(),
    });

    await expect(service.checkForUpdate()).resolves.toBeNull();
    expect(fake.autoDownload).toBe(false);
    expect(fake.allowPrerelease).toBe(true);
    expect(fake.feedCalls.at(-1)).toEqual({
      provider: "custom",
      owner: "yicheng47",
      repo: "quill",
      updateProvider: getRcGitHubProviderClass(),
    });

    currentVersion = "2.0.0";
    await expect(service.checkForUpdate()).resolves.toBeNull();
    expect(fake.allowPrerelease).toBe(false);
    expect(fake.feedCalls.at(-1)).toEqual({
      provider: "github",
      owner: "yicheng47",
      repo: "quill",
    });

    currentVersion = "2.0.0-nightly.202611171930";
    await expect(service.checkForUpdate()).resolves.toBeNull();
    expect(fake.allowPrerelease).toBe(false);
    expect(fake.feedCalls.at(-1)).toEqual({
      provider: "generic",
      url: NIGHTLY_FEED_URL,
    });
  });

  it("streams Started/Progress/Finished and marks quitting only on actual before-quit-for-update", async () => {
    const fake = new FakeAutoUpdater();
    const updateInfo = {
      version: "2.0.1",
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-11-18T00:00:00.000Z",
      releaseNotes: "Bug fixes",
    };
    fake.checkImpl.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo,
      versionInfo: updateInfo,
    });
    fake.downloadImpl.mockImplementation(async () => {
      const emitProgress = (info: ProgressInfo) => fake.emit("download-progress", info);
      emitProgress({ total: 1000, delta: 400, transferred: 400, percent: 40, bytesPerSecond: 100 });
      emitProgress({ total: 1000, delta: 600, transferred: 1000, percent: 100, bytesPerSecond: 100 });
      return ["/tmp/Quill.zip"];
    });

    const markQuitting = vi.fn();
    let nativeHook: (() => void) | undefined;
    fake.quitImpl.mockImplementation(() => {
      setImmediate(() => {
        nativeHook?.();
      });
    });

    const service = new QuillUpdaterService({
      isPackaged: () => true,
      getVersion: () => "2.0.0",
      loadAutoUpdater: () => fake,
      markQuitting,
      registerNativeQuitForUpdate: (cb) => {
        nativeHook = cb;
      },
    });

    const available = await service.checkForUpdate();
    expect(available).toEqual({ version: "2.0.1", body: "Bug fixes" });

    const events: UpdateProgressEvent[] = [];
    await service.downloadAndInstall((ev) => events.push(ev));

    expect(events).toEqual([
      { event: "Started", data: { contentLength: 1000, chunkLength: 0 } },
      { event: "Progress", data: { chunkLength: 400 } },
      { event: "Progress", data: { chunkLength: 600 } },
      { event: "Finished", data: { chunkLength: 0 } },
    ]);
    expect(fake.listenerCount("download-progress")).toBe(0);
    expect(markQuitting).not.toHaveBeenCalled();

    await service.relaunchAndInstall();
    expect(fake.quitImpl).toHaveBeenCalledTimes(1);
    expect(markQuitting).toHaveBeenCalledTimes(1);
  });

  it("rejects relaunchAndInstall without marking quitting when quitAndInstall emits an installer error", async () => {
    const fake = new FakeAutoUpdater();
    fake.downloadImpl.mockResolvedValue(["/tmp/Quill.exe"]);
    fake.quitImpl.mockImplementation(() => {
      // Matches BaseUpdater.install() dispatching error synchronously and returning false.
      fake.emit("error", new Error("Installer launch failed"));
    });

    const markQuitting = vi.fn();
    const service = new QuillUpdaterService({
      isPackaged: () => true,
      getVersion: () => "2.0.0",
      loadAutoUpdater: () => fake,
      markQuitting,
      registerNativeQuitForUpdate: vi.fn(),
    });

    await service.downloadAndInstall(vi.fn());
    await expect(service.relaunchAndInstall()).rejects.toThrow("Installer launch failed");
    expect(markQuitting).not.toHaveBeenCalled();
  });

  it("captures post-download Squirrel errors before relaunchAndInstall and recovers cleanly on retry", async () => {
    const fake = new FakeAutoUpdater();
    const info = {
      version: "2.0.1",
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-11-18T00:00:00.000Z",
    };
    fake.checkImpl.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: info,
      versionInfo: info,
    });
    fake.downloadImpl.mockResolvedValue(["/tmp/Quill.zip"]);

    const markQuitting = vi.fn();
    let nativeHook: (() => void) | undefined;
    const service = new QuillUpdaterService({
      isPackaged: () => true,
      getVersion: () => "2.0.0",
      loadAutoUpdater: () => fake,
      markQuitting,
      registerNativeQuitForUpdate: (cb) => {
        nativeHook = cb;
      },
    });

    await service.downloadAndInstall(vi.fn());
    // MacUpdater forwards Squirrel nativeUpdater errors after downloadUpdate() resolves.
    fake.emit("error", new Error("Squirrel signature verification failed"));

    await expect(service.relaunchAndInstall()).rejects.toThrow(
      "Squirrel signature verification failed",
    );
    expect(markQuitting).not.toHaveBeenCalled();
    expect(fake.quitImpl).not.toHaveBeenCalled();

    // Retry flow clears stale error and completes normally on before-quit-for-update.
    fake.quitImpl.mockImplementation(() => {
      nativeHook?.();
    });
    await expect(service.checkForUpdate()).resolves.toEqual({
      version: "2.0.1",
      body: undefined,
    });
    await service.downloadAndInstall(vi.fn());
    await expect(service.relaunchAndInstall()).resolves.toBeUndefined();
    expect(markQuitting).toHaveBeenCalledTimes(1);
  });

  it("selects only the matching update artifact size from merged macOS/Windows feeds (including Rosetta)", async () => {
    const mergedMacFiles = [
      { url: "Quill-2.1.0-mac.zip", sha512: "x", size: 41_000_000 },
      { url: "Quill-2.1.0-arm64-mac.zip", sha512: "a", size: 48_200_000 },
      { url: "Quill-2.1.0-x64.dmg", sha512: "xd", size: 45_000_000 },
      { url: "Quill-2.1.0-arm64.dmg", sha512: "ad", size: 52_000_000 },
      { url: "Quill-2.1.0-arm64-mac.zip.blockmap", sha512: "ab", size: 120_000 },
    ];
    const makeService = (platform: NodeJS.Platform, arch: string, isRosetta = false) => {
      const fake = new FakeAutoUpdater();
      fake.checkImpl.mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: {
          version: "2.1.0",
          files: platform === "win32"
            ? [
                { url: "Quill-2.1.0-x64-win.exe", sha512: "w", size: 61_500_000 },
                { url: "Quill-2.1.0-x64-win.exe.blockmap", sha512: "wb", size: 200_000 },
              ]
            : mergedMacFiles,
          path: "",
          sha512: "",
          releaseDate: "2026-11-18T00:00:00.000Z",
        },
        versionInfo: {
          version: "2.1.0",
          files: [],
          path: "",
          sha512: "",
          releaseDate: "2026-11-18T00:00:00.000Z",
        },
      });
      return new QuillUpdaterService({
        isPackaged: () => true,
        getVersion: () => "2.0.0",
        loadAutoUpdater: () => fake,
        markQuitting: vi.fn(),
        registerNativeQuitForUpdate: vi.fn(),
        platform: () => platform,
        arch: () => arch,
        isRosetta: () => isRosetta,
      });
    };

    await expect(makeService("darwin", "arm64").checkForUpdate()).resolves.toEqual({
      version: "2.1.0",
      body: undefined,
      sizeBytes: 48_200_000,
    });
    await expect(makeService("darwin", "x64", false).checkForUpdate()).resolves.toEqual({
      version: "2.1.0",
      body: undefined,
      sizeBytes: 41_000_000,
    });
    // Rosetta runs with process.arch === "x64" on Apple Silicon; MacUpdater selects arm64 ZIP.
    await expect(makeService("darwin", "x64", true).checkForUpdate()).resolves.toEqual({
      version: "2.1.0",
      body: undefined,
      sizeBytes: 48_200_000,
    });
    await expect(makeService("win32", "x64").checkForUpdate()).resolves.toEqual({
      version: "2.1.0",
      body: undefined,
      sizeBytes: 61_500_000,
    });
  });

  it("cancels an active download via CancellationToken, skips error events, and stays reusable", async () => {
    const fake = new FakeAutoUpdater();
    let rejectDownload!: (err: unknown) => void;
    let passedToken: { cancelled: boolean; cancel(): void } | undefined;

    fake.downloadImpl.mockImplementationOnce((token) => {
      passedToken = token as { cancelled: boolean; cancel(): void };
      return new Promise<string[]>((_resolve, reject) => {
        rejectDownload = reject;
      });
    });

    const service = new QuillUpdaterService({
      isPackaged: () => true,
      getVersion: () => "2.0.0",
      loadAutoUpdater: () => fake,
      markQuitting: vi.fn(),
      registerNativeQuitForUpdate: vi.fn(),
    });

    expect(service.cancelDownload()).toBe(false);

    const events: UpdateProgressEvent[] = [];
    const downloadPromise = service.downloadAndInstall((ev) => events.push(ev));

    expect(service.cancelDownload()).toBe(true);
    expect(passedToken?.cancelled).toBe(true);

    // Emit late progress after cancel (should be ignored) and resolve rejection as CancellationError
    fake.emit("download-progress", { total: 1000, transferred: 500, delta: 500, percent: 50, bytesPerSecond: 100 });
    const cancelErr = Object.assign(new Error("Download cancelled"), { name: "CancellationError" });
    rejectDownload(cancelErr);

    await expect(downloadPromise).resolves.toEqual({ cancelled: true });
    expect(events).toEqual([]);
    expect(service.cancelDownload()).toBe(false);

    // Service recovers cleanly and completes a subsequent download.
    fake.downloadImpl.mockResolvedValueOnce(["/tmp/Quill.zip"]);
    await expect(service.downloadAndInstall((ev) => events.push(ev))).resolves.toEqual({
      cancelled: false,
    });
    expect(events).toEqual([{ event: "Finished", data: { chunkLength: 0 } }]);
  });
});
