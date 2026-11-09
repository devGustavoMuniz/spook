import type { RelationshipPayload, RelationshipsReady } from "@spook/shared";
import { create } from "zustand";

/**
 * Amizades e bloqueios que o cliente conhece sem pedir nada: o resumo do READY (pedidos e uma parte dos amigos)
 * e os eventos RELATIONSHIP_*. A lista completa da tela de Amigos vem do REST (`useAllRelationships`); aqui ficam
 * o que o resto do app consulta o tempo todo: quem está bloqueado (para recolher mensagens) e quantos pedidos
 * esperam resposta (selo da barra de servidores).
 */
type SocialState = {
  /** user_id → relacionamento (amigo ou pedido). Bloqueados ficam em `blocked`. */
  rels: Readonly<Record<string, RelationshipPayload>>;
  /** user_id → true para quem eu bloqueei. */
  blocked: Readonly<Record<string, true>>;
  /** Contagem de pedidos recebidos informada pelo servidor no READY (vale se a lista veio truncada). */
  incomingCount: number;
};

type SocialActions = {
  replaceAll: (ready: RelationshipsReady | undefined) => void;
  /** RELATIONSHIP_ADD e _UPDATE. */
  upsert: (p: RelationshipPayload) => void;
  /** RELATIONSHIP_REMOVE: a pessoa deixou de ter relacionamento comigo (inclusive desbloqueio). */
  remove: (userId: string) => void;
  /** USER_UPDATE: nome e avatar de quem já está na lista. */
  patchUser: (u: {
    id: string;
    username: string;
    display_name?: string;
    avatar_url?: string;
    plan?: "free" | "nitro" | "nitro_plus";
  }) => void;
  reset: () => void;
};

export const useSocialStore = create<SocialState & SocialActions>()((set) => ({
  rels: {},
  blocked: {},
  incomingCount: 0,
  replaceAll: (ready) => {
    const items = ready?.items ?? [];
    set({
      rels: Object.fromEntries(
        items.filter((i) => i.type !== "blocked").map((i) => [i.user.id, i] as const),
      ),
      blocked: Object.fromEntries((ready?.blocked_ids ?? []).map((id) => [id, true as const])),
      incomingCount: ready?.incoming_count ?? 0,
    });
  },
  upsert: (p) =>
    set((s) => {
      const id = p.user.id;
      const wasIncoming = s.rels[id]?.type === "incoming";
      let incomingCount = s.incomingCount;
      if (p.type === "blocked") {
        const { [id]: _gone, ...rels } = s.rels;
        if (wasIncoming) incomingCount = Math.max(0, incomingCount - 1);
        return { rels, blocked: { ...s.blocked, [id]: true }, incomingCount };
      }
      if (p.type === "incoming" && !wasIncoming) incomingCount += 1;
      if (p.type !== "incoming" && wasIncoming) incomingCount = Math.max(0, incomingCount - 1);
      const { [id]: _unblocked, ...blocked } = s.blocked;
      return { rels: { ...s.rels, [id]: p }, blocked, incomingCount };
    }),
  remove: (userId) =>
    set((s) => {
      const wasIncoming = s.rels[userId]?.type === "incoming";
      const { [userId]: _r, ...rels } = s.rels;
      const { [userId]: _b, ...blocked } = s.blocked;
      return { rels, blocked, incomingCount: Math.max(0, s.incomingCount - (wasIncoming ? 1 : 0)) };
    }),
  patchUser: (u) =>
    set((s) => {
      const cur = s.rels[u.id];
      if (!cur) return s;
      return {
        rels: {
          ...s.rels,
          [u.id]: {
            ...cur,
            user: {
              ...cur.user,
              username: u.username,
              display_name: u.display_name,
              avatar_url: u.avatar_url,
              plan: u.plan ?? "free",
            },
          },
        },
      };
    }),
  reset: () => set({ rels: {}, blocked: {}, incomingCount: 0 }),
}));

/** Eu bloqueei esta pessoa? (reage só a ela). */
export const useIsBlocked = (userId: string | undefined): boolean =>
  useSocialStore((s) => !!userId && !!s.blocked[userId]);

/** Pedidos de amizade recebidos esperando resposta (selo do Início). */
export const useIncomingCount = (): number => useSocialStore((s) => s.incomingCount);

/** Relacionamento conhecido pelo cliente (amigo ou pedido); bloqueio vem de `useIsBlocked`. */
export const useKnownRelationship = (userId: string | undefined) =>
  useSocialStore((s) => (userId ? s.rels[userId] : undefined));
