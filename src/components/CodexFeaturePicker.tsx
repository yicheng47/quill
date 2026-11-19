import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronUp, Cpu, Settings } from "lucide-react";
import type { CodexModel } from "../lib/aiConnections";
import { resolveCodexFeature, type CodexFeatureId } from "../lib/codexFeatures";

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 6;

export interface CodexFeaturePickerProps {
  feature: CodexFeatureId;
  settings: Record<string, string>;
  models: readonly CodexModel[];
  variant: "settings" | "composer";
  customMode?: boolean;
  onSelectModel: (modelSlug: string) => void;
  onSelectEffort: (effort: string) => void;
  onRequestCustomModel?: () => void;
  ariaLabel?: string;
  className?: string;
}

export default function CodexFeaturePicker({
  feature,
  settings,
  models,
  variant,
  customMode = false,
  onSelectModel,
  onSelectEffort,
  onRequestCustomModel,
  ariaLabel,
  className = "",
}: CodexFeaturePickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [inlineCustomOpen, setInlineCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  const resolved = useMemo(
    () => resolveCodexFeature(feature, settings, models),
    [feature, settings, models],
  );

  const effortLabel = useCallback(
    (level: string) => {
      const key = `settings.ai.effort.${level}`;
      const label = t(key);
      return label === key ? level : label;
    },
    [t],
  );

  const closeMenu = useCallback(() => {
    setOpen(false);
    setInlineCustomOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    const handleResize = () => closeMenu();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, closeMenu]);

  useEffect(() => {
    if (inlineCustomOpen) {
      customInputRef.current?.focus();
      customInputRef.current?.select();
    }
  }, [inlineCustomOpen]);

  const effortOptions = useMemo(() => {
    const levels = [...resolved.supportedEffortLevels];
    if (
      !resolved.hasKnownSupportedEfforts &&
      !resolved.isEffortDefault &&
      !levels.includes(resolved.resolvedEffort)
    ) {
      levels.push(resolved.resolvedEffort);
    }
    return levels;
  }, [resolved]);

  const estimatedMenuHeight =
    26 + // MODEL header
    50 + // Default row
    models.length * 33 +
    33 + // Custom...
    (inlineCustomOpen ? 44 : 0) +
    9 + // Divider
    26 + // REASONING header
    33 + // Default (level)
    effortOptions.length * 33 +
    (variant === "composer" ? 40 : 0) +
    16; // Padding

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const menuWidth = variant === "settings" ? Math.max(rect.width, 280) : 264;
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;

    const openUp =
      variant === "composer"
        ? !(spaceAbove < 140 && spaceBelow > spaceAbove)
        : estimatedMenuHeight > spaceBelow && spaceAbove > spaceBelow;

    const preferredLeft = variant === "settings" ? rect.right - menuWidth : rect.left;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - menuWidth - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, preferredLeft), maxLeft);
    const availableHeight = openUp ? spaceAbove : spaceBelow;

    setMenuStyle({
      left,
      width: menuWidth,
      maxHeight: Math.max(160, Math.min(estimatedMenuHeight, availableHeight || estimatedMenuHeight)),
      ...(openUp
        ? { bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.top + MENU_GAP) }
        : { top: rect.bottom + MENU_GAP }),
    });
  }, [open, variant, estimatedMenuHeight]);

  const isCustomActive = customMode || resolved.isCustomModel || inlineCustomOpen;
  const triggerModelText =
    resolved.modelDisplayName ||
    (variant === "settings" ? t("settings.ai.picker.default") : "Codex");
  const rawEffortText = effortLabel(resolved.resolvedEffort);
  const triggerEffortText = variant === "composer" ? rawEffortText.toLowerCase() : rawEffortText;
  const triggerLabel = `${triggerModelText} · ${triggerEffortText}`;

  const defaultSubtext = (() => {
    if (resolved.defaultModel) {
      const modelName = resolved.defaultModel.display_name || resolved.defaultModel.slug;
      if (resolved.defaultModelFromFamily) {
        return t("settings.ai.picker.defaultFamilyWithModel", {
          family: resolved.feature.defaultFamilyLabel,
          model: modelName,
        });
      }
      return t("settings.ai.picker.defaultCatalogModel", { model: modelName });
    }
    return t("settings.ai.picker.defaultFamily", {
      family: resolved.feature.defaultFamilyLabel,
    });
  })();

  const handleModelClick = (slug: string) => {
    onSelectModel(slug);
    closeMenu();
  };

  const handleEffortClick = (level: string) => {
    onSelectEffort(level);
    closeMenu();
  };

  const handleCustomClick = () => {
    if (variant === "settings") {
      closeMenu();
      onRequestCustomModel?.();
      return;
    }
    setCustomDraft(resolved.isCustomModel ? resolved.effectiveModel : "");
    setInlineCustomOpen(true);
  };

  const submitInlineCustom = () => {
    onSelectModel(customDraft.trim());
    closeMenu();
  };

  const handleCustomKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitInlineCustom();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setInlineCustomOpen(false);
    }
  };

  const resolvedAriaLabel =
    ariaLabel ??
    (variant === "settings" ? t(resolved.feature.titleKey) : t("settings.ai.picker.chatPickerLabel"));

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {variant === "settings" ? (
        <button
          ref={triggerRef}
          type="button"
          aria-label={resolvedAriaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid={`codex-feature-picker-${feature}`}
          onClick={() => setOpen((v) => !v)}
          className="w-[230px] h-[38px] rounded-full px-3.5 text-[13px] font-medium dawn-glass text-text-primary hover:bg-surface-solid flex items-center justify-between gap-[7px] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring"
        >
          <span className="flex items-center gap-[7px] min-w-0">
            <Cpu size={14} className="shrink-0 text-text-secondary" />
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronDown
            size={13}
            className={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-label={resolvedAriaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="codex-composer-picker"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1.5 h-6 px-[9px] rounded-full font-mono text-[11px] max-w-full cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
            open
              ? "bg-surface-solid border border-border-default text-text-primary"
              : "border border-transparent text-text-secondary hover:bg-surface-solid hover:border-border-default hover:text-text-primary"
          }`}
        >
          <Cpu size={12} className="shrink-0 text-text-tertiary" />
          <span className="truncate">{triggerLabel}</span>
          {open ? (
            <ChevronUp size={11} className="shrink-0 text-text-tertiary" />
          ) : (
            <ChevronDown size={11} className="shrink-0 text-text-tertiary" />
          )}
        </button>
      )}

      {open &&
        menuStyle &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={resolvedAriaLabel}
            data-testid={`codex-feature-menu-${feature}`}
            style={menuStyle}
            onMouseDown={(e) => e.stopPropagation()}
            className="fixed z-[70] dawn-menu rounded-surface p-1.5 flex flex-col gap-[1px] overflow-y-auto"
          >
            {/* MODEL section */}
            <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">
              {t("settings.ai.picker.modelSection")}
            </div>

            <button
              type="button"
              role="menuitemradio"
              aria-checked={resolved.isModelDefault && !isCustomActive}
              data-testid="codex-model-option-default"
              onClick={() => handleModelClick("")}
              className={`w-full flex items-center justify-between gap-2.5 px-2.5 py-[7px] rounded-[8px] text-left cursor-pointer transition-colors ${
                resolved.isModelDefault && !isCustomActive
                  ? "bg-accent-tint text-accent-on-tint"
                  : "text-text-primary hover:bg-border-subtle"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium leading-[18px] truncate">
                  {t("settings.ai.picker.default")}
                </span>
                <span
                  className={`block text-[12px] leading-[16px] truncate mt-0.5 ${
                    resolved.isModelDefault && !isCustomActive
                      ? "text-accent-on-tint/80"
                      : "text-text-tertiary"
                  }`}
                >
                  {defaultSubtext}
                </span>
              </span>
              {resolved.isModelDefault && !isCustomActive && (
                <Check size={15} className="shrink-0 text-accent-fg" />
              )}
            </button>

            {models.map((m) => {
              const active =
                !resolved.isModelDefault && !isCustomActive && resolved.effectiveModel === m.slug;
              return (
                <button
                  key={m.slug}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  data-testid={`codex-model-option-${m.slug}`}
                  onClick={() => handleModelClick(m.slug)}
                  className={`w-full flex items-center justify-between gap-2.5 px-2.5 py-[7px] rounded-[8px] text-left cursor-pointer transition-colors ${
                    active
                      ? "bg-accent-tint text-accent-on-tint"
                      : "text-text-primary hover:bg-border-subtle"
                  }`}
                >
                  <span className="text-[13.5px] font-medium leading-[18px] truncate">
                    {m.display_name || m.slug}
                  </span>
                  {active && <Check size={15} className="shrink-0 text-accent-fg" />}
                </button>
              );
            })}

            <button
              type="button"
              role="menuitemradio"
              aria-checked={isCustomActive}
              data-testid="codex-model-option-custom"
              onClick={handleCustomClick}
              className={`w-full flex items-center justify-between gap-2.5 px-2.5 py-[7px] rounded-[8px] text-left cursor-pointer transition-colors ${
                isCustomActive
                  ? "bg-accent-tint text-accent-on-tint"
                  : "text-text-primary hover:bg-border-subtle"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium leading-[18px] truncate">
                  {t("settings.ai.modelCustom")}
                </span>
                {resolved.isCustomModel && resolved.effectiveModel && !inlineCustomOpen && (
                  <span
                    className={`block font-mono text-[11.5px] leading-[15px] truncate mt-0.5 ${
                      isCustomActive ? "text-accent-on-tint/80" : "text-text-tertiary"
                    }`}
                  >
                    {resolved.effectiveModel}
                  </span>
                )}
              </span>
              {isCustomActive && <Check size={15} className="shrink-0 text-accent-fg" />}
            </button>

            {variant === "composer" && inlineCustomOpen && (
              <div className="px-2 py-1.5 flex items-center gap-1.5">
                <input
                  ref={customInputRef}
                  type="text"
                  value={customDraft}
                  onChange={(e) => setCustomDraft(e.target.value)}
                  onKeyDown={handleCustomKeyDown}
                  placeholder={resolved.defaultModel?.slug || "gpt-6.2-sol"}
                  aria-label={t("settings.ai.modelCustomInput")}
                  className="flex-1 min-w-0 h-8 px-2.5 rounded-[6px] bg-surface-solid border border-border-default font-mono text-[12px] text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-accent focus:ring-[3px] focus:ring-focus-ring"
                />
                <button
                  type="button"
                  onClick={submitInlineCustom}
                  aria-label={t("settings.ai.picker.customApply")}
                  className="h-8 px-2.5 rounded-[6px] bg-accent hover:bg-accent-hover text-text-on-accent text-[12px] font-medium shrink-0 cursor-pointer transition-colors"
                >
                  {t("settings.ai.picker.customApply")}
                </button>
              </div>
            )}

            <div className="my-1 h-px bg-border-subtle" />

            {/* REASONING section */}
            <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">
              {t("settings.ai.picker.reasoningSection")}
            </div>

            <button
              type="button"
              role="menuitemradio"
              aria-checked={resolved.isEffortDefault}
              data-testid="codex-effort-option-default"
              onClick={() => handleEffortClick("")}
              className={`w-full flex items-center justify-between gap-2.5 px-2.5 py-[7px] rounded-[8px] text-left cursor-pointer transition-colors ${
                resolved.isEffortDefault
                  ? "bg-accent-tint text-accent-on-tint"
                  : "text-text-primary hover:bg-border-subtle"
              }`}
            >
              <span className="text-[13.5px] font-medium leading-[18px] truncate">
                {t("settings.ai.effortDefaultWithLevel", {
                  level: effortLabel(resolved.defaultResolvedEffort),
                })}
              </span>
              {resolved.isEffortDefault && <Check size={15} className="shrink-0 text-accent-fg" />}
            </button>

            {effortOptions.map((level) => {
              const active = !resolved.isEffortDefault && resolved.resolvedEffort === level;
              return (
                <button
                  key={level}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  data-testid={`codex-effort-option-${level}`}
                  onClick={() => handleEffortClick(level)}
                  className={`w-full flex items-center justify-between gap-2.5 px-2.5 py-[7px] rounded-[8px] text-left cursor-pointer transition-colors ${
                    active
                      ? "bg-accent-tint text-accent-on-tint"
                      : "text-text-primary hover:bg-border-subtle"
                  }`}
                >
                  <span className="text-[13.5px] font-medium leading-[18px] truncate">
                    {effortLabel(level)}
                  </span>
                  {active && <Check size={15} className="shrink-0 text-accent-fg" />}
                </button>
              );
            })}

            {variant === "composer" && (
              <>
                <div className="my-1 h-px bg-border-subtle" />
                <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-[12px] text-text-tertiary">
                  <Settings size={12} className="shrink-0" />
                  <span className="truncate">{t("settings.ai.picker.alsoChangesSettings")}</span>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
