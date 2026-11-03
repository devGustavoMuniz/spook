import {
  type ChannelPayload,
  type DetailPayload,
  hasPermission,
  type MemberPayload,
  Permission,
  type PermissionFlag,
  type RolePayload,
} from "@spook/shared";
import { colorToHex } from "@/lib/colors";

export const CHANNEL_TEXT = 0;
export const CHANNEL_VOICE = 1;
export const CHANNEL_CATEGORY = 2;

export type Guild = DetailPayload;

export const rolesOf = (g: Guild): RolePayload[] => g.roles ?? [];
export const channelsOf = (g: Guild): ChannelPayload[] => g.channels ?? [];

export function can(g: Guild, flag: PermissionFlag): boolean {
  return hasPermission(g.permissions, flag, { isOwner: g.is_owner });
}

/** Posição do meu cargo mais alto; o dono vale "infinito" (SPEC 5.5). */
export function myTopPosition(g: Guild): number {
  if (g.is_owner) return Number.POSITIVE_INFINITY;
  return topPosition(g, g.my_role_ids ?? []);
}

export function topPosition(g: Guild, roleIds: readonly string[]): number {
  const mine = new Set(roleIds);
  return rolesOf(g).reduce((max, r) => (mine.has(r.id) ? Math.max(max, r.position) : max), 0);
}

/** Espelha a hierarquia do servidor: só se gerencia cargo estritamente abaixo do meu mais alto. */
export function canManageRole(g: Guild, role: RolePayload): boolean {
  return can(g, Permission.MANAGE_ROLES) && role.position < myTopPosition(g);
}

/**
 * Espelha a hierarquia da moderação do servidor: precisa da permissão, o alvo não pode ser o dono nem eu, e o
 * cargo mais alto dele tem de ser estritamente menor que o meu (administrador NÃO ignora a hierarquia).
 */
export function canModerate(
  g: Guild,
  flag: PermissionFlag,
  target: Pick<MemberPayload, "user_id" | "role_ids">,
  myId: string,
): boolean {
  if (!can(g, flag)) return false;
  if (target.user_id === myId || target.user_id === g.owner_id) return false;
  return topPosition(g, target.role_ids ?? []) < myTopPosition(g);
}

export const canKick = (g: Guild, target: MemberPayload, myId: string) =>
  canModerate(g, Permission.KICK_MEMBERS, target, myId);

export const canBan = (g: Guild, target: MemberPayload, myId: string) =>
  canModerate(g, Permission.BAN_MEMBERS, target, myId);

/** Apelido: o meu com CHANGE_NICKNAME (ou MANAGE_NICKNAMES); o de outro com MANAGE_NICKNAMES + hierarquia. */
export function canNickname(g: Guild, target: MemberPayload, myId: string): boolean {
  if (target.user_id === myId)
    return can(g, Permission.CHANGE_NICKNAME) || can(g, Permission.MANAGE_NICKNAMES);
  return canModerate(g, Permission.MANAGE_NICKNAMES, target, myId);
}

/** Cor do cargo mais alto (que tenha cor) do membro, como "#rrggbb". */
export function memberColor(g: Guild, member: MemberPayload): string | undefined {
  const ids = new Set(member.role_ids ?? []);
  for (const r of rolesOf(g)) if (ids.has(r.id) && r.color !== null) return colorToHex(r.color);
  return undefined;
}

export type ChannelGroups = {
  loose: ChannelPayload[];
  categories: { category: ChannelPayload; children: ChannelPayload[] }[];
};

/** Canais sem categoria no topo; depois cada categoria com seus filhos (tudo já por posição). */
export function groupChannels(g: Guild): ChannelGroups {
  const all = channelsOf(g);
  const cats = all.filter((c) => c.type === CHANNEL_CATEGORY);
  const ids = new Set(cats.map((c) => c.id));
  return {
    loose: all.filter(
      (c) => c.type !== CHANNEL_CATEGORY && (!c.parent_id || !ids.has(c.parent_id)),
    ),
    categories: cats.map((category) => ({
      category,
      children: all.filter((c) => c.parent_id === category.id),
    })),
  };
}

/**
 * Move um canal (ou categoria) uma posição para cima/baixo entre os irmãos e devolve a lista inteira
 * de posições renumerada de 0..n (mais simples e à prova de empates do que trocar dois valores).
 */
export function moveChannel(
  g: Guild,
  channelId: string,
  dir: -1 | 1,
): { id: string; position: number; parent_id: string | null }[] | null {
  const groups = groupChannels(g);
  const moveIn = <T extends { id: string }>(list: T[]): T[] | null => {
    const i = list.findIndex((c) => c.id === channelId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return null;
    const next = [...list];
    const a = next[i] as T;
    next[i] = next[j] as T;
    next[j] = a;
    return next;
  };

  let loose = groups.loose;
  let categories = groups.categories;
  const movedLoose = moveIn(loose);
  if (movedLoose) loose = movedLoose;
  else {
    const movedCats = moveIn(categories.map((c) => ({ id: c.category.id, c })));
    if (movedCats) categories = movedCats.map((x) => x.c);
    else {
      let done = false;
      categories = categories.map((c) => {
        const moved = moveIn(c.children);
        if (!moved) return c;
        done = true;
        return { ...c, children: moved };
      });
      if (!done) return null;
    }
  }

  const out: { id: string; position: number; parent_id: string | null }[] = [];
  let pos = 0;
  for (const c of loose) out.push({ id: c.id, position: pos++, parent_id: null });
  for (const { category, children } of categories) {
    out.push({ id: category.id, position: pos++, parent_id: null });
    for (const c of children) out.push({ id: c.id, position: pos++, parent_id: category.id });
  }
  return out;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? parts.slice(0, 2).map((p) => p[0]) : [...name.trim()].slice(0, 2);
  return letters.join("").toUpperCase();
}
