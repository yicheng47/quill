import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Minus, Square, X } from "lucide-react";
import { isWindows } from "../lib/platformEnv";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowMaximized,
  toggleMaximizeWindow,
} from "../platform";

const CONTROL_BUTTON_BASE =
  "size-8 rounded-control inline-flex items-center justify-center shrink-0 text-text-secondary cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring";

interface WindowControlsProps {
  showDivider?: boolean;
}

export default function WindowControls({ showDivider = true }: WindowControlsProps) {
  const { t } = useTranslation();
  const win = isWindows();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!win) return;
    let active = true;
    void isWindowMaximized()
      .then((value) => {
        if (active) setMaximized(Boolean(value));
      })
      .catch(() => {});

    let unlisten: (() => void) | undefined;
    void onWindowMaximized((value) => {
      if (active) setMaximized(value);
    })
      .then((fn) => {
        if (active) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch(() => {});

    return () => {
      active = false;
      unlisten?.();
    };
  }, [win]);

  if (!win) return null;

  const maximizeLabel = t(maximized ? "window.restore" : "window.maximize");

  return (
    <>
      {showDivider && (
        <span aria-hidden="true" className="w-px h-5 bg-border-subtle shrink-0" />
      )}
      <div className="no-drag relative z-[55] flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => {
            void minimizeWindow().catch(() => {});
          }}
          aria-label={t("window.minimize")}
          title={t("window.minimize")}
          className={`${CONTROL_BUTTON_BASE} hover:bg-border-subtle`}
        >
          <Minus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => {
            void toggleMaximizeWindow().catch(() => {});
          }}
          aria-label={maximizeLabel}
          title={maximizeLabel}
          className={`${CONTROL_BUTTON_BASE} hover:bg-border-subtle`}
        >
          {maximized ? (
            <Copy size={12} aria-hidden="true" />
          ) : (
            <Square size={12} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            void closeWindow().catch(() => {});
          }}
          aria-label={t("window.close")}
          title={t("window.close")}
          className={`${CONTROL_BUTTON_BASE} hover:bg-[#C42B1C] hover:text-white`}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
