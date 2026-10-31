import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";

/** "Hoje às 14:05", "Ontem às 09:30" ou "12/10/2026 14:05". */
export function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  const hm = format(d, "HH:mm", { locale: ptBR });
  if (isToday(d)) return `Hoje às ${hm}`;
  if (isYesterday(d)) return `Ontem às ${hm}`;
  return `${format(d, "dd/MM/yyyy", { locale: ptBR })} ${hm}`;
}

export function formatClock(iso: string): string {
  return format(new Date(iso), "HH:mm", { locale: ptBR });
}

/** Separador de dia: "30 de outubro de 2026". */
export function formatDay(iso: string): string {
  return format(new Date(iso), "d 'de' MMMM 'de' yyyy", { locale: ptBR });
}

export function dayKey(iso: string): string {
  return format(new Date(iso), "yyyy-MM-dd");
}

export function formatDateTime(iso: string): string {
  return format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR });
}
