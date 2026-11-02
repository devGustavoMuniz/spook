import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

const nf = new Intl.NumberFormat("pt-BR");
const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

export const formatNumber = (n: number) => nf.format(n);
export const formatDecimal = (n: number) => nf1.format(n);

/** "+12,5%" / "-3%" / "—" (nulo: não há período anterior para comparar). */
export function formatChange(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  return `${pct > 0 ? "+" : ""}${nf1.format(pct)}%`;
}

/** "3 d 4 h", "2 h 5 min", "4 min 10 s", "12 s". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

/** Taxa em bits por segundo, como as redes costumam mostrar: "1,2 Mbps". */
export function formatBitrate(bytesPerSec: number): string {
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${nf1.format(bits / 1e9)} Gbps`;
  if (bits >= 1e6) return `${nf1.format(bits / 1e6)} Mbps`;
  if (bits >= 1e3) return `${nf1.format(bits / 1e3)} kbps`;
  return `${nf1.format(bits)} bps`;
}

export const formatClockTime = (ms: number) => format(new Date(ms), "HH:mm:ss", { locale: ptBR });

/** "28/10" a partir de "2026-10-28" (dia UTC do servidor, sem converter fuso). */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/** Duração curta para rótulos de gráfico: "<1 min", "30 min", "2 h 5 min". */
export function formatDurationShort(totalSeconds: number): string {
  const m = Math.floor(Math.max(0, totalSeconds) / 60);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  const mm = m % 60;
  return mm ? `${Math.floor(m / 60)} h ${mm} min` : `${Math.floor(m / 60)} h`;
}
