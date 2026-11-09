import {
  type ChannelPayload,
  getGetMeQueryKey,
  type MemberListOutputBody,
  type MessageListOutputBody,
  type MessagePayload,
  type PinsOutputBody,
  type UserUpdateData,
  type View,
} from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSocialStore } from "@/features/social/store";
import { dmsOf, setDMs } from "@/lib/dm-cache";
import { isMembersKey, isMessagesKey } from "@/lib/queryKeys";

/** Campos públicos do perfil (o que o USER_UPDATE leva), a partir do `View` que a edição devolve. */
export function profileOf(v: View): UserUpdateData {
  return {
    id: v.id,
    username: v.username,
    display_name: v.display_name || undefined,
    avatar_url: v.avatar_url || undefined,
    bio: v.bio || undefined,
    pronouns: v.pronouns || undefined,
    banner_url: v.banner_url || undefined,
    banner_color: v.banner_color ?? undefined,
  };
}

/** Campos de identidade que aparecem em autor, destinatário e relacionamento (sem bio, pronomes e banner). */
const identity = (u: { id: string }, d: UserUpdateData) => ({
  ...u,
  username: d.username,
  display_name: d.display_name,
  avatar_url: d.avatar_url,
});

const isPinsKey = (key: readonly unknown[]) =>
  typeof key[0] === "string" && /^\/api\/channels\/[^/]+\/pins$/.test(key[0]);
const isRelationshipsKey = (key: readonly unknown[]) =>
  typeof key[0] === "string" && key[0] === "/api/users/me/relationships";

function patchMessage(m: MessagePayload, d: UserUpdateData): MessagePayload {
  const byAuthor = m.author.id === d.id;
  const reply = m.reply_to;
  const byReply = reply && reply.author.id === d.id;
  if (!byAuthor && !byReply) return m;
  return {
    ...m,
    author: byAuthor ? identity(m.author, d) : m.author,
    reply_to: byReply
      ? {
          ...reply,
          author: { ...reply.author, username: d.username, display_name: d.display_name },
        }
      : reply,
  };
}

/**
 * USER_UPDATE: o perfil de alguém mudou. Aplica nos caches que guardam nome/avatar dessa pessoa SEM refetch:
 * `me`, listas de membros (todos os servidores carregados), mensagens já carregadas (autor e citação), fixadas,
 * DMs (participantes) e relacionamentos. A voz não guarda cópia: o palco e a lista de participantes leem de
 * membros/DMs/`me` (ver `usePersonLookup`), então atualizam junto. Cache ausente = nada a fazer.
 */
export function applyUserUpdate(qc: QueryClient, d: UserUpdateData, myId: string | null) {
  if (d.id === myId) {
    qc.setQueryData<View>(getGetMeQueryKey(), (old) =>
      old
        ? {
            ...old,
            username: d.username,
            display_name: d.display_name ?? "",
            avatar_url: d.avatar_url,
            bio: d.bio ?? "",
            pronouns: d.pronouns ?? "",
            banner_url: d.banner_url,
            banner_color: d.banner_color,
          }
        : old,
    );
  }

  qc.setQueriesData<MemberListOutputBody>({ predicate: (q) => isMembersKey(q.queryKey) }, (old) =>
    old?.members?.some((m) => m.user_id === d.id)
      ? {
          ...old,
          members: old.members.map((m) =>
            m.user_id === d.id
              ? {
                  ...m,
                  username: d.username,
                  display_name: d.display_name,
                  avatar_url: d.avatar_url,
                  bio: d.bio,
                  pronouns: d.pronouns,
                  banner_url: d.banner_url,
                  banner_color: d.banner_color,
                }
              : m,
          ),
        }
      : old,
  );

  qc.setQueriesData<{ pages: MessageListOutputBody[]; pageParams: unknown[] }>(
    { predicate: (q) => isMessagesKey(q.queryKey) },
    (old) =>
      old?.pages
        ? {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              messages: (p.messages ?? []).map((m) => patchMessage(m, d)),
            })),
          }
        : old,
  );

  qc.setQueriesData<PinsOutputBody>({ predicate: (q) => isPinsKey(q.queryKey) }, (old) =>
    old ? { ...old, messages: (old.messages ?? []).map((m) => patchMessage(m, d)) } : old,
  );

  const dms = dmsOf(qc);
  if (dms.some((c) => c.recipients?.some((r) => r.id === d.id))) {
    setDMs(
      qc,
      dms.map(
        (c): ChannelPayload =>
          c.recipients?.some((r) => r.id === d.id)
            ? { ...c, recipients: c.recipients.map((r) => (r.id === d.id ? identity(r, d) : r)) }
            : c,
      ),
    );
  }

  qc.setQueriesData<unknown>(
    { predicate: (q) => isRelationshipsKey(q.queryKey) },
    (old: unknown) =>
      Array.isArray(old)
        ? old.map((r: { user?: { id: string } }) =>
            r.user?.id === d.id ? { ...r, user: identity(r.user, d) } : r,
          )
        : old,
  );
  useSocialStore.getState().patchUser(d);
}
