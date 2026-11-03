import { Permission, type PermissionName } from "@spook/shared";

/** Permissões que um canal pode permitir ou negar, na ordem em que aparecem no editor. */
export const CHANNEL_PERMISSIONS: { name: PermissionName; label: string; description: string }[] = [
  {
    name: "VIEW_CHANNEL",
    label: "Ver o canal",
    description: "Sem isso o canal some para a pessoa.",
  },
  { name: "SEND_MESSAGES", label: "Enviar mensagens", description: "Escrever neste canal." },
  { name: "ATTACH_FILES", label: "Anexar arquivos", description: "Enviar imagens e arquivos." },
  {
    name: "MANAGE_MESSAGES",
    label: "Gerenciar mensagens",
    description: "Excluir e fixar as de outros.",
  },
  { name: "CONNECT", label: "Conectar à voz", description: "Entrar neste canal de voz." },
  { name: "SPEAK", label: "Falar", description: "Usar o microfone na chamada." },
  { name: "VIDEO", label: "Vídeo", description: "Câmera e compartilhamento de tela." },
];

/** Só as que fazem sentido para o tipo do canal (texto não tem voz; voz não tem mensagens). */
export function permissionsForChannel(type: number): typeof CHANNEL_PERMISSIONS {
  const voice = new Set<PermissionName>(["CONNECT", "SPEAK", "VIDEO"]);
  const text = new Set<PermissionName>(["SEND_MESSAGES", "ATTACH_FILES", "MANAGE_MESSAGES"]);
  return CHANNEL_PERMISSIONS.filter((p) => {
    if (type === 1) return !text.has(p.name);
    if (type === 0) return !voice.has(p.name);
    return true;
  });
}

export type TargetType = "role" | "member";
export type Tri = "allow" | "deny" | "inherit";

export type Overwrite = { type: TargetType; id: string; allow: number; deny: number };

export const keyOf = (o: Pick<Overwrite, "type" | "id">) => `${o.type}:${o.id}`;

export function triOf(o: Pick<Overwrite, "allow" | "deny">, name: PermissionName): Tri {
  const bit = Permission[name];
  if ((o.allow & bit) === bit) return "allow";
  if ((o.deny & bit) === bit) return "deny";
  return "inherit";
}

export function withTri(o: Overwrite, name: PermissionName, to: Tri): Overwrite {
  const bit = Permission[name];
  const allow = to === "allow" ? o.allow | bit : o.allow & ~bit;
  const deny = to === "deny" ? o.deny | bit : o.deny & ~bit;
  return { ...o, allow, deny };
}

export const isEmpty = (o: Pick<Overwrite, "allow" | "deny">) => o.allow === 0 && o.deny === 0;

type Draft = ReadonlyMap<string, Overwrite>;

export function toDraft(list: readonly Overwrite[]): Map<string, Overwrite> {
  return new Map(list.map((o) => [keyOf(o), o]));
}

/** Canal privado = o @everyone (cargo de ID igual ao do servidor) não vê o canal. */
export function isPrivate(draft: Draft, guildId: string): boolean {
  const o = draft.get(keyOf({ type: "role", id: guildId }));
  return !!o && (o.deny & Permission.VIEW_CHANNEL) !== 0;
}

export function setPrivate(draft: Draft, guildId: string, on: boolean): Map<string, Overwrite> {
  const next = new Map(draft);
  const key = keyOf({ type: "role", id: guildId });
  const cur = next.get(key) ?? { type: "role" as const, id: guildId, allow: 0, deny: 0 };
  next.set(key, withTri(cur, "VIEW_CHANNEL", on ? "deny" : "inherit"));
  return next;
}

/** Quem tem o ver-canal liberado (allow VIEW_CHANNEL), exceto o @everyone: quem "entra" num canal privado. */
export function allowedViewers(draft: Draft, guildId: string): Overwrite[] {
  return [...draft.values()].filter(
    (o) => !(o.type === "role" && o.id === guildId) && (o.allow & Permission.VIEW_CHANNEL) !== 0,
  );
}

/** O que mudou entre o original e o rascunho: o que gravar (permitir/negar vazios removem no servidor). */
export function changes(original: readonly Overwrite[], draft: Draft): Overwrite[] {
  const before = toDraft(original);
  const out: Overwrite[] = [];
  for (const [k, o] of draft) {
    const b = before.get(k);
    if (!b ? !isEmpty(o) : b.allow !== o.allow || b.deny !== o.deny) out.push(o);
  }
  for (const [k, b] of before) if (!draft.has(k)) out.push({ ...b, allow: 0, deny: 0 });
  return out;
}
