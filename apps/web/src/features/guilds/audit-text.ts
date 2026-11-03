import type { AuditEntryPayload } from "@spook/shared";
import { formatList, type MessageKey, type TFunction } from "@/i18n";

/** Ações do registro de auditoria (iguais às do servidor) com a chave do texto do filtro. */
export const AUDIT_ACTIONS: { value: string; labelKey: MessageKey }[] = [
  { value: "channel.create", labelKey: "guilds.audit.action.channel.create" },
  { value: "channel.update", labelKey: "guilds.audit.action.channel.update" },
  { value: "channel.delete", labelKey: "guilds.audit.action.channel.delete" },
  { value: "channel.overwrite_update", labelKey: "guilds.audit.action.channel.overwrite_update" },
  { value: "channel.overwrite_delete", labelKey: "guilds.audit.action.channel.overwrite_delete" },
  { value: "role.create", labelKey: "guilds.audit.action.role.create" },
  { value: "role.update", labelKey: "guilds.audit.action.role.update" },
  { value: "role.delete", labelKey: "guilds.audit.action.role.delete" },
  { value: "member.role_add", labelKey: "guilds.audit.action.member.role_add" },
  { value: "member.role_remove", labelKey: "guilds.audit.action.member.role_remove" },
  { value: "member.kick", labelKey: "guilds.audit.action.member.kick" },
  { value: "member.ban", labelKey: "guilds.audit.action.member.ban" },
  { value: "member.unban", labelKey: "guilds.audit.action.member.unban" },
  { value: "member.nick_update", labelKey: "guilds.audit.action.member.nick_update" },
  { value: "voice.mute", labelKey: "guilds.audit.action.voice.mute" },
  { value: "voice.unmute", labelKey: "guilds.audit.action.voice.unmute" },
  { value: "voice.disconnect", labelKey: "guilds.audit.action.voice.disconnect" },
  { value: "invite.create", labelKey: "guilds.audit.action.invite.create" },
  { value: "invite.revoke", labelKey: "guilds.audit.action.invite.revoke" },
  { value: "guild.update", labelKey: "guilds.audit.action.guild.update" },
  { value: "guild.transfer", labelKey: "guilds.audit.action.guild.transfer" },
];

type Changes = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const quoted = (v: unknown) => (text(v) ? `“${text(v)}”` : "");
const change = (c: Changes, key: string): { from: unknown; to: unknown } | undefined => {
  const v = c[key];
  return v && typeof v === "object" && "to" in v
    ? (v as { from: unknown; to: unknown })
    : undefined;
};

function channelKind(c: Changes, t: TFunction): string {
  const type = Number(c.type);
  return t(
    type === 1
      ? "guilds.audit.s.channelVoice"
      : type === 2
        ? "guilds.audit.s.channelCategory"
        : "guilds.audit.s.channelText",
  );
}

/**
 * Frase da ação sem o autor ("criou o canal “geral”"). Sempre devolve algo legível, mesmo para ações que o
 * cliente ainda não conhece (mostra o código da ação). `t` vem do hook do componente para a frase acompanhar
 * a troca de idioma.
 */
export function auditSentence(e: AuditEntryPayload, t: TFunction): string {
  const c = (e.changes ?? {}) as Changes;
  const target = quoted(c.target_name);
  const s = (key: MessageKey, extra: Record<string, string> = {}) => t(key, { target, ...extra });
  const renamed = (name: { from: unknown; to: unknown }) =>
    s("guilds.audit.s.renamed", { from: quoted(name.from), to: quoted(name.to) });
  switch (e.action) {
    case "channel.create":
      return s("guilds.audit.s.channelCreate", { kind: channelKind(c, t) }).trim();
    case "channel.update": {
      const name = change(c, "name");
      const parts: string[] = [];
      if (name) parts.push(renamed(name));
      if (change(c, "position")) parts.push(s("guilds.audit.s.moved"));
      return parts.length ? formatList(parts) : s("guilds.audit.s.channelEdited");
    }
    case "channel.delete":
      return s("guilds.audit.s.channelDelete", { kind: channelKind(c, t) }).trim();
    case "channel.overwrite_update":
      return s("guilds.audit.s.overwriteUpdate", { who: quoted(c.overwrite_target_name) });
    case "channel.overwrite_delete":
      return s("guilds.audit.s.overwriteDelete", { who: quoted(c.overwrite_target_name) });
    case "role.create":
      return s("guilds.audit.s.roleCreate");
    case "role.update": {
      const name = change(c, "name");
      const bits: string[] = [];
      if (name) bits.push(renamed(name));
      if (change(c, "permissions")) bits.push(s("guilds.audit.s.rolePerms"));
      if (change(c, "position")) bits.push(s("guilds.audit.s.moved"));
      return bits.length ? formatList(bits) : s("guilds.audit.s.roleEdited");
    }
    case "role.delete":
      return s("guilds.audit.s.roleDelete");
    case "member.role_add":
      return s("guilds.audit.s.roleAdd", { role: quoted(c.role_name) });
    case "member.role_remove":
      return s("guilds.audit.s.roleRemove", { role: quoted(c.role_name) });
    case "member.kick":
      return s("guilds.audit.s.kick");
    case "member.ban":
      return s("guilds.audit.s.ban");
    case "member.unban":
      return s("guilds.audit.s.unban");
    case "member.nick_update": {
      const n = change(c, "nickname");
      if (!n?.to) return s("guilds.audit.s.nickRemoved");
      return n.from
        ? s("guilds.audit.s.nickChangedWas", { from: quoted(n.from) })
        : s("guilds.audit.s.nickChanged");
    }
    case "voice.mute":
      return s("guilds.audit.s.voiceMute");
    case "voice.unmute":
      return s("guilds.audit.s.voiceUnmute");
    case "voice.disconnect":
      return s("guilds.audit.s.voiceDisconnect");
    case "invite.create":
      return s("guilds.audit.s.inviteCreate");
    case "invite.revoke":
      return s("guilds.audit.s.inviteRevoke");
    case "guild.update": {
      const name = change(c, "name");
      const bits: string[] = [];
      if (name)
        bits.push(
          s("guilds.audit.s.guildRenamed", { from: quoted(name.from), to: quoted(name.to) }),
        );
      if (c.icon_changed) bits.push(s("guilds.audit.s.guildIcon"));
      return bits.length ? formatList(bits) : s("guilds.audit.s.guildEdited");
    }
    case "guild.transfer":
      return s("guilds.audit.s.transfer");
    default:
      return e.action;
  }
}
