import {
  getListPinnedMessagesQueryKey,
  type MessagePayload,
  type PinsOutputBody,
} from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";

/** Cache da lista de fixadas do canal (`GET /channels/{id}/pins`), da mais recentemente fixada à mais antiga. */
export const pinsKey = getListPinnedMessagesQueryKey;

function update(
  qc: QueryClient,
  channelId: string,
  fn: (list: MessagePayload[]) => MessagePayload[],
) {
  qc.setQueryData<PinsOutputBody>(pinsKey(channelId), (old) =>
    old ? { ...old, messages: fn(old.messages ?? []) } : old,
  );
}

/**
 * Aplica um MESSAGE_UPDATE à lista de fixadas: fixada entra no topo (ou é atualizada no lugar, se já
 * estava), desafixada sai. Sem a lista carregada não faz nada (ela é buscada ao abrir o painel).
 */
export function applyPinUpdate(qc: QueryClient, channelId: string, msg: MessagePayload) {
  update(qc, channelId, (list) => {
    const has = list.some((m) => m.id === msg.id);
    if (!msg.pinned) return has ? list.filter((m) => m.id !== msg.id) : list;
    return has ? list.map((m) => (m.id === msg.id ? msg : m)) : [msg, ...list];
  });
}

/** Mensagem apagada some das fixadas. */
export function removePinned(qc: QueryClient, channelId: string, messageId: string) {
  update(qc, channelId, (list) =>
    list.some((m) => m.id === messageId) ? list.filter((m) => m.id !== messageId) : list,
  );
}
