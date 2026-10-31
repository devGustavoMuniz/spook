import type { MessagePayload } from "@spook/shared";
import { dayKey, formatDay } from "@/lib/format";

export type MessageRowData = {
  kind: "message";
  key: string;
  message: MessagePayload;
  /** Mostra avatar, nome e hora (primeira mensagem de uma sequência do mesmo autor). */
  header: boolean;
  /** Rótulo do dia quando a mensagem abre um dia novo. */
  day?: string;
};
export type Row = { kind: "start"; key: "start" } | MessageRowData;

const GROUP_WINDOW_MS = 7 * 60_000;

export function buildRows(messages: MessagePayload[], opts: { hasMore: boolean }): Row[] {
  const rows: Row[] = [];
  // O indicador "carregando anteriores" fica fora da lista (não desloca nada ao aparecer).
  if (!opts.hasMore) rows.push({ kind: "start", key: "start" });

  let prev: MessagePayload | undefined;
  for (const message of messages) {
    const newDay = !prev || dayKey(prev.created_at) !== dayKey(message.created_at);
    const header =
      newDay ||
      !prev ||
      prev.author.id !== message.author.id ||
      Date.parse(message.created_at) - Date.parse(prev.created_at) > GROUP_WINDOW_MS;
    rows.push({
      kind: "message",
      key: message.id,
      message,
      header,
      day: newDay ? formatDay(message.created_at) : undefined,
    });
    prev = message;
  }
  return rows;
}
