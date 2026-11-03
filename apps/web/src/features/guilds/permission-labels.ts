import { Permission, type PermissionName } from "@spook/shared";
import type { MessageKey } from "@/i18n";

/** Chaves do catálogo (guilds.ts): o texto nunca fica no módulo, para trocar de idioma ao vivo. */
export type PermissionInfo = { name: PermissionName; labelKey: MessageKey; descKey: MessageKey };
export type PermissionGroup = { id: string; titleKey: MessageKey; items: PermissionInfo[] };

/** Permissões agrupadas para a tela de cargos (as flags são as do SPEC 7; só muda a apresentação). */
export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: "general",
    titleKey: "guilds.perm.group.general",
    items: [
      {
        name: "ADMINISTRATOR",
        labelKey: "guilds.perm.ADMINISTRATOR.label",
        descKey: "guilds.perm.ADMINISTRATOR.desc",
      },
      {
        name: "VIEW_CHANNEL",
        labelKey: "guilds.perm.VIEW_CHANNEL.label",
        descKey: "guilds.perm.VIEW_CHANNEL.desc",
      },
      {
        name: "MANAGE_GUILD",
        labelKey: "guilds.perm.MANAGE_GUILD.label",
        descKey: "guilds.perm.MANAGE_GUILD.desc",
      },
      {
        name: "MANAGE_CHANNELS",
        labelKey: "guilds.perm.MANAGE_CHANNELS.label",
        descKey: "guilds.perm.MANAGE_CHANNELS.desc",
      },
      {
        name: "MANAGE_ROLES",
        labelKey: "guilds.perm.MANAGE_ROLES.label",
        descKey: "guilds.perm.MANAGE_ROLES.desc",
      },
      {
        name: "CREATE_INVITE",
        labelKey: "guilds.perm.CREATE_INVITE.label",
        descKey: "guilds.perm.CREATE_INVITE.desc",
      },
      {
        name: "CHANGE_NICKNAME",
        labelKey: "guilds.perm.CHANGE_NICKNAME.label",
        descKey: "guilds.perm.CHANGE_NICKNAME.desc",
      },
    ],
  },
  {
    id: "text",
    titleKey: "guilds.perm.group.text",
    items: [
      {
        name: "SEND_MESSAGES",
        labelKey: "guilds.perm.SEND_MESSAGES.label",
        descKey: "guilds.perm.SEND_MESSAGES.desc",
      },
      {
        name: "ATTACH_FILES",
        labelKey: "guilds.perm.ATTACH_FILES.label",
        descKey: "guilds.perm.ATTACH_FILES.desc",
      },
      {
        name: "MENTION_EVERYONE",
        labelKey: "guilds.perm.MENTION_EVERYONE.label",
        descKey: "guilds.perm.MENTION_EVERYONE.desc",
      },
    ],
  },
  {
    id: "voice",
    titleKey: "guilds.perm.group.voice",
    items: [
      {
        name: "CONNECT",
        labelKey: "guilds.perm.CONNECT.label",
        descKey: "guilds.perm.CONNECT.desc",
      },
      { name: "SPEAK", labelKey: "guilds.perm.SPEAK.label", descKey: "guilds.perm.SPEAK.desc" },
      { name: "VIDEO", labelKey: "guilds.perm.VIDEO.label", descKey: "guilds.perm.VIDEO.desc" },
    ],
  },
  {
    id: "moderation",
    titleKey: "guilds.perm.group.moderation",
    items: [
      {
        name: "KICK_MEMBERS",
        labelKey: "guilds.perm.KICK_MEMBERS.label",
        descKey: "guilds.perm.KICK_MEMBERS.desc",
      },
      {
        name: "MANAGE_MESSAGES",
        labelKey: "guilds.perm.MANAGE_MESSAGES.label",
        descKey: "guilds.perm.MANAGE_MESSAGES.desc",
      },
      {
        name: "BAN_MEMBERS",
        labelKey: "guilds.perm.BAN_MEMBERS.label",
        descKey: "guilds.perm.BAN_MEMBERS.desc",
      },
      {
        name: "MANAGE_NICKNAMES",
        labelKey: "guilds.perm.MANAGE_NICKNAMES.label",
        descKey: "guilds.perm.MANAGE_NICKNAMES.desc",
      },
      {
        name: "MUTE_MEMBERS",
        labelKey: "guilds.perm.MUTE_MEMBERS.label",
        descKey: "guilds.perm.MUTE_MEMBERS.desc",
      },
      {
        name: "DISCONNECT_MEMBERS",
        labelKey: "guilds.perm.DISCONNECT_MEMBERS.label",
        descKey: "guilds.perm.DISCONNECT_MEMBERS.desc",
      },
      {
        name: "VIEW_AUDIT_LOG",
        labelKey: "guilds.perm.VIEW_AUDIT_LOG.label",
        descKey: "guilds.perm.VIEW_AUDIT_LOG.desc",
      },
    ],
  },
];

export const PERMISSION_LABELS: PermissionInfo[] = PERMISSION_GROUPS.flatMap((g) => g.items);

export const flagOf = (name: PermissionName) => Permission[name];
