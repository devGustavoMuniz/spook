import type { CustomStatusPayload, PresenceStatus, SelfPresencePayload } from "@spook/shared";
import { create } from "zustand";

/** O que a interface mostra: o dos outros nunca é "invisible" (aparecem offline); o meu pode ser. */
export type DisplayStatus = PresenceStatus | "invisible";

type PresenceState = {
  /** user_id → status; quem não está aqui está offline. */
  statuses: Readonly<Record<string, PresenceStatus>>;
  /** user_id → status personalizado (só de quem não está offline). */
  customs: Readonly<Record<string, CustomStatusPayload>>;
  /** Meu id e a minha preferência (online, dnd ou invisível) e status personalizado. */
  meId: string | null;
  mine: SelfPresencePayload;
};

type PresenceActions = {
  /** READY: o snapshot do servidor substitui tudo (só não-offline; o resto é offline). */
  replaceAll: (
    items: readonly {
      user_id: string;
      status: PresenceStatus;
      custom_status?: CustomStatusPayload;
    }[],
  ) => void;
  set: (userId: string, status: PresenceStatus, custom?: CustomStatusPayload) => void;
  /** READY e PRESENCE_SELF_UPDATE: a minha preferência. */
  setMine: (meId: string | null, mine: SelfPresencePayload) => void;
  reset: () => void;
};

const DEFAULT_MINE: SelfPresencePayload = { status_pref: "online" };

/** Presença em memória dos usuários que compartilham servidor ou DM comigo (SPEC 7.6). */
export const usePresenceStore = create<PresenceState & PresenceActions>()((set) => ({
  statuses: {},
  customs: {},
  meId: null,
  mine: DEFAULT_MINE,
  replaceAll: (items) => {
    const visible = items.filter((i) => i.status !== "offline");
    set({
      statuses: Object.fromEntries(visible.map((i) => [i.user_id, i.status])),
      customs: Object.fromEntries(
        visible.flatMap((i) => (i.custom_status ? [[i.user_id, i.custom_status] as const] : [])),
      ),
    });
  },
  set: (userId, status, custom) =>
    set((s) => {
      const sameStatus = (s.statuses[userId] ?? "offline") === status;
      const prev = s.customs[userId];
      const next = status === "offline" ? undefined : custom;
      if (sameStatus && JSON.stringify(prev) === JSON.stringify(next)) return s;
      let customs = s.customs;
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        const { [userId]: _old, ...rest } = s.customs;
        customs = next ? { ...rest, [userId]: next } : rest;
      }
      if (status === "offline") {
        const { [userId]: _gone, ...rest } = s.statuses;
        return { statuses: rest, customs };
      }
      return { statuses: sameStatus ? s.statuses : { ...s.statuses, [userId]: status }, customs };
    }),
  setMine: (meId, mine) =>
    set((s) => {
      const customs = { ...s.customs };
      if (meId) {
        if (mine.custom_status) customs[meId] = mine.custom_status;
        else delete customs[meId];
      }
      return { meId, mine, customs };
    }),
  reset: () => set({ statuses: {}, customs: {}, meId: null, mine: DEFAULT_MINE }),
}));

/** Status mostrado de um usuário; no meu caso, a preferência (invisível, não perturbar) vence o automático. */
export function displayStatus(
  s: Pick<PresenceState, "statuses" | "meId" | "mine">,
  userId: string,
): DisplayStatus {
  const live = s.statuses[userId] ?? "offline";
  if (userId !== s.meId) return live;
  if (s.mine.status_pref === "invisible") return "invisible";
  if (s.mine.status_pref === "dnd") return "dnd";
  return live === "offline" ? "online" : live;
}

/** Status de um usuário; reage só a mudanças dele. */
export const usePresence = (userId: string | undefined): DisplayStatus =>
  usePresenceStore((s) => (userId ? displayStatus(s, userId) : "offline"));

/** Status personalizado vigente (vencido não aparece; o servidor também o remove). */
export function liveCustom(c: CustomStatusPayload | undefined, now = Date.now()) {
  if (!c || (!c.text && !c.emoji)) return undefined;
  if (c.expires_at && Date.parse(c.expires_at) <= now) return undefined;
  return c;
}

export const useCustomStatus = (userId: string | undefined): CustomStatusPayload | undefined =>
  usePresenceStore((s) =>
    userId ? liveCustom(userId === s.meId ? s.mine.custom_status : s.customs[userId]) : undefined,
  );

/** Estou em "Não perturbar"? (suprime toasts, sons, notificações nativas e push). */
export const isDnd = () => usePresenceStore.getState().mine.status_pref === "dnd";
