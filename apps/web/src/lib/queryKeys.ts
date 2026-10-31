import {
  getGetInviteQueryKey,
  getGetMeQueryKey,
  getListDMsQueryKey,
  getListGuildMembersQueryKey,
  getListGuildsQueryKey,
  getListInvitesQueryKey,
  getListMessagesQueryKey,
} from "@spook/shared";

/**
 * Todas as chaves de cache do app em um lugar só. Na Fase 3 o gateway atualiza o cache por aqui
 * (setQueryData/invalidateQueries) sem precisar conhecer as telas.
 *
 * `guilds` guarda a lista completa (servidor + canais + cargos + minhas permissões): é a fonte de
 * verdade de tudo que a barra lateral mostra. Mensagens são um useInfiniteQuery por canal.
 */
export const queryKeys = {
  me: getGetMeQueryKey,
  guilds: getListGuildsQueryKey,
  /** DMs (1:1 e em grupo) com participantes, por atividade recente. */
  dms: getListDMsQueryKey,
  /** Prefixo: casa com qualquer página/limite de membros do servidor. */
  members: (guildId: string) => getListGuildMembersQueryKey(guildId),
  invites: getListInvitesQueryKey,
  invitePreview: getGetInviteQueryKey,
  /** Páginas do histórico do canal (`InfiniteData`), da mais nova para a mais antiga. */
  messages: (channelId: string) => [...getListMessagesQueryKey(channelId), "infinite"] as const,
};

/** Casa com o histórico de qualquer canal (`useInfiniteQuery` de mensagens). */
export const isMessagesKey = (key: readonly unknown[]) =>
  typeof key[0] === "string" && /^\/api\/channels\/[^/]+\/messages$/.test(key[0]);

/** Casa com a lista de membros de qualquer servidor. */
export const isMembersKey = (key: readonly unknown[]) =>
  typeof key[0] === "string" && /^\/api\/guilds\/[^/]+\/members$/.test(key[0]);
