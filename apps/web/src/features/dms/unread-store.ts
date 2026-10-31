import { create } from "zustand";

type UnreadState = { channels: ReadonlySet<string> };
type UnreadActions = {
  mark: (channelId: string) => void;
  clear: (channelId: string) => void;
  reset: () => void;
};

/**
 * DMs com mensagem nova desde que a sessão começou. Só na memória: a contagem de verdade (e
 * persistida entre sessões) é a Fase 6 (`read_states`).
 */
export const useDmUnreadStore = create<UnreadState & UnreadActions>()((set) => ({
  channels: new Set(),
  mark: (channelId) =>
    set((s) => (s.channels.has(channelId) ? s : { channels: new Set(s.channels).add(channelId) })),
  clear: (channelId) =>
    set((s) => {
      if (!s.channels.has(channelId)) return s;
      const next = new Set(s.channels);
      next.delete(channelId);
      return { channels: next };
    }),
  reset: () => set({ channels: new Set() }),
}));
