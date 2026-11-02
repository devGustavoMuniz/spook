import type { MemberPayload } from "@spook/shared";
import type { DisplayStatus } from "@/features/presence/store";
import { type Guild, rolesOf } from "@/lib/guild";
import { memberName } from "./use-members";

export type MemberGroup = {
  key: string;
  /** "Moderadores", "Online" ou "Offline". */
  title: string;
  /** Só nos grupos de cargo: o cargo (para a cor do marcador). */
  roleId?: string;
  members: MemberPayload[];
  offline: boolean;
};

const isOnline = (s: DisplayStatus) => s !== "offline" && s !== "invisible";

/** Cargo mais alto (maior posição) do membro, ignorando @everyone. */
export function topRole(guild: Guild, member: MemberPayload) {
  const ids = new Set(member.role_ids ?? []);
  let best: ReturnType<typeof rolesOf>[number] | undefined;
  for (const r of rolesOf(guild)) {
    if (r.is_everyone || !ids.has(r.id)) continue;
    if (!best || r.position > best.position) best = r;
  }
  return best;
}

/**
 * Grupos da lista de membros: cada cargo (maior posição primeiro) com quem está online e tem esse cargo
 * como o mais alto; depois "Online" (sem cargo) e "Offline" (todo mundo que não está conectado).
 * Grupos vazios não aparecem. Dentro do grupo, ordem alfabética.
 */
export function groupMembers(
  guild: Guild,
  members: readonly MemberPayload[],
  statusOf: (userId: string) => DisplayStatus,
): MemberGroup[] {
  const byRole = new Map<string, MemberPayload[]>();
  const online: MemberPayload[] = [];
  const offline: MemberPayload[] = [];
  for (const m of members) {
    if (!isOnline(statusOf(m.user_id))) {
      offline.push(m);
      continue;
    }
    const role = topRole(guild, m);
    if (!role) online.push(m);
    else byRole.set(role.id, [...(byRole.get(role.id) ?? []), m]);
  }
  const sort = (list: MemberPayload[]) =>
    [...list].sort((a, b) => memberName(a).localeCompare(memberName(b), "pt-BR"));
  const groups: MemberGroup[] = [];
  const roles = rolesOf(guild)
    .filter((r) => !r.is_everyone && byRole.has(r.id))
    .sort((a, b) => b.position - a.position);
  for (const r of roles)
    groups.push({
      key: `role:${r.id}`,
      title: r.name,
      roleId: r.id,
      members: sort(byRole.get(r.id) ?? []),
      offline: false,
    });
  if (online.length)
    groups.push({ key: "online", title: "Online", members: sort(online), offline: false });
  if (offline.length)
    groups.push({ key: "offline", title: "Offline", members: sort(offline), offline: true });
  return groups;
}
