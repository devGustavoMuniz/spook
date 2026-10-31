import type { ChannelPayload } from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export const CHANNEL_DM = 3;
export const CHANNEL_GROUP_DM = 4;
export const isDmType = (type: number) => type === CHANNEL_DM || type === CHANNEL_GROUP_DM;

/** Snowflake: numérico e crescente com o tempo (ids não numéricos só nos testes). */
function idCompare(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

/** Atividade mais recente primeiro: `last_message_id`, ou o id do canal se ainda não há mensagens. */
export function sortByActivity(list: readonly ChannelPayload[]): ChannelPayload[] {
  return [...list].sort((a, b) => idCompare(b.last_message_id ?? b.id, a.last_message_id ?? a.id));
}

const read = (qc: QueryClient) => qc.getQueryData<ChannelPayload[] | null>(queryKeys.dms()) ?? [];
const write = (qc: QueryClient, list: readonly ChannelPayload[]) =>
  qc.setQueryData<ChannelPayload[] | null>(queryKeys.dms(), sortByActivity(list));

export const dmsOf = (qc: QueryClient) => read(qc);
export const findDm = (qc: QueryClient, channelId: string) =>
  read(qc).find((c) => c.id === channelId);

/** READY: as DMs que o servidor mandou substituem a lista. */
export function setDMs(qc: QueryClient, list: readonly ChannelPayload[] | null) {
  write(qc, list ?? []);
}

/** DM nova ou alterada (participantes, nome, última mensagem). */
export function upsertDM(qc: QueryClient, ch: ChannelPayload) {
  write(qc, [...read(qc).filter((c) => c.id !== ch.id), ch]);
}

export function removeDM(qc: QueryClient, channelId: string) {
  write(
    qc,
    read(qc).filter((c) => c.id !== channelId),
  );
}

/** Mensagem nova numa DM: ela sobe na lista. Ids menores que o atual (reenvio, histórico) não regridem. */
export function bumpDM(qc: QueryClient, channelId: string, messageId: string) {
  const cur = findDm(qc, channelId);
  if (!cur) return;
  if (cur.last_message_id && idCompare(cur.last_message_id, messageId) >= 0) return;
  upsertDM(qc, { ...cur, last_message_id: messageId });
}
