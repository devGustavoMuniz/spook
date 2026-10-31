import type { MessageListOutputBody, MessagePayload } from "@spook/shared";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export type MessagePages = InfiniteData<MessageListOutputBody, string | undefined>;

/** Páginas (da mais nova à mais antiga, cada uma da mais nova à mais antiga) → lista crescente. */
export function flattenPages(data: MessagePages | undefined): MessagePayload[] {
  if (!data) return [];
  const seen = new Set<string>();
  const out: MessagePayload[] = [];
  for (let p = data.pages.length - 1; p >= 0; p--) {
    const msgs = data.pages[p]?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as MessagePayload;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

function update(qc: QueryClient, channelId: string, fn: (pages: MessagePages) => MessagePages) {
  qc.setQueryData<MessagePages>(queryKeys.messages(channelId), (old) => (old ? fn(old) : old));
}

/** Mensagem nova entra no topo da página mais nova (a Fase 3 usa o mesmo caminho para eventos). */
export function addMessage(qc: QueryClient, channelId: string, msg: MessagePayload) {
  update(qc, channelId, (d) => {
    if (d.pages.some((p) => p.messages?.some((m) => m.id === msg.id))) return d;
    const [first, ...rest] = d.pages;
    if (!first) return d;
    return { ...d, pages: [{ ...first, messages: [msg, ...(first.messages ?? [])] }, ...rest] };
  });
}

export function replaceMessage(qc: QueryClient, channelId: string, msg: MessagePayload) {
  update(qc, channelId, (d) => ({
    ...d,
    pages: d.pages.map((p) => ({
      ...p,
      messages: (p.messages ?? []).map((m) => (m.id === msg.id ? msg : m)),
    })),
  }));
}

export function removeMessage(qc: QueryClient, channelId: string, messageId: string) {
  update(qc, channelId, (d) => ({
    ...d,
    pages: d.pages.map((p) => ({
      ...p,
      messages: (p.messages ?? []).filter((m) => m.id !== messageId),
    })),
  }));
}
