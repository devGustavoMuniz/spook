/** Epoch do Spook (server/internal/platform/snowflake): 2026-01-01T00:00:00Z. */
const EPOCH_MS = Date.UTC(2026, 0, 1);

/** Instante embutido num ID Snowflake (os 22 bits baixos são nó e sequência); null se o id não for numérico. */
export function snowflakeTime(id: string | null | undefined): Date | null {
  if (!id || !/^\d+$/.test(id)) return null;
  try {
    return new Date(EPOCH_MS + Number(BigInt(id) >> 22n));
  } catch {
    return null;
  }
}

/** Hora curta para listas: "14:05" hoje, "ontem", dia da semana nos últimos 6 dias ou "12/10". */
export function shortListTime(date: Date, now = new Date()): string {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((day(now) - day(date)) / 86_400_000);
  if (diff <= 0) return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (diff === 1) return "ontem";
  if (diff < 7) return date.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
