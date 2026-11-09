// Liga os eventos do gateway ao cache do TanStack Query (SPEC 5.5, Fase 3 front). Sem React aqui:
// a função `applyGatewayEvent` é pura em relação ao `QueryClient` e fácil de testar.
import type {
  CallPayload,
  ChannelPayload,
  DetailPayload,
  GatewayEvent,
  MessagePayload,
  ReadStatePayload,
  RelationshipsReady,
  TicketUpdateData,
  VoiceStatePayload,
} from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import { t } from "@/i18n";
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
import { bulkMentionsMe } from "@/lib/mentions";
import { addMessage, removeMessage, replaceMessage } from "@/lib/message-cache";
import { applyPinUpdate, removePinned } from "@/lib/pins-cache";
import { isMembersKey, isMessagesKey, queryKeys } from "@/lib/queryKeys";
import { applyUserUpdate } from "@/lib/user-cache";
import { dmTitle } from "../dms/dm-utils";
import {
  channelUrl,
  type InAppNotification,
  previewBody,
  shouldNotify,
} from "../notifications/in-app";
import { useNotificationPrefs } from "../notifications/prefs";
import { useReadStateStore } from "../notifications/read-state";
import { effective, useNotificationSettings } from "../notifications/settings";
import { reloadReadStates } from "../notifications/sync";
import type { Viewing } from "../notifications/viewport";
import { isDnd, usePresenceStore } from "../presence/store";
import { useCallStore } from "../social/call-store";
import { invalidateRelationships } from "../social/hooks";
import { useSocialStore } from "../social/store";
import { useTypingStore } from "../typing/store";
import { reconcileVoiceSnapshot, reconcileVoiceUpdate } from "../voice/controller";

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
  /** O usuário está vendo este canal agora? (define se a mensagem nova conta como não lida e se avisa). */
  viewing(channelId: string): Viewing;
  /** Aviso in-app (toast ou notificação do navegador) de DM ou menção em canal que não está à vista. */
  notify(n: InAppNotification): void;
  /** A equipe respondeu ou mudou o estado de um chamado meu (aviso com atalho para abri-lo). */
  ticketUpdated?(ticket: TicketUpdateData): void;
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
  reloadReadStates(); // contagens e menções podem ter mudado enquanto estava fora
}

/** READY: a lista de servidores do servidor manda; o histórico aberto é refeito (fecha a janela READY↔assinatura). */
export function applyReady(
  qc: QueryClient,
  ready: {
    guilds: DetailPayload[];
    private_channels?: ChannelPayload[] | null;
    voice_states?: VoiceStatePayload[] | null;
    read_states?: ReadStatePayload[] | null;
    relationships?: RelationshipsReady;
    calls?: CallPayload[] | null;
  },
  fx: GatewayEffects,
) {
  const before = guildsOf(qc);
  setGuilds(qc, ready.guilds);
  // Snapshot completo: canal ausente = zero não lidas.
  useReadStateStore.getState().replaceAll(ready.read_states ?? []);
  setDMs(qc, ready.private_channels ?? []);
  // Social: amizades (resumo) e chamadas que estão tocando para mim agora.
  useSocialStore.getState().replaceAll(ready.relationships);
  useCallStore.getState().replaceIncoming(ready.calls ?? []);
  invalidateRelationships(qc);
  // Snapshot de voz (sempre completo): zera o mapa e confere se a sala local ainda existe no servidor.
  reconcileVoiceSnapshot(fx.myId(), ready.voice_states ?? []);
  void qc.invalidateQueries(
    { predicate: (q) => isMessagesKey(q.queryKey), refetchType: "active" },
    { cancelRefetch: false },
  );
  reconcileLocation(qc, fx, before);
}

/** Refaz a lista de servidores e, com ela nova, confere se o usuário ainda pode estar onde está. */
function refreshAndReconcile(qc: QueryClient, fx: GatewayEffects) {
  void refreshGuilds(qc).then(() => reconcileLocation(qc, fx));
}

/**
 * Depois de uma lista nova: se o servidor ou o canal abertos sumiram, leva o usuário para um lugar válido.
 * `before` é a lista de antes: se o lugar já não existia nela (link para um servidor ou canal inexistente),
 * não houve perda a avisar e a própria tela mostra o estado "não encontrado".
 */
export function reconcileLocation(
  qc: QueryClient,
  fx: GatewayEffects,
  before?: DetailPayload[] | null,
) {
  const { guildId, channelId } = fx.location();
  const list = guildsOf(qc);
  if (!guildId || !list) return;
  const guild = list.find((g) => g.id === guildId);
  const guildBefore = before?.find((g) => g.id === guildId);
  if (!guild) return before && !guildBefore ? undefined : fx.leftGuild(undefined);
  if (channelId && !(guild.channels ?? []).some((c) => c.id === channelId)) {
    const hadChannel = (guildBefore?.channels ?? []).some((c) => c.id === channelId);
    if (!before || hadChannel) fx.channelGone(guildId, undefined);
  }
}

export function applyGatewayEvent(qc: QueryClient, fx: GatewayEffects, ev: GatewayEvent) {
  switch (ev.t) {
    // ---- mensagens ----
    // Dedupe por id: a mensagem que o próprio usuário enviou já entrou pela resposta do POST.
    case "MESSAGE_CREATE":
      addMessage(qc, ev.d.channel_id, ev.d);
      // Quem enviou parou de digitar (vale para servidor e DM).
      useTypingStore.getState().stop(ev.d.channel_id, ev.d.author.id);
      onDmMessage(qc, ev.d.channel_id, ev.d.id);
      onIncomingMessage(qc, fx, ev.d);
      return refetchIfLoading(qc, ev.d.channel_id);
    case "MESSAGE_UPDATE":
      replaceMessage(qc, ev.d.channel_id, ev.d);
      applyPinUpdate(qc, ev.d.channel_id, ev.d);
      return refetchIfLoading(qc, ev.d.channel_id);
    case "MESSAGE_DELETE":
      removeMessage(qc, ev.d.channel_id, ev.d.id);
      removePinned(qc, ev.d.channel_id, ev.d.id);
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
      useReadStateStore.getState().removeChannel(ev.d.id);
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
      return usePresenceStore.getState().set(ev.d.user_id, ev.d.status, ev.d.custom_status);
    case "PRESENCE_SELF_UPDATE":
      // A minha preferência mudou (nesta ou em outra aba): invisível, não perturbar e status personalizado.
      return usePresenceStore.getState().setMine(fx.myId(), ev.d);
    case "USER_UPDATE":
      return applyUserUpdate(qc, ev.d, fx.myId());
    case "NOTIFICATION_SETTINGS_UPDATE":
      return useNotificationSettings.getState().apply(ev.d);
    case "TYPING_START":
      // O servidor também manda o meu próprio evento de volta; eu não me vejo digitando.
      if (ev.d.user_id === fx.myId()) return;
      return useTypingStore.getState().start(ev.d.channel_id, ev.d.user_id);

    // ---- social: amizades, bloqueios e chamadas de DM (só chegam a quem está envolvido) ----
    case "RELATIONSHIP_ADD":
    case "RELATIONSHIP_UPDATE":
      useSocialStore.getState().upsert(ev.d);
      return invalidateRelationships(qc, ev.d.user.id);
    case "RELATIONSHIP_REMOVE":
      useSocialStore.getState().remove(ev.d.user_id);
      return invalidateRelationships(qc, ev.d.user_id);
    // ---- chamados de feedback: só o autor recebe; a lista e a conversa abertas são refeitas ----
    case "TICKET_UPDATE":
      void qc.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/tickets"),
      });
      if (ev.d.by_admin && ev.d.unread) fx.ticketUpdated?.(ev.d);
      return;
    case "CALL_RING":
      useCallStore.getState().ring(ev.d);
      return notifyCall(fx, ev.d);
    case "CALL_UPDATE":
      return useCallStore.getState().update(fx.myId(), ev.d);
    case "CALL_END":
      return useCallStore.getState().end(ev.d.channel_id);

    // ---- voz (Fase 5) ----
    case "VOICE_STATE_UPDATE":
      return reconcileVoiceUpdate(fx.myId(), ev.d);

    // ---- não lidas e menções (Fase 6) ----
    case "READ_STATE_UPDATE":
      // Outra sessão (ou esta) acusou leitura, ou uma menção chegou: o contador de menções vem absoluto.
      if (useReadStateStore.getState().applyUpdate(ev.d)) reloadReadStates();
      return;

    // READY/RESUMED vão pelos callbacks do cliente.
    default:
      return;
  }
}

/** Chamada recebida com a aba oculta: aviso do navegador/SO (o cartão da chamada só aparece à vista). */
function notifyCall(fx: GatewayEffects, call: CallPayload) {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return;
  const who = call.caller?.display_name || call.caller?.username || t("settings.typing.someone");
  fx.notify({
    channelId: `call-${call.channel_id}`,
    title: call.group && call.channel_name ? call.channel_name : who,
    body: call.group
      ? t("settings.notify.groupCalling", { name: who })
      : t("settings.notify.voiceCall"),
    url: channelUrl(undefined, call.channel_id),
    mention: false,
  });
}

/**
 * Havia um GET do histórico em andamento (carga inicial ou refeita pelo READY): a resposta pode ter
 * sido gerada antes deste evento e sobrescreveria o cache sem ele. Refaz o GET para não perder o evento.
 */
function refetchIfLoading(qc: QueryClient, channelId: string) {
  const key = queryKeys.messages(channelId);
  if (qc.isFetching({ queryKey: key }) > 0) void qc.invalidateQueries({ queryKey: key });
}

/** Mensagem numa DM: a conversa sobe na lista. */
function onDmMessage(qc: QueryClient, channelId: string, messageId: string) {
  if (!findDm(qc, channelId)) return;
  bumpDM(qc, channelId, messageId);
}

/**
 * Mensagem de outra pessoa: conta como não lida se o canal não está à vista (o servidor já não conta as
 * minhas) e, sendo DM ou menção direta, avisa. A contagem de menções chega pelo READ_STATE_UPDATE.
 */
function onIncomingMessage(qc: QueryClient, fx: GatewayEffects, m: MessagePayload) {
  const myId = fx.myId();
  if (!myId || m.author.id === myId) return;
  // Mensagem de sistema ("fulano entrou"): não conta como não lida nem avisa.
  if (m.kind === "member_join") return;
  const guild = guildsOf(qc)?.find((g) => g.channels?.some((c) => c.id === m.channel_id));
  const dm = guild ? undefined : findDm(qc, m.channel_id);
  if (!guild && !dm) return; // canal desconhecido (o CHANNEL_CREATE ainda não chegou)

  const viewing = fx.viewing(m.channel_id);
  const reads = useReadStateStore.getState();
  if (viewing === "caught-up") reads.noteSeen(m.channel_id, guild?.id, m.id);
  else reads.addUnread(m.channel_id, guild?.id, m.id);

  const eff = effective(useNotificationSettings.getState().entries, {
    guildId: guild?.id,
    channelId: m.channel_id,
  });
  if (
    !shouldNotify({
      authorId: m.author.id,
      myId,
      isDm: !!dm,
      mentionIds: m.mention_ids ?? [],
      bulkMention: bulkMentionsMe(m, myId, {
        myRoleIds: guild?.my_role_ids ?? [],
        suppressEveryone:
          useNotificationSettings.getState().entries[`guild:${guild?.id}`]?.suppress_everyone ??
          false,
      }),
      viewing,
      muted: useNotificationPrefs.getState().muted || eff.muted,
      level: eff.level,
      dnd: isDnd(),
    })
  )
    return;
  const author = m.author.display_name || m.author.username;
  const channelName = guild?.channels?.find((c) => c.id === m.channel_id)?.name;
  fx.notify({
    channelId: m.channel_id,
    title: guild
      ? t("settings.notify.guildTitle", {
          author,
          channel: channelName ?? "",
          guild: guild.name,
        })
      : author,
    body: previewBody(m),
    url: channelUrl(guild?.id, m.channel_id),
    mention: !dm,
  });
}

/** CHANNEL_DELETE de DM: saí do grupo ou fui removido. */
function leaveDm(qc: QueryClient, fx: GatewayEffects, ch: ChannelPayload) {
  const known = findDm(qc, ch.id);
  removeDM(qc, ch.id);
  qc.removeQueries({ queryKey: queryKeys.messages(ch.id) });
  useReadStateStore.getState().removeChannel(ch.id);
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
  useReadStateStore.getState().removeGuild(guildId);
  if (fx.location().guildId === guildId) fx.leftGuild(guild.name);
}
