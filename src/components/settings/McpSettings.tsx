import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Check, Copy, ShieldAlert } from "lucide-react";
import Toggle from "../ui/Toggle";
import type { SettingsProps } from "./types";

interface IntegrationStatus {
  claude_code: boolean;
  codex: boolean;
  binary_path: string;
}

type ClientId = "claude_code" | "codex";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function McpSettings(_props: SettingsProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [busy, setBusy] = useState<ClientId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<IntegrationStatus>("mcp_integration_status");
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onToggle = async (client: ClientId, next: boolean) => {
    setBusy(client);
    setError(null);
    try {
      await invoke("mcp_set_integration", { client, enabled: next });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onCopy = async () => {
    try {
      const snippet = await invoke<string>("mcp_config_snippet");
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      {/* Claude Code CLI */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.mcp.claudeCode")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.mcp.claudeCodeSub")}
          </p>
        </div>
        <Toggle
          checked={status?.claude_code ?? false}
          onChange={(next) => onToggle("claude_code", next)}
          disabled={status == null || busy === "claude_code"}
        />
      </div>

      <div className="h-px bg-black/10" />

      {/* Codex CLI */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.mcp.codex")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.mcp.codexSub")}
          </p>
        </div>
        <Toggle
          checked={status?.codex ?? false}
          onChange={(next) => onToggle("codex", next)}
          disabled={status == null || busy === "codex"}
        />
      </div>

      <p className="text-[11px] italic text-text-muted mt-2">
        {t("settings.mcp.autoRegisterHint")}
      </p>

      <div className="h-px bg-black/10 mt-4" />

      {/* Custom MCP Server */}
      <div className="flex items-center justify-between pt-4 pb-2">
        <p className="text-[13px] font-semibold text-text-primary">
          {t("settings.mcp.customHeader")}
        </p>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary border border-border rounded-md px-2.5 py-1 hover:bg-bg-input cursor-pointer transition-colors"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t("settings.mcp.copied") : t("settings.mcp.copyConfig")}
        </button>
      </div>
      <p className="text-[12px] text-text-muted leading-[1.5]">
        {t("settings.mcp.customSub")}
      </p>

      {/* Localhost-trust caveat */}
      <div className="flex items-start gap-2.5 bg-accent-bg/40 rounded-lg px-3 py-2.5 mt-4">
        <ShieldAlert size={14} className="text-accent-text shrink-0 mt-0.5" />
        <p className="text-[11px] text-text-secondary leading-[1.5]">
          {t("settings.mcp.caveat")}
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center justify-between bg-[#fef2f2] dark:bg-red-950/30 border border-[#ffc9c9] dark:border-red-800 rounded-lg px-3.5 py-2 mt-3">
          <span className="text-[12px] text-[#e7000b] dark:text-red-400 truncate">
            {error}
          </span>
          <button
            type="button"
            className="text-[12px] font-medium text-[#e7000b] dark:text-red-400 underline cursor-pointer ml-2 shrink-0"
            onClick={() => {
              setError(null);
              refresh();
            }}
          >
            {t("settings.ai.retry")}
          </button>
        </div>
      )}
    </div>
  );
}
