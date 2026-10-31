import { create } from "zustand";

/**
 * Pedido para rolar até uma mensagem do canal aberto (citação, painel de fixadas, ↑). Quem pede (o painel
 * no cabeçalho) não conhece a lista; o `ChannelView` do canal atende: carrega páginas anteriores se for
 * preciso e a lista rola e destaca a linha. `nonce` distingue dois pedidos seguidos para a mesma mensagem.
 */
type JumpState = {
  request: { channelId: string; messageId: string; nonce: number } | null;
  jumpTo: (channelId: string, messageId: string) => void;
};

let counter = 0;
export const useJumpStore = create<JumpState>()((set) => ({
  request: null,
  jumpTo: (channelId, messageId) => set({ request: { channelId, messageId, nonce: ++counter } }),
}));

/** Máximo de páginas anteriores (50 mensagens cada) que uma citação carrega procurando a original. */
export const MAX_JUMP_PAGES = 10;
