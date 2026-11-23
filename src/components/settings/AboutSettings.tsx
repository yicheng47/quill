import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getAppVersion, getPlatformInfo, invoke, openUrl } from "../../platform";
import { BookA, BookOpen, ExternalLink, FolderOpen, Github, Scale } from "lucide-react";
import QuillLogo from "../QuillLogo";
import Button from "../ui/Button";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import { isMacOS } from "../../lib/platformEnv";

const GITHUB_URL = "https://github.com/yicheng47/quill";
const DOCS_URL = "https://github.com/yicheng47/quill#readme";

function formatPlatformLabel(platform: string, arch: string): string {
  const os =
    platform === "darwin"
      ? "macOS"
      : platform === "win32"
        ? "Windows"
        : platform === "linux"
          ? "Linux"
          : "";
  if (!os) return "";
  return arch ? `${os} · ${arch}` : os;
}

export default function AboutSettings() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [platform, setPlatform] = useState("");
  const isMac = isMacOS();

  useEffect(() => {
    void getAppVersion()
      .then(setVersion)
      .catch(() => setVersion("unknown"));
    void getPlatformInfo()
      .then((info) => setPlatform(formatPlatformLabel(info.platform, info.arch)))
      .catch(() => setPlatform(""));
  }, []);

  const open = (url: string) => {
    openUrl(url).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-7">
      {/* Identity Card */}
      <div className="dawn-inset rounded-[6px] p-5 flex items-center gap-4">
        <QuillLogo
          size={56}
          className="rounded-[13px] shadow-[0_6px_16px_rgba(109,91,255,0.25)] shrink-0"
        />
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[18px] font-semibold tracking-[-0.3px] text-text-primary leading-none">
              Quill
            </span>
            {version && (
              <span className="px-[7px] py-[2px] rounded-[6px] bg-surface-solid border border-border-subtle font-mono text-[11.5px] text-text-secondary leading-none">
                {version}
              </span>
            )}
            {platform && (
              <span className="px-[7px] py-[2px] rounded-[6px] bg-surface-solid border border-border-subtle font-mono text-[11.5px] text-text-tertiary leading-none">
                {platform}
              </span>
            )}
          </div>
          <p className="text-[14px] text-text-secondary">
            {t("settings.about.description")}
          </p>
        </div>
      </div>

      {/* Diagnostics */}
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.diagnostics.title")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.diagnostics.applicationLogs")}
            hint={t("settings.diagnostics.revealLogsHint")}
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                invoke("reveal_logs").catch(() => {});
              }}
            >
              <FolderOpen size={14} className="text-text-secondary" />
              <span>
                {isMac
                  ? t("settings.diagnostics.revealInFinder")
                  : t("settings.diagnostics.showInExplorer")}
              </span>
            </Button>
          </SettingsRow>
        </SettingsGroup>
      </section>

      {/* Links & License */}
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.about.linksGroup")}</SettingsOverline>
        <SettingsGroup>
          <button
            type="button"
            onClick={() => open(GITHUB_URL)}
            className="w-full h-[52px] px-5 flex items-center justify-between text-left cursor-pointer hover:bg-surface-hover transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <Github size={15} className="text-text-secondary shrink-0" />
              <span className="text-[14px] font-medium text-text-primary">
                {t("settings.about.github")}
              </span>
            </div>
            <ExternalLink size={13} className="text-text-tertiary shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => open(DOCS_URL)}
            className="w-full h-[52px] px-5 flex items-center justify-between text-left cursor-pointer hover:bg-surface-hover transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <BookOpen size={15} className="text-text-secondary shrink-0" />
              <span className="text-[14px] font-medium text-text-primary">
                {t("settings.about.documentation")}
              </span>
            </div>
            <ExternalLink size={13} className="text-text-tertiary shrink-0" />
          </button>

          <div className="w-full h-[52px] px-5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Scale size={15} className="text-text-secondary shrink-0" />
              <span className="text-[14px] font-medium text-text-primary">
                {t("settings.about.license")}
              </span>
            </div>
            <span className="font-mono text-[12px] text-text-tertiary">MIT</span>
          </div>

          <div className="w-full min-h-[52px] px-5 py-2.5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 shrink-0">
              <BookA size={15} className="text-text-secondary shrink-0" />
              <span className="text-[14px] font-medium text-text-primary">
                {t("settings.about.dictionaryData")}
              </span>
            </div>
            <span className="text-[12px] text-text-tertiary text-right">
              {t("settings.about.dictionaryDataValue")}
            </span>
          </div>
        </SettingsGroup>
      </section>

      <p className="pt-1 text-center text-[12px] text-text-tertiary">
        © 2026 Yicheng Wang (Jason Wang)
      </p>
    </div>
  );
}
