import type { ReadStatePayload } from "@spook/shared";
import { create } from "zustand";
import { compareIds } from "./snowflake";

/** O servidor limita a contagem em 100 ("100 ou mais"); a UI mostra 99+. */
export const UNREAD_CAP = 100;

export type ChannelRead = {
  /** Ausente em DM. */
  guildId?: string;
  /** Ponto de leitura no servidor; vazio = desconhecido (canal que só conhecemos por eventos). */
  lastRead: string;
  /** Menções (em DM, toda mensagem de outra pessoa). */
  mentions: number;
  unread: number;
  /** Id da mensagem de outra pessoa mais nova que este cliente viu chegar. */
  latest?: string;
};

type State = {
  channels: Readonly<Record<string, ChannelRead>>;
  /** Já chegou um snapshot (READY ou GET): antes disso "sem não lidas" não quer dizer zero. */
  loaded: boolean;
};

type Actions = {
  /** Snapshot completo (READY ou GET): canais ausentes valem zero. */
  replaceAll: (list: readonly ReadStatePayload[]) => void;
  /** Mensagem de outra pessoa num canal que o usuário não está vendo. */
  addUnread: (channelId: string, guildId: string | undefined, messageId: string) => void;
  /**
   * Mensagem de outra pessoa que chegou com o canal à vista (lida na hora): não conta como não lida,
   * mas o servidor ainda não sabe que foi lida, então o ack precisa sair.
   */
  noteSeen: (channelId: string, guildId: string | undefined, messageId: string) => void;
  /**
   * READ_STATE_UPDATE. Devolve `true` se o ponto de leitura avançou e o cliente não sabe o novo
   * `unread` (outra sessão leu parte do canal): quem chamou deve refazer o GET. `mention_count` é
   * absoluto e vem do servidor (por isso `addUnread` não mexe nas menções).
   */
  applyUpdate: (u: {
    channel_id: string;
    last_read_message_id: string;
    mention_count: number;
  }) => boolean;
  /**
   * Este cliente acusou leitura até `messageId`. `mentions` é o `mention_count` que o servidor
   * devolveu no ack (menção que chegou no meio do caminho continua contando).
   */
  markRead: (channelId: string, messageId: string, mentions?: number) => void;
  /** Canal excluído ou perdido de vista. */
  removeChannel: (channelId: string) => void;
  /** Saiu do servidor (ou ele foi excluído): some tudo que era dele. */
  removeGuild: (guildId: string) => void;
  reset: () => void;
};

const empty: State = { channels: {}, loaded: false };

export const useReadStateStore = create<State & Actions>()((set, get) => ({
  ...empty,

  replaceAll: (list) => {
    const channels: Record<string, ChannelRead> = {};
    for (const r of list)
      channels[r.channel_id] = {
        guildId: r.guild_id,
        lastRead: r.last_read_message_id,
        mentions: r.mention_count,
        unread: Math.min(r.unread_count, UNREAD_CAP),
      };
    set({ channels, loaded: true });
  },

  addUnread: (channelId, guildId, messageId) =>
    set((s) => {
      const cur = s.channels[channelId];
      // Mensagem que o ponto de leitura já cobre (reentrega): não conta.
      if (cur && compareIds(messageId, cur.lastRead) <= 0) return s;
      // Mesma mensagem de novo (evento duplicado): não conta duas vezes.
      if (cur?.latest && compareIds(messageId, cur.latest) <= 0) return s;
      const next: ChannelRead = cur
        ? { ...cur, unread: Math.min(cur.unread + 1, UNREAD_CAP), latest: messageId }
        : // Sem ponto de leitura conhecido (lastRead vazio): não há separador, só a contagem.
          { guildId, lastRead: "", mentions: 0, unread: 1, latest: messageId };
      return { channels: { ...s.channels, [channelId]: next } };
    }),

  noteSeen: (channelId, guildId, messageId) =>
    set((s) => {
      const cur = s.channels[channelId];
      if (cur?.latest && compareIds(messageId, cur.latest) <= 0) return s;
      const next: ChannelRead = cur
        ? { ...cur, latest: messageId }
        : { guildId, lastRead: "", mentions: 0, unread: 0, latest: messageId };
      return { channels: { ...s.channels, [channelId]: next } };
    }),

  applyUpdate: (u) => {
    const cur = get().channels[u.channel_id];
    if (!cur) {
      // Canal que o cliente não conhecia: só vale guardar se há menção (ao menos uma não lida).
      if (u.mention_count > 0)
        set((s) => ({
          channels: {
            ...s.channels,
            [u.channel_id]: {
              lastRead: u.last_read_message_id,
              mentions: u.mention_count,
              unread: 1,
            },
          },
        }));
      return false;
    }
    const advanced = compareIds(u.last_read_message_id, cur.lastRead) > 0;
    let unread = cur.unread;
    let reconcile = false;
    if (advanced && unread > 0) {
      // Vi a mensagem mais nova e o ponto de leitura a alcançou: leu tudo. Senão só o GET sabe quanto sobrou.
      if (cur.latest && compareIds(u.last_read_message_id, cur.latest) >= 0) unread = 0;
      else reconcile = true;
    }
    set((s) => ({
      channels: {
        ...s.channels,
        [u.channel_id]: {
          ...cur,
          lastRead: advanced ? u.last_read_message_id : cur.lastRead,
          mentions: u.mention_count,
          unread,
        },
      },
    }));
    return reconcile;
  },

  markRead: (channelId, messageId, mentions = 0) =>
    set((s) => {
      const cur = s.channels[channelId];
      if (!cur) return s;
      const lastRead = compareIds(messageId, cur.lastRead) > 0 ? messageId : cur.lastRead;
      if (cur.unread === 0 && cur.mentions === mentions && lastRead === cur.lastRead) return s;
      return {
        channels: { ...s.channels, [channelId]: { ...cur, lastRead, unread: 0, mentions } },
      };
    }),

  removeChannel: (channelId) =>
    set((s) => {
      if (!(channelId in s.channels)) return s;
      const { [channelId]: _gone, ...rest } = s.channels;
      return { channels: rest };
    }),

  removeGuild: (guildId) =>
    set((s) => ({
      channels: Object.fromEntries(
        Object.entries(s.channels).filter(([, c]) => c.guildId !== guildId),
      ),
    })),

  reset: () => set(empty),
}));

// ---- Derivados (puros, para as telas e para os testes) ----

export type Totals = { unread: number; mentions: number };

/** Soma de um servidor: não lidas limitadas a 100, como o agregado do servidor. */
export function guildTotals(channels: State["channels"], guildId: string): Totals {
  let unread = 0;
  let mentions = 0;
  for (const c of Object.values(channels)) {
    if (c.guildId !== guildId) continue;
    unread += c.unread;
    mentions += c.mentions;
  }
  return { unread: Math.min(unread, UNREAD_CAP), mentions };
}

/** DMs (canais sem servidor): quantas conversas têm não lidas e a soma das "menções" (toda mensagem). */
export function dmTotals(channels: State["channels"]): Totals & { conversations: number } {
  let unread = 0;
  let mentions = 0;
  let conversations = 0;
  for (const c of Object.values(channels)) {
    if (c.guildId) continue;
    if (c.unread > 0 || c.mentions > 0) conversations++;
    unread += c.unread;
    mentions += c.mentions;
  }
  return { unread: Math.min(unread, UNREAD_CAP), mentions, conversations };
}

/** Menções de todos os lugares: o número do título da aba. */
export function allMentions(channels: State["channels"]): number {
  let n = 0;
  for (const c of Object.values(channels)) n += c.mentions;
  return n;
}

/** "99+" acima de 99. */
export const formatCount = (n: number) => (n > 99 ? "99+" : String(n));
