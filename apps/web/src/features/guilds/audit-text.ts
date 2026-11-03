import type { AuditEntryPayload } from "@spook/shared";

/** Ações do registro de auditoria (iguais às do servidor) com o texto do filtro. */
export const AUDIT_ACTIONS: { value: string; label: string }[] = [
  { value: "channel.create", label: "Canal criado" },
  { value: "channel.update", label: "Canal editado" },
  { value: "channel.delete", label: "Canal excluído" },
  { value: "channel.overwrite_update", label: "Permissões de canal alteradas" },
  { value: "channel.overwrite_delete", label: "Permissões de canal removidas" },
  { value: "role.create", label: "Cargo criado" },
  { value: "role.update", label: "Cargo editado" },
  { value: "role.delete", label: "Cargo excluído" },
  { value: "member.role_add", label: "Cargo atribuído" },
  { value: "member.role_remove", label: "Cargo removido de membro" },
  { value: "member.kick", label: "Membro expulso" },
  { value: "member.ban", label: "Membro banido" },
  { value: "member.unban", label: "Banimento desfeito" },
  { value: "member.nick_update", label: "Apelido alterado" },
  { value: "voice.mute", label: "Mutado na voz" },
  { value: "voice.unmute", label: "Mute de voz removido" },
  { value: "voice.disconnect", label: "Desconectado da voz" },
  { value: "invite.create", label: "Convite criado" },
  { value: "invite.revoke", label: "Convite revogado" },
  { value: "guild.update", label: "Servidor alterado" },
  { value: "guild.transfer", label: "Posse transferida" },
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

function channelKind(c: Changes): string {
  const t = Number(c.type);
  return t === 1 ? "o canal de voz" : t === 2 ? "a categoria" : "o canal";
}

/**
 * Frase da ação sem o autor ("criou o canal “geral”"). Sempre devolve algo legível, mesmo para ações que o
 * cliente ainda não conhece (mostra o código da ação).
 */
export function auditSentence(e: AuditEntryPayload): string {
  const c = (e.changes ?? {}) as Changes;
  const target = quoted(c.target_name);
  switch (e.action) {
    case "channel.create":
      return `criou ${channelKind(c)} ${target}`.trim();
    case "channel.update": {
      const name = change(c, "name");
      const parts: string[] = [];
      if (name) parts.push(`renomeou ${quoted(name.from)} para ${quoted(name.to)}`);
      if (change(c, "position")) parts.push(`mudou a posição de ${target}`);
      return parts.length ? parts.join(" e ") : `editou o canal ${target}`;
    }
    case "channel.delete":
      return `excluiu ${channelKind(c)} ${target}`.trim();
    case "channel.overwrite_update":
      return `alterou as permissões de ${quoted(c.overwrite_target_name)} no canal ${target}`;
    case "channel.overwrite_delete":
      return `removeu as permissões de ${quoted(c.overwrite_target_name)} no canal ${target}`;
    case "role.create":
      return `criou o cargo ${target}`;
    case "role.update": {
      const name = change(c, "name");
      const bits: string[] = [];
      if (name) bits.push(`renomeou ${quoted(name.from)} para ${quoted(name.to)}`);
      if (change(c, "permissions")) bits.push(`mudou as permissões de ${target}`);
      if (change(c, "position")) bits.push(`mudou a posição de ${target}`);
      return bits.length ? bits.join(" e ") : `editou o cargo ${target}`;
    }
    case "role.delete":
      return `excluiu o cargo ${target}`;
    case "member.role_add":
      return `deu o cargo ${quoted(c.role_name)} a ${target}`;
    case "member.role_remove":
      return `tirou o cargo ${quoted(c.role_name)} de ${target}`;
    case "member.kick":
      return `expulsou ${target}`;
    case "member.ban":
      return `baniu ${target}`;
    case "member.unban":
      return `desbaniu ${target}`;
    case "member.nick_update": {
      const n = change(c, "nickname");
      return n?.to
        ? `mudou o apelido de ${target}${n.from ? ` (era ${quoted(n.from)})` : ""}`
        : `removeu o apelido de ${target}`;
    }
    case "voice.mute":
      return `mutou ${target} na voz`;
    case "voice.unmute":
      return `liberou o mute de voz de ${target}`;
    case "voice.disconnect":
      return `desconectou ${target} da voz`;
    case "invite.create":
      return `criou o convite ${target}`;
    case "invite.revoke":
      return `revogou o convite ${target}`;
    case "guild.update": {
      const name = change(c, "name");
      const bits: string[] = [];
      if (name) bits.push(`renomeou o servidor de ${quoted(name.from)} para ${quoted(name.to)}`);
      if (c.icon_changed) bits.push("trocou o ícone do servidor");
      return bits.length ? bits.join(" e ") : "alterou o servidor";
    }
    case "guild.transfer":
      return `transferiu a posse do servidor para ${target}`;
    default:
      return e.action;
  }
}
