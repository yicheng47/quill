import i18n from "../i18n";

/** Relative-time formatter. Input is a unix timestamp in **milliseconds** — the
 *  shape returned by all Tauri commands since migration 009. */
export function timeAgo(millis: number): string {
  const t = i18n.t.bind(i18n);
  const diff = Date.now() - millis;
  if (diff < 60000) return t("time.justNow");
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return t("time.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("time.daysAgo", { count: days });
}
