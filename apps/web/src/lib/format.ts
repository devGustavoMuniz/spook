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

/** Data completa para dica de hora: "sexta-feira, 30 de outubro de 2026 às 14:05". */
export function formatFullDate(iso: string): string {
  return format(new Date(iso), "EEEE, d 'de' MMMM 'de' yyyy 'às' HH:mm", { locale: ptBR });
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias" ou a data, para listas em que a hora exata fica numa dica. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const secs = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return "agora";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `há ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `há ${days} ${days === 1 ? "dia" : "dias"}`;
  return format(new Date(iso), "dd/MM/yyyy", { locale: ptBR });
}
