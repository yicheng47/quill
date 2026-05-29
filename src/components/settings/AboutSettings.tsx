import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Github, BookText, Scale, ExternalLink } from "lucide-react";
import QuillLogo from "../QuillLogo";

const GITHUB_URL = "https://github.com/yicheng47/quill";
const DOCS_URL = "https://github.com/yicheng47/quill#readme";

// Informational platform label derived from the UA string (no os plugin).
function platformLabel(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent.toLowerCase();
  const arch = ua.includes("arm64") || ua.includes("aarch64")
    ? "arm64"
    : ua.includes("x86_64") || ua.includes("x64")
      ? "x86_64"
      : "";
  const os = ua.includes("mac")
    ? "macOS"
    : ua.includes("win")
      ? "Windows"
      : ua.includes("linux")
        ? "Linux"
        : "";
  if (!os) return "";
  return arch ? `${os} · ${arch}` : os;
}

export default function AboutSettings() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const platform = platformLabel();

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

  const open = (url: string) => {
    openUrl(url).catch(() => {});
  };

  return (
    <div className="flex flex-col min-h-full pb-2">
      {/* Identity */}
      <div className="flex flex-col items-center gap-3.5 pt-4 pb-6">
        <QuillLogo size={56} className="rounded-2xl" />
        <div className="flex flex-col items-center gap-1.5">
          <span
            className="text-[20px] font-semibold text-text-primary tracking-[0.5px]"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            Quill
          </span>
          <span className="text-[12px] text-text-muted">{t("settings.about.description")}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="bg-bg-page dark:bg-bg-input text-text-secondary text-[12px] font-mono px-2 py-0.5 rounded-lg">
            v{version}
          </span>
          {platform && (
            <span className="bg-bg-page dark:bg-bg-input text-text-secondary text-[12px] font-mono px-2 py-0.5 rounded-lg">
              {platform}
            </span>
          )}
        </div>
      </div>
      <div className="h-px bg-black/10 mb-4" />

      {/* Links */}
      <button
        onClick={() => open(GITHUB_URL)}
        className="group flex items-center justify-between h-[57px] cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <Github size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.github")}</span>
        </div>
        <ExternalLink size={14} className="text-text-muted" />
      </button>

      <button
        onClick={() => open(DOCS_URL)}
        className="group flex items-center justify-between h-[57px] cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <BookText size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.documentation")}</span>
        </div>
        <ExternalLink size={14} className="text-text-muted" />
      </button>

      <div className="flex items-center justify-between h-[57px]">
        <div className="flex items-center gap-3">
          <Scale size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.license")}</span>
        </div>
        <span className="text-[12px] text-text-muted">MIT</span>
      </div>

      <div className="flex-1" />
      <div className="flex items-center justify-center text-[11px] text-text-muted">
        © 2026 wyc studios
      </div>
    </div>
  );
}
