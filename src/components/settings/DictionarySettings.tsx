import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronUp,
  FolderOpen,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { invoke, openFileDialog } from "../../platform";
import { isMacOS } from "../../lib/platformEnv";
import {
  formatDictionaryBytes,
  type DictionaryDescriptor,
} from "../../types/dictionary";
import Button from "../ui/Button";
import Switch from "../ui/Switch";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import type { SettingsProps } from "./types";

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return "Unknown error";
}

export default function DictionarySettings({
  settings,
  loading,
  save,
  showSavedToast,
}: SettingsProps) {
  const { t } = useTranslation();
  const isMac = isMacOS();

  const [dictionaries, setDictionaries] = useState<DictionaryDescriptor[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [lemmatize, setLemmatize] = useState(true);
  const [showAllMatches, setShowAllMatches] = useState(true);

  useEffect(() => {
    if (loading) return;
    setLemmatize(settings.dictionary_lemmatize !== "false");
    setShowAllMatches(settings.dictionary_show_all_matches !== "false");
  }, [settings, loading]);

  const loadDictionaries = useCallback(async () => {
    try {
      const list = await invoke<DictionaryDescriptor[]>("list_dictionaries");
      setDictionaries(Array.isArray(list) ? list : []);
    } catch {
      setDictionaries([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDictionaries();
  }, [loadDictionaries]);

  const persistConfig = useCallback(
    async (next: DictionaryDescriptor[], prev: DictionaryDescriptor[]) => {
      setDictionaries(next);
      setErrorMessage(null);
      try {
        await invoke("update_dictionaries_config", {
          items: next.map((d) => ({ id: d.id, enabled: d.enabled })),
        });
      } catch {
        setDictionaries(prev);
        setErrorMessage(t("settings.dictionary.reorderError"));
      }
    },
    [t],
  );

  const runImport = useCallback(
    async (directoryOnly: boolean) => {
      if (importing) return;
      setErrorMessage(null);
      let picked: string | null = null;
      try {
        picked = directoryOnly
          ? await openFileDialog({ directoryOnly: true })
          : await openFileDialog({
              allowDirectory: isMac,
              filters: [
                {
                  name: "Dictionaries",
                  extensions: ["mdx", "ifo", "zip"],
                },
              ],
            });
      } catch (err) {
        setErrorMessage(
          t("settings.dictionary.importError", { error: formatErrorMessage(err) }),
        );
        return;
      }

      if (!picked) return;

      setImporting(true);
      try {
        const added = await invoke<DictionaryDescriptor>("import_dictionary", {
          path: picked,
        });
        await loadDictionaries();
        showSavedToast(
          t("settings.dictionary.importSuccess", { name: added?.name || picked }),
        );
      } catch (err) {
        setErrorMessage(
          t("settings.dictionary.importError", { error: formatErrorMessage(err) }),
        );
      } finally {
        setImporting(false);
      }
    },
    [importing, isMac, loadDictionaries, showSavedToast, t],
  );

  const handleToggle = useCallback(
    (id: string, enabled: boolean) => {
      const prev = dictionaries;
      const next = prev.map((d) => (d.id === id ? { ...d, enabled } : d));
      void persistConfig(next, prev);
    },
    [dictionaries, persistConfig],
  );

  const handleMove = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (
        fromIdx === toIdx ||
        fromIdx < 0 ||
        toIdx < 0 ||
        fromIdx >= dictionaries.length ||
        toIdx >= dictionaries.length
      ) {
        return;
      }
      const prev = dictionaries;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      void persistConfig(next, prev);
    },
    [dictionaries, persistConfig],
  );

  const handleRemove = useCallback(
    async (item: DictionaryDescriptor) => {
      if (item.id === "builtin" || removingId) return;
      setRemovingId(item.id);
      setErrorMessage(null);
      try {
        await invoke("remove_dictionary", { id: item.id });
        setDictionaries((prev) => prev.filter((d) => d.id !== item.id));
        showSavedToast(t("settings.dictionary.removeSuccess", { name: item.name }));
      } catch (err) {
        setErrorMessage(
          t("settings.dictionary.removeError", { error: formatErrorMessage(err) }),
        );
      } finally {
        setRemovingId(null);
      }
    },
    [removingId, showSavedToast, t],
  );

  if (loading) return null;

  const formatMeta = (item: DictionaryDescriptor): string => {
    const formatLabel =
      item.format === "builtin"
        ? t("settings.dictionary.formatBuiltin")
        : item.format === "mdx"
          ? t("settings.dictionary.formatMdx")
          : t("settings.dictionary.formatStardict");
    if (item.id === "builtin" && item.entryCount === 0 && item.sizeBytes === 0) {
      return t("settings.dictionary.unavailableHint");
    }
    const parts = [formatLabel];
    if (item.entryCount > 0) {
      parts.push(
        t("settings.dictionary.entriesCount", {
          count: item.entryCount.toLocaleString(),
        }),
      );
    }
    if (item.sizeBytes > 0) {
      parts.push(formatDictionaryBytes(item.sizeBytes));
    }
    return parts.join(" · ");
  };

  return (
    <div className="flex flex-col gap-7">
      {/* INSTALLED DICTIONARIES */}
      <section className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SettingsOverline>{t("settings.dictionary.installedGroup")}</SettingsOverline>
          <div className="flex items-center gap-2">
            {!isMac && (
              <Button
                variant="secondary"
                size="sm"
                disabled={importing}
                onClick={() => void runImport(true)}
              >
                <FolderOpen size={14} className="text-text-secondary" />
                <span>{t("settings.dictionary.importFolderButton")}</span>
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={importing}
              onClick={() => void runImport(false)}
            >
              {importing ? (
                <Loader2 size={14} className="animate-spin text-text-secondary" />
              ) : (
                <Plus size={14} className="text-text-secondary" />
              )}
              <span>
                {importing
                  ? t("settings.dictionary.importing")
                  : t("settings.dictionary.importButton")}
              </span>
            </Button>
          </div>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="rounded-[6px] border border-danger/30 bg-danger-tint px-4 py-2.5 text-[12.5px] text-danger"
          >
            {errorMessage}
          </div>
        )}

        <SettingsGroup>
          {listLoading ? (
            <div className="min-h-[72px] px-5 py-3 flex items-center text-[13px] text-text-tertiary">
              {t("common.loading")}
            </div>
          ) : dictionaries.length === 0 ? (
            <div className="min-h-[72px] px-5 py-3 flex items-center text-[13px] text-text-tertiary">
              {t("settings.dictionary.emptyList")}
            </div>
          ) : (
            dictionaries.map((item, idx) => {
              const isBuiltin = item.id === "builtin";
              const isDragTarget = dragOverId === item.id && draggedId !== item.id;
              return (
                <div
                  key={item.id}
                  data-dictionary-row={item.id}
                  draggable={dictionaries.length > 1}
                  onDragStart={(e) => {
                    setDraggedId(item.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", item.id);
                  }}
                  onDragOver={(e) => {
                    if (!draggedId || draggedId === item.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDragOverId(item.id);
                  }}
                  onDragLeave={() => {
                    if (dragOverId === item.id) setDragOverId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const sourceId = draggedId || e.dataTransfer.getData("text/plain");
                    setDraggedId(null);
                    setDragOverId(null);
                    if (!sourceId || sourceId === item.id) return;
                    const fromIdx = dictionaries.findIndex((d) => d.id === sourceId);
                    if (fromIdx >= 0) {
                      handleMove(fromIdx, idx);
                    }
                  }}
                  onDragEnd={() => {
                    setDraggedId(null);
                    setDragOverId(null);
                  }}
                  className={`min-h-[72px] px-5 py-3 flex items-center justify-between gap-4 transition-colors ${
                    isDragTarget ? "bg-accent-tint/50" : ""
                  } ${draggedId === item.id ? "opacity-60" : ""}`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span
                      aria-label={t("settings.dictionary.dragHandle", { name: item.name })}
                      className={`text-text-tertiary shrink-0 ${
                        dictionaries.length > 1 ? "cursor-grab active:cursor-grabbing" : "opacity-40"
                      }`}
                    >
                      <GripVertical size={15} />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[14px] font-medium text-text-primary truncate">
                          {item.name}
                        </span>
                        {isBuiltin && (
                          <span className="px-2 py-0.5 rounded-full bg-accent-tint text-accent-on-tint text-[11px] font-semibold leading-none shrink-0">
                            {t("settings.dictionary.builtInBadge")}
                          </span>
                        )}
                      </div>
                      <p className="text-[12.5px] text-text-tertiary mt-[3px] leading-snug truncate">
                        {formatMeta(item)}
                      </p>
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center gap-1.5">
                    {dictionaries.length > 1 && (
                      <div className="flex items-center gap-0.5 mr-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => handleMove(idx, idx - 1)}
                          aria-label={t("settings.dictionary.moveUp", { name: item.name })}
                          className="size-7 rounded-control flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-default"
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          type="button"
                          disabled={idx === dictionaries.length - 1}
                          onClick={() => handleMove(idx, idx + 1)}
                          aria-label={t("settings.dictionary.moveDown", { name: item.name })}
                          className="size-7 rounded-control flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-default"
                        >
                          <ChevronDown size={14} />
                        </button>
                      </div>
                    )}

                    {!isBuiltin && (
                      <button
                        type="button"
                        disabled={removingId === item.id}
                        onClick={() => void handleRemove(item)}
                        aria-label={t("settings.dictionary.removeAction", { name: item.name })}
                        className="size-8 rounded-control flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger-tint cursor-pointer transition-colors disabled:opacity-50 mr-1"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}

                    <Switch
                      aria-label={t("settings.dictionary.toggleAction", { name: item.name })}
                      checked={item.enabled}
                      onChange={(checked) => handleToggle(item.id, checked)}
                    />
                  </div>
                </div>
              );
            })
          )}
        </SettingsGroup>
      </section>

      {/* LOOKUP BEHAVIOR */}
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.dictionary.behaviorGroup")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.dictionary.lemmatize")}
            hint={t("settings.dictionary.lemmatizeHint")}
          >
            <Switch
              aria-label={t("settings.dictionary.lemmatize")}
              checked={lemmatize}
              onChange={(checked) => {
                setLemmatize(checked);
                void save("dictionary_lemmatize", String(checked));
              }}
            />
          </SettingsRow>

          <SettingsRow
            title={t("settings.dictionary.showAllMatches")}
            hint={t("settings.dictionary.showAllMatchesHint")}
          >
            <Switch
              aria-label={t("settings.dictionary.showAllMatches")}
              checked={showAllMatches}
              onChange={(checked) => {
                setShowAllMatches(checked);
                void save("dictionary_show_all_matches", String(checked));
              }}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>

      <p className="text-[12px] leading-[1.55] text-text-tertiary">
        {t("settings.dictionary.footerNote")}
      </p>
    </div>
  );
}
