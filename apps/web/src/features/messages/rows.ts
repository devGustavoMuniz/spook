import type { MessagePayload } from "@spook/shared";
import { dayKey, formatDay } from "@/lib/format";
import { compareIds } from "../notifications/snowflake";

export type MessageRowData = {
  kind: "message";
  key: string;
  message: MessagePayload;
  /** Mostra avatar, nome e hora (primeira mensagem de uma sequência do mesmo autor). */
  header: boolean;
  /** Rótulo do dia quando a mensagem abre um dia novo. */
  day?: string;
  /** Linha "novas mensagens" acima desta mensagem (ponto de leitura da entrada no canal). */
  marker?: boolean;
};
export type Row = { kind: "start"; key: "start" } | MessageRowData;

const GROUP_WINDOW_MS = 7 * 60_000;

export function buildRows(
  messages: MessagePayload[],
  opts: {
    hasMore: boolean /** Ponto de leitura ao abrir o canal; `null` = sem separador. */;
    newAfterId?: string | null;
    myId?: string;
  },
): Row[] {
  const rows: Row[] = [];
  // O indicador "carregando anteriores" fica fora da lista (não desloca nada ao aparecer).
  if (!opts.hasMore) rows.push({ kind: "start", key: "start" });

  let prev: MessagePayload | undefined;
  let markerPlaced = !opts.newAfterId;
  for (const message of messages) {
    const newDay = !prev || dayKey(prev.created_at) !== dayKey(message.created_at);
    // O separador entra na primeira mensagem de outra pessoa depois do ponto de leitura.
    const marker =
      !markerPlaced &&
      compareIds(message.id, opts.newAfterId as string) > 0 &&
      message.author.id !== opts.myId;
    if (marker) markerPlaced = true;
    const header =
      newDay ||
      marker ||
      !!message.reply_to ||
      message.kind === "member_join" ||
      prev?.kind === "member_join" ||
      !prev ||
      prev.author.id !== message.author.id ||
      Date.parse(message.created_at) - Date.parse(prev.created_at) > GROUP_WINDOW_MS;
    rows.push({
      kind: "message",
      key: message.id,
      message,
      header,
      day: newDay ? formatDay(message.created_at) : undefined,
      marker: marker || undefined,
    });
    prev = message;
  }
  return rows;
}
