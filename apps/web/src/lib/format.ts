import { format, isToday, isYesterday } from "date-fns";
import { dateFnsLocale, t } from "@/i18n";

// Padrões de data/hora vêm do catálogo (chaves "format.*"), pois variam por idioma.
const fmt = (d: Date, patternKey: Parameters<typeof t>[0]) =>
  format(d, t(patternKey), { locale: dateFnsLocale() });

/** "Hoje às 14:05", "Ontem às 09:30" ou "12/10/2026 14:05" (en: "Today at 2:05 PM", "10/12/2026 2:05 PM"). */
export function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  const hm = fmt(d, "format.pattern.time");
  if (isToday(d)) return t("format.todayAt", { time: hm });
  if (isYesterday(d)) return t("format.yesterdayAt", { time: hm });
  return `${fmt(d, "format.pattern.dateShort")} ${hm}`;
}

export function formatClock(iso: string): string {
  return fmt(new Date(iso), "format.pattern.time");
}

/** Separador de dia: "30 de outubro de 2026" / "October 30, 2026". */
export function formatDay(iso: string): string {
  return fmt(new Date(iso), "format.pattern.day");
}

export function dayKey(iso: string): string {
  return format(new Date(iso), "yyyy-MM-dd");
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${fmt(d, "format.pattern.dateShort")} ${fmt(d, "format.pattern.time")}`;
}

/** Data completa para dica de hora: "sexta-feira, 30 de outubro de 2026 às 14:05". */
export function formatFullDate(iso: string): string {
  return fmt(new Date(iso), "format.pattern.fullDate");
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias" ou a data, para listas em que a hora exata fica numa dica. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const secs = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return t("format.relative.now");
  const mins = Math.round(secs / 60);
  if (mins < 60) return t("format.relative.minutes", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("format.relative.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("format.relative.days", { count: days });
  return fmt(new Date(iso), "format.pattern.dateShort");
}
