import i18n from "../i18n";

export function timeAgo(dateStr: string): string {
  const t = i18n.t.bind(i18n);
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 60000) return t("time.justNow");
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return t("time.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("time.daysAgo", { count: days });
}
