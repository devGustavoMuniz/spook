// Liga os eventos do gateway ao cache do TanStack Query (SPEC 5.5, Fase 3 front). Sem React aqui:
// a função `applyGatewayEvent` é pura em relação ao `QueryClient` e fácil de testar.
import type { ChannelPayload, DetailPayload, GatewayEvent } from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import { bumpDM, findDm, removeDM, setDMs, upsertDM } from "@/lib/dm-cache";
import {
  appendGuild,
  patchGuild,
  refreshGuilds,
  removeChannel,
  removeGuild,
  removeRole,
  setGuilds,
  upsertChannel,
  upsertRole,
} from "@/lib/guild-cache";
import { dropRoleFromMembers, removeMember, upsertMember } from "@/lib/member-cache";
import { addMessage, removeMessage, replaceMessage } from "@/lib/message-cache";
import { isMembersKey, isMessagesKey, queryKeys } from "@/lib/queryKeys";
import { dmTitle } from "../dms/dm-utils";
import { useDmUnreadStore } from "../dms/unread-store";
import { usePresenceStore } from "../presence/store";
import { useTypingStore } from "../typing/store";

/** O que o cache não sabe fazer sozinho: ler onde o usuário está e levá-lo a outro lugar. */
export type GatewayEffects = {
  myId(): string | null;
  location(): { guildId?: string; channelId?: string };
  /** O usuário saiu do servidor aberto (expulso, excluído…) ou ele deixou de existir. */
  leftGuild(guildName: string | undefined): void;
  /** O canal aberto foi excluído ou deixou de estar visível. */
  channelGone(guildId: string, channelName: string | undefined): void;
  /** Saí (ou fui removido) da DM que está aberta: avisa e leva à lista de conversas. */
  dmGone(title: string | undefined): void;
};

const guildsOf = (qc: QueryClient) => qc.getQueryData<DetailPayload[] | null>(queryKeys.guilds());
const findGuild = (qc: QueryClient, id: string) => guildsOf(qc)?.find((g) => g.id === id);

/** Eventos perdidos (sessão nova, op 9 ou buraco em `s`): tudo que o cache guarda pode estar velho. */
export function refreshAfterGap(qc: QueryClient) {
  void refreshGuilds(qc);
  void qc.invalidateQueries({ queryKey: queryKeys.dms() });
  useTypingStore.getState().reset(); // o fim do "digitando…" pode ter se perdido
  void qc.invalidateQueries({ predicate: (q) => isMessagesKey(q.queryKey) });
  void qc.invalidateQueries({ predicate: (q) => isMembersKey(q.queryKey) });
}

/** READY: a lista de servidores do servidor manda; o histórico aberto é refeito (fecha a janela READY↔assinatura). */
export function applyReady(
  qc: QueryClient,
  ready: { guilds: DetailPayload[]; private_channels?: ChannelPayload[] | null },
  fx: GatewayEffects,
) {
  setGuilds(qc, ready.guilds);
  setDMs(qc, ready.private_channels ?? []);
  void qc.invalidateQueries(
    { predicate: (q) => isMessagesKey(q.queryKey), refetchType: "active" },
    { cancelRefetch: false },
  );
  reconcileLocation(qc, fx);
}

/** Refaz a lista de servidores e, com ela nova, confere se o usuário ainda pode estar onde está. */
function refreshAndReconcile(qc: QueryClient, fx: GatewayEffects) {
  void refreshGuilds(qc).then(() => reconcileLocation(qc, fx));
}

/** Depois de uma lista nova: se o servidor ou o canal abertos sumiram, leva o usuário para um lugar válido. */
export function reconcileLocation(qc: QueryClient, fx: GatewayEffects) {
  const { guildId, channelId } = fx.location();
  const list = guildsOf(qc);
  if (!guildId || !list) return;
  const guild = list.find((g) => g.id === guildId);
  if (!guild) return fx.leftGuild(undefined);
  if (channelId && !(guild.channels ?? []).some((c) => c.id === channelId))
    fx.channelGone(guildId, undefined);
}

export function applyGatewayEvent(qc: QueryClient, fx: GatewayEffects, ev: GatewayEvent) {
  switch (ev.t) {
    // ---- mensagens ----
    // Dedupe por id: a mensagem que o próprio usuário enviou já entrou pela resposta do POST.
    case "MESSAGE_CREATE":
      addMessage(qc, ev.d.channel_id, ev.d);
      // Quem enviou parou de digitar (vale para servidor e DM).
      useTypingStore.getState().stop(ev.d.channel_id, ev.d.author.id);
      onDmMessage(qc, fx, ev.d.channel_id, ev.d.id, ev.d.author.id);
      return refetchIfLoading(qc, ev.d.channel_id);
    case "MESSAGE_UPDATE":
      replaceMessage(qc, ev.d.channel_id, ev.d);
      return refetchIfLoading(qc, ev.d.channel_id);
    case "MESSAGE_DELETE":
      removeMessage(qc, ev.d.channel_id, ev.d.id);
      return refetchIfLoading(qc, ev.d.channel_id);

    // ---- servidores ----
    case "GUILD_CREATE":
      return appendGuild(qc, ev.d);
    case "GUILD_UPDATE": {
      const before = findGuild(qc, ev.d.id);
      patchGuild(qc, ev.d);
      // Troca de dono muda `is_owner` e permissões; troca de ícone muda a URL assinada.
      if (before && (before.owner_id !== ev.d.owner_id || before.icon_key !== ev.d.icon_key))
        refreshAndReconcile(qc, fx);
      return;
    }
    case "GUILD_DELETE":
      return leaveGuild(qc, fx, ev.d.id);

    // ---- membros ----
    case "GUILD_MEMBER_ADD":
      return upsertMember(qc, ev.d);
    case "GUILD_MEMBER_UPDATE":
      upsertMember(qc, ev.d);
      // Os meus cargos mudaram: permissões e canais visíveis mudam junto; o servidor não avisa, refaz o GET.
      if (ev.d.user_id === fx.myId()) refreshAndReconcile(qc, fx);
      return;
    case "GUILD_MEMBER_REMOVE":
      if (ev.d.user_id === fx.myId()) return leaveGuild(qc, fx, ev.d.guild_id);
      return removeMember(qc, ev.d.guild_id, ev.d.user_id);

    // ---- canais ----
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE":
      if (!ev.d.guild_id) return upsertDM(qc, ev.d);
      return upsertChannel(qc, ev.d);
    case "CHANNEL_DELETE": {
      const guildId = ev.d.guild_id;
      if (!guildId) return leaveDm(qc, fx, ev.d);
      removeChannel(qc, guildId, ev.d.id);
      qc.removeQueries({ queryKey: queryKeys.messages(ev.d.id) });
      if (fx.location().channelId === ev.d.id) fx.channelGone(guildId, ev.d.name);
      return;
    }

    // ---- cargos ----
    case "ROLE_CREATE":
      return upsertRole(qc, ev.d);
    case "ROLE_UPDATE": {
      const mine = isMyRole(qc, ev.d.guild_id, ev.d.id, ev.d.is_everyone);
      upsertRole(qc, ev.d);
      if (mine) refreshAndReconcile(qc, fx); // as minhas permissões efetivas dependem dele
      return;
    }
    case "ROLE_DELETE": {
      const mine = isMyRole(qc, ev.d.guild_id, ev.d.role_id, false);
      removeRole(qc, ev.d.guild_id, ev.d.role_id);
      dropRoleFromMembers(qc, ev.d.guild_id, ev.d.role_id);
      if (mine) refreshAndReconcile(qc, fx);
      return;
    }

    // ---- presença e "digitando…" (Fase 4) ----
    case "PRESENCE_UPDATE":
      return usePresenceStore.getState().set(ev.d.user_id, ev.d.status);
    case "TYPING_START":
      // O servidor também manda o meu próprio evento de volta; eu não me vejo digitando.
      if (ev.d.user_id === fx.myId()) return;
      return useTypingStore.getState().start(ev.d.channel_id, ev.d.user_id);

    // READY/RESUMED vão pelos callbacks do cliente; VOICE_STATE_UPDATE e READ_STATE_UPDATE ainda
    // não têm interface (Fases 5 e 6).
    default:
      return;
  }
}

/**
 * Havia um GET do histórico em andamento (carga inicial ou refeita pelo READY): a resposta pode ter
 * sido gerada antes deste evento e sobrescreveria o cache sem ele. Refaz o GET para não perder o evento.
 */
function refetchIfLoading(qc: QueryClient, channelId: string) {
  const key = queryKeys.messages(channelId);
  if (qc.isFetching({ queryKey: key }) > 0) void qc.invalidateQueries({ queryKey: key });
}

/** Mensagem numa DM: a conversa sobe na lista e, se não está aberta nem é minha, fica marcada como não lida. */
function onDmMessage(
  qc: QueryClient,
  fx: GatewayEffects,
  channelId: string,
  messageId: string,
  authorId: string,
) {
  if (!findDm(qc, channelId)) return;
  bumpDM(qc, channelId, messageId);
  if (authorId !== fx.myId() && fx.location().channelId !== channelId)
    useDmUnreadStore.getState().mark(channelId);
}

/** CHANNEL_DELETE de DM: saí do grupo ou fui removido. */
function leaveDm(qc: QueryClient, fx: GatewayEffects, ch: ChannelPayload) {
  const known = findDm(qc, ch.id);
  removeDM(qc, ch.id);
  qc.removeQueries({ queryKey: queryKeys.messages(ch.id) });
  useDmUnreadStore.getState().clear(ch.id);
  // Quem saiu pelo app já navegou: sem DM no cache, o evento é eco e não repete o aviso.
  if (known && fx.location().channelId === ch.id) fx.dmGone(dmTitle(known, fx.myId() ?? ""));
}

function isMyRole(qc: QueryClient, guildId: string, roleId: string, isEveryone: boolean) {
  const g = findGuild(qc, guildId);
  return isEveryone || !!g?.my_role_ids?.includes(roleId);
}

function leaveGuild(qc: QueryClient, fx: GatewayEffects, guildId: string) {
  const guild = findGuild(qc, guildId);
  // Quem saiu pelo app já tirou o servidor do cache (e navegou): o evento que chega depois é eco.
  if (!guild) return;
  removeGuild(qc, guildId);
  if (fx.location().guildId === guildId) fx.leftGuild(guild.name);
}
