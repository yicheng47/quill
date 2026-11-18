import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import i18n from "../../i18n";
import Button from "../ui/Button";
import Select from "../ui/Select";
import TextField from "../ui/TextField";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import type { SettingsProps } from "./types";
import { LANGUAGE_OPTIONS } from "./languageOptions";

export default function GeneralSettings({ settings, loading, save }: SettingsProps) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("Reader");
  const [draftName, setDraftName] = useState("Reader");
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [language, setLanguage] = useState("en");
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loading) return;
    const savedName = settings.user_name?.trim() || "Reader";
    setDisplayName(savedName);
    if (!editingName) {
      setDraftName(savedName);
    }
    if (settings.language) setLanguage(settings.language);
  }, [settings, loading, editingName]);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  const startEditing = () => {
    setDraftName(displayName);
    setEditingName(true);
  };

  const cancelEditing = () => {
    setDraftName(displayName);
    setEditingName(false);
  };

  const saveDisplayName = async () => {
    if (savingName) return;
    const next = draftName.trim() || "Reader";
    setSavingName(true);
    try {
      await save("user_name", next);
      setDisplayName(next);
      setDraftName(next);
      setEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.general.profileGroup")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.general.displayName")}
            hint={t("settings.general.displayNameHint")}
            className={editingName ? "bg-surface-solid" : ""}
          >
            {editingName ? (
              <div className="flex items-center gap-2">
                <TextField
                  ref={nameInputRef}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveDisplayName();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      e.nativeEvent.stopPropagation();
                      cancelEditing();
                    }
                  }}
                  aria-label={t("settings.general.displayName")}
                  placeholder="Reader"
                  containerClassName="w-[200px] !h-[34px] !rounded-[10px] !px-4 !border-accent !border-[1.5px]"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={savingName}
                  onClick={cancelEditing}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={savingName}
                  onClick={() => void saveDisplayName()}
                >
                  {t("common.save")}
                </Button>
              </div>
            ) : (
              <>
                <span className="text-[14px] text-text-secondary">{displayName}</span>
                <Button variant="secondary" size="sm" onClick={startEditing}>
                  {t("settings.general.edit")}
                </Button>
              </>
            )}
          </SettingsRow>

          <SettingsRow title={t("settings.general.interfaceLanguage")}>
            <Select
              className="w-[156px] shrink-0"
              icon={<Languages size={14} />}
              value={language}
              onChange={(lang) => {
                setLanguage(lang);
                void save("language", lang);
                localStorage.setItem("quill-language", lang);
                void i18n.changeLanguage(lang);
              }}
              options={LANGUAGE_OPTIONS}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}
