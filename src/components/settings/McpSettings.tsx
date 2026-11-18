import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../platform";
import { useTranslation } from "react-i18next";
import { Check, Copy, RefreshCw, ShieldAlert } from "lucide-react";
import Button from "../ui/Button";
import Switch from "../ui/Switch";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";

interface IntegrationStatus {
  claude_code: boolean;
  codex: boolean;
  write_enabled: boolean;
  binary_path: string;
}

type ClientId = "claude_code" | "codex";

export default function McpSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [busy, setBusy] = useState<ClientId | null>(null);
  const [writeBusy, setWriteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [next, snip] = await Promise.all([
        invoke<IntegrationStatus>("mcp_integration_status"),
        invoke<string>("mcp_config_snippet"),
      ]);
      setStatus(next);
      setSnippet(snip);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
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

  const onWriteToggle = async (next: boolean) => {
    setWriteBusy(true);
    setError(null);
    try {
      await invoke("mcp_set_write_access", { enabled: next });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWriteBusy(false);
    }
  };

  const onCopy = () => {
    if (!snippet) return;
    navigator.clipboard
      .writeText(snippet)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <div className="flex flex-col gap-7">
      {/* CLIENTS */}
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.mcp.clientsGroup")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.mcp.claudeCode")}
            hint="~/.claude.json"
          >
            <Switch
              aria-label={t("settings.mcp.claudeCode")}
              checked={status?.claude_code ?? false}
              onChange={(next) => void onToggle("claude_code", next)}
              disabled={status == null || busy === "claude_code"}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.mcp.codex")}
            hint="~/.codex/config.toml"
          >
            <Switch
              aria-label={t("settings.mcp.codex")}
              checked={status?.codex ?? false}
              onChange={(next) => void onToggle("codex", next)}
              disabled={status == null || busy === "codex"}
            />
          </SettingsRow>
        </SettingsGroup>
        <p className="text-[12.5px] text-text-tertiary leading-[1.5]">
          {t("settings.mcp.autoRegisterHint")}
        </p>
      </section>

      {/* ACCESS */}
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.mcp.accessGroup")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.mcp.writeAccess")}
            hint={t("settings.mcp.writeAccessSub")}
          >
            <Switch
              aria-label={t("settings.mcp.writeAccess")}
              checked={status?.write_enabled ?? false}
              onChange={(next) => void onWriteToggle(next)}
              disabled={status == null || writeBusy}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>

      {/* OTHER CLIENTS */}
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.mcp.otherClientsGroup")}</SettingsOverline>
        <div className="bg-surface-solid border border-border-subtle rounded-[14px] px-[18px] py-4 flex flex-col gap-3">
          <pre className="font-mono text-[12px] text-text-secondary leading-[1.6] whitespace-pre-wrap break-all m-0 select-all">
            {snippet ?? ""}
          </pre>
          <div className="flex items-center justify-between gap-4">
            <p className="text-[12.5px] text-text-tertiary">
              {t("settings.mcp.customSub")}
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={!snippet}
              onClick={onCopy}
            >
              {copied ? (
                <Check size={14} className="text-success" />
              ) : (
                <Copy size={14} className="text-text-secondary" />
              )}
              <span>{copied ? t("settings.mcp.copied") : t("settings.mcp.copyConfig")}</span>
            </Button>
          </div>
        </div>

        <div className="bg-warning-tint rounded-[10px] px-3.5 py-3 flex items-start gap-2.5">
          <ShieldAlert size={16} className="text-warning shrink-0 mt-0.5" />
          <p className="text-[12.5px] text-text-secondary leading-[1.5]">
            {t("settings.mcp.caveat")}
          </p>
        </div>
      </section>

      {error && (
        <div
          role="alert"
          className="bg-danger-tint border border-danger/25 rounded-[14px] px-[18px] py-3.5 flex items-center justify-between gap-4"
        >
          <p className="text-[12.5px] text-danger min-w-0 break-words">{error}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              void refresh();
            }}
          >
            <RefreshCw size={13.5} />
            <span>{t("settings.ai.retry")}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
