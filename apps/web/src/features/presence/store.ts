import type { PresenceStatus } from "@spook/shared";
import { create } from "zustand";

type PresenceState = {
  /** user_id → status; quem não está aqui está offline. */
  statuses: Readonly<Record<string, PresenceStatus>>;
};

type PresenceActions = {
  /** READY: o snapshot do servidor substitui tudo (só online/idle; o resto é offline). */
  replaceAll: (items: readonly { user_id: string; status: PresenceStatus }[]) => void;
  set: (userId: string, status: PresenceStatus) => void;
  reset: () => void;
};

/** Presença em memória dos usuários que compartilham servidor ou DM comigo (SPEC 7.6). */
export const usePresenceStore = create<PresenceState & PresenceActions>()((set) => ({
  statuses: {},
  replaceAll: (items) =>
    set({
      statuses: Object.fromEntries(
        items.filter((i) => i.status !== "offline").map((i) => [i.user_id, i.status]),
      ),
    }),
  set: (userId, status) =>
    set((s) => {
      if ((s.statuses[userId] ?? "offline") === status) return s;
      if (status === "offline") {
        const { [userId]: _gone, ...rest } = s.statuses;
        return { statuses: rest };
      }
      return { statuses: { ...s.statuses, [userId]: status } };
    }),
  reset: () => set({ statuses: {} }),
}));

/** Status de um usuário; reage só a mudanças dele. */
export const usePresence = (userId: string | undefined): PresenceStatus =>
  usePresenceStore((s) => (userId ? (s.statuses[userId] ?? "offline") : "offline"));
