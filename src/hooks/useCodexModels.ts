import { useCallback, useEffect, useState } from "react";
import * as platform from "../platform";
import type { CodexModel, CodexModelList } from "../lib/aiConnections";

interface CatalogState {
  models: CodexModel[];
  loading: boolean;
  loaded: boolean;
  codexPath: string;
  accountKey: string;
  epoch: number;
}

let state: CatalogState = {
  models: [],
  loading: false,
  loaded: false,
  codexPath: "",
  accountKey: "",
  epoch: 0,
};
let inFlight: Promise<CodexModel[]> | null = null;
let inFlightGen = 0;
const listeners = new Set<() => void>();
let remoteListenerSubscribed = false;
let remoteListenerGen = 0;
let remoteUnlisten: (() => void) | undefined;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setState(patch: Partial<CatalogState>) {
  state = { ...state, ...patch };
  emit();
}

function getPlatformListen() {
  try {
    return typeof platform.listen === "function" ? platform.listen : null;
  } catch {
    return null;
  }
}

/**
 * Keep a single renderer-lifetime subscription matching the module-level cache
 * lifetime so invalidations arriving while no picker is mounted still clear the
 * cache and React StrictMode remounts never leak a duplicate listener.
 */
function ensureRemoteInvalidationListener() {
  if (remoteListenerSubscribed) return;
  const listenFn = getPlatformListen();
  if (!listenFn) return;
  remoteListenerSubscribed = true;
  const gen = ++remoteListenerGen;
  void Promise.resolve(
    listenFn("codex-catalog-invalidated", () => {
      invalidateCodexModelsCache();
    }),
  )
    .then((fn) => {
      if (remoteListenerGen !== gen) {
        fn?.();
        return;
      }
      remoteUnlisten = fn;
    })
    .catch(() => {
      if (remoteListenerGen === gen) {
        remoteListenerSubscribed = false;
      }
    });
}

/**
 * Clear the cached Codex model catalog so any active consumer re-fetches once
 * and hidden/signed-out consumers fetch fresh when they next become active.
 */
export function invalidateCodexModelsCache() {
  inFlightGen += 1;
  inFlight = null;
  setState({
    models: [],
    loading: false,
    loaded: false,
    accountKey: "",
    epoch: state.epoch + 1,
  });
}

async function fetchCatalog(
  codexPath: string,
  accountKey: string | undefined,
  force: boolean,
): Promise<CodexModel[]> {
  ensureRemoteInvalidationListener();
  const pathChanged = codexPath !== state.codexPath;
  const normalizedAccount = accountKey?.trim() ?? "";
  const accountChanged =
    normalizedAccount !== "" &&
    state.accountKey !== "" &&
    normalizedAccount !== state.accountKey;

  if (pathChanged || accountChanged) {
    inFlightGen += 1;
    inFlight = null;
    setState({
      codexPath,
      accountKey: normalizedAccount,
      models: [],
      loaded: false,
      loading: false,
    });
  } else if (normalizedAccount !== "" && state.accountKey === "") {
    // Adopt the known account key without invalidating an already-fetched catalog
    // from another surface in the same session.
    state = { ...state, accountKey: normalizedAccount };
  }

  if (!force && state.loaded && state.models.length > 0 && !pathChanged && !accountChanged) {
    return state.models;
  }
  if (inFlight && !force) {
    return inFlight;
  }

  const gen = ++inFlightGen;
  setState({ loading: true });

  const promise = platform
    .invoke<CodexModelList>("list_codex_models")
    .then((list) => {
      if (inFlightGen !== gen) return state.models;
      const models = Array.isArray(list?.models) ? list.models : [];
      inFlight = null;
      setState({
        models,
        loading: false,
        loaded: models.length > 0,
      });
      return models;
    })
    .catch(() => {
      if (inFlightGen !== gen) return state.models;
      inFlight = null;
      setState({
        models: [],
        loading: false,
        loaded: false,
      });
      return [];
    });

  inFlight = promise;
  return promise;
}

export function resetCodexModelsCacheForTests() {
  inFlightGen += 1;
  inFlight = null;
  remoteListenerGen += 1;
  remoteListenerSubscribed = false;
  remoteUnlisten?.();
  remoteUnlisten = undefined;
  state = {
    models: [],
    loading: false,
    loaded: false,
    codexPath: "",
    accountKey: "",
    epoch: 0,
  };
  emit();
}

export interface UseCodexModelsOptions {
  enabled: boolean;
  codexPath?: string;
  accountKey?: string;
  refreshNonce?: number;
}

export function useCodexModels({
  enabled,
  codexPath = "",
  accountKey,
  refreshNonce = 0,
}: UseCodexModelsOptions) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    ensureRemoteInvalidationListener();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const normalizedPath = codexPath.trim();
  const normalizedAccount = accountKey?.trim() || undefined;
  const epoch = state.epoch;

  useEffect(() => {
    if (!enabled) return;
    void fetchCatalog(normalizedPath, normalizedAccount, false);
  }, [enabled, normalizedPath, normalizedAccount, refreshNonce, epoch]);

  const refresh = useCallback(() => {
    invalidateCodexModelsCache();
    if (!enabled) return Promise.resolve(state.models);
    return fetchCatalog(normalizedPath, normalizedAccount, true);
  }, [enabled, normalizedPath, normalizedAccount]);

  return {
    models: state.models,
    loading: state.loading,
    refresh,
  };
}
