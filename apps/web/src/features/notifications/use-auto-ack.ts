import { ackChannel } from "@spook/shared";
import { useEffect } from "react";
import { useChannelRead } from "./badges";
import { type ChannelRead, useReadStateStore } from "./read-state";
import { compareIds } from "./snowflake";
import { usePageActive, useViewportStore } from "./viewport";

export const ACK_DEBOUNCE_MS = 400;

/** Último id acusado por canal nesta sessão: evita repetir o mesmo ack. */
const acked = new Map<string, string>();
export const resetAckMemory = () => acked.clear();

/**
 * Regra de quando acusar leitura: canal aberto, aba visível e com foco, lista rolada até o fim e algo
 * a acusar (não lidas, menções ou uma mensagem vista ao vivo que o servidor ainda não sabe que foi
 * lida). Nunca repete o ack de um id que já foi acusado.
 */
export function shouldAck(args: {
  enabled: boolean;
  active: boolean;
  atBottom: boolean;
  lastMessageId: string | undefined;
  read: Pick<ChannelRead, "unread" | "mentions" | "lastRead" | "latest"> | undefined;
  alreadyAcked: string | undefined;
}): boolean {
  const { read, lastMessageId } = args;
  if (!args.enabled || !args.active || !args.atBottom || !lastMessageId || !read) return false;
  const pendingSeen = !!read.latest && compareIds(read.latest, read.lastRead) > 0;
  if (read.unread === 0 && read.mentions === 0 && !pendingSeen) return false;
  return !args.alreadyAcked || compareIds(lastMessageId, args.alreadyAcked) > 0;
}

export function useAutoAck(channelId: string, lastMessageId: string | undefined, enabled: boolean) {
  const read = useChannelRead(channelId);
  const active = usePageActive();
  const atBottom = useViewportStore((s) => s.channelId === channelId && s.atBottom);
  const unread = read?.unread ?? 0;
  const mentions = read?.mentions ?? 0;
  const lastRead = read?.lastRead ?? "";
  const latest = read?.latest;
  const has = !!read;

  useEffect(() => {
    if (
      !shouldAck({
        enabled,
        active,
        atBottom,
        lastMessageId,
        read: has ? { unread, mentions, lastRead, latest } : undefined,
        alreadyAcked: acked.get(channelId),
      })
    )
      return;
    const id = lastMessageId as string;
    const timer = setTimeout(async () => {
      // O ponto de leitura já cobre a última mensagem (contagem velha): só limpa o local.
      if (lastRead && compareIds(id, lastRead) <= 0 && mentions === 0 && !latest) {
        useReadStateStore.getState().markRead(channelId, id);
        return;
      }
      acked.set(channelId, id);
      try {
        const res = await ackChannel(channelId, { message_id: id });
        useReadStateStore.getState().markRead(channelId, id, res.mention_count);
      } catch {
        acked.delete(channelId); // tenta de novo na próxima mudança (rede, 429)
      }
    }, ACK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    enabled,
    active,
    atBottom,
    lastMessageId,
    unread,
    mentions,
    lastRead,
    latest,
    has,
    channelId,
  ]);
}
