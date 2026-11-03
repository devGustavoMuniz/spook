import {
  type ChannelPayload,
  type DetailPayload,
  type MemberPayload,
  type MessagePayload,
  Permission,
  type RolePayload,
} from "@spook/shared";

export const ME = "1"; // id do usuário de sampleUser

const base = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.CREATE_INVITE;

export function role(id: string, name: string, position: number, extra: Partial<RolePayload> = {}) {
  return {
    id,
    guild_id: "g",
    name,
    position,
    color: null,
    permissions: 0,
    is_everyone: false,
    mentionable: false,
    ...extra,
  } satisfies RolePayload;
}

export function channel(
  id: string,
  name: string,
  position: number,
  type = 0,
  parent_id: string | null = null,
): ChannelPayload {
  return {
    id,
    name,
    position,
    type,
    parent_id,
    guild_id: "g",
    last_message_id: null,
    created_at: "2026-10-30T12:00:00Z",
    topic: null,
  };
}

/** Servidor completo como a API devolve (GET /guilds). */
export function guild(id: string, name: string, extra: Partial<DetailPayload> = {}): DetailPayload {
  return {
    id,
    name,
    icon_key: null,
    owner_id: "999",
    is_owner: false,
    my_role_ids: [],
    permissions: base,
    created_at: "2026-10-30T12:00:00Z",
    system_channel_id: null,
    system_join_enabled: true,
    roles: [role(id, "@everyone", 0, { is_everyone: true, permissions: base })],
    channels: [
      channel(`${id}-cat`, "Canais", 0, 2),
      channel(`${id}-txt`, "geral", 1, 0, `${id}-cat`),
      channel(`${id}-voz`, "Geral", 2, 1, `${id}-cat`),
    ],
    ...extra,
  };
}

export function member(userId: string, username: string, roleIds: string[] = []): MemberPayload {
  return {
    user_id: userId,
    guild_id: "g",
    username,
    nickname: null,
    role_ids: roleIds,
    joined_at: "2026-10-30T12:00:00Z",
  };
}

/** n mensagens (ids crescentes a partir de `from`), uma por minuto, da mais antiga à mais nova. */
export function messages(
  channelId: string,
  n: number,
  from = 1000,
  authorId = "50",
): MessagePayload[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(from + i),
    channel_id: channelId,
    author: { id: authorId, username: authorId === ME ? "ana" : "bia" },
    content: `mensagem ${from + i}`,
    created_at: new Date(Date.UTC(2026, 9, 30, 12, 0, 0) + i * 60_000).toISOString(),
    edited_at: null,
    attachments: [],
    mention_ids: [],
    kind: "default",
    mention_everyone: false,
    mention_here: false,
    mention_roles: [],
    reply_to: null,
    pinned: false,
  }));
}

/** Participante de DM (formato do `ChannelPayload.recipients`). */
export function recipient(id: string, username: string, display_name?: string) {
  return { id, username, ...(display_name ? { display_name } : {}) };
}

/** DM 1:1 (tipo 3, `name` vazio) ou em grupo (tipo 4, com `owner_id`), como a API devolve. */
export function dm(
  id: string,
  recipients: ReturnType<typeof recipient>[],
  extra: Partial<ChannelPayload> = {},
): ChannelPayload {
  return {
    id,
    type: 3,
    guild_id: null,
    parent_id: null,
    name: "",
    position: 0,
    last_message_id: null,
    created_at: "2026-10-30T12:00:00Z",
    topic: null,
    recipients,
    ...extra,
  };
}
