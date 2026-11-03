import { enUS } from "date-fns/locale/en-US";
import { ptBR } from "date-fns/locale/pt-BR";
import { getLocale } from "./core";
import type { Locale } from "./types";

export const dateFnsLocale = (l: Locale = getLocale()) => (l === "en" ? enUS : ptBR);

/** Número no idioma ativo (separador de milhar etc.). */
export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), opts).format(n);
}

/** Contador compacto: 1..99 como está, acima de 99 "99+". */
export function formatBadge(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** Lista "a, b e c" / "a, b, and c" no idioma ativo. */
export function formatList(items: string[], type: "conjunction" | "disjunction" = "conjunction") {
  return new Intl.ListFormat(getLocale(), { style: "long", type }).format(items);
}

/** Tempo relativo via Intl ("há 5 minutos" / "5 minutes ago"). */
export function formatRelativeUnit(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" }).format(value, unit);
}
