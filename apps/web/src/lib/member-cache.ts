import type { MemberListOutputBody, MemberPayload } from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

function update(
  qc: QueryClient,
  guildId: string,
  fn: (members: MemberPayload[]) => MemberPayload[],
) {
  qc.setQueriesData<MemberListOutputBody>({ queryKey: queryKeys.members(guildId) }, (old) =>
    old ? { ...old, members: fn(old.members ?? []) } : old,
  );
}

/** Membro novo ou alterado (apelido, cargos); só mexe na lista se ela já foi carregada. */
export function upsertMember(qc: QueryClient, m: MemberPayload) {
  update(qc, m.guild_id, (list) =>
    list.some((x) => x.user_id === m.user_id)
      ? list.map((x) => (x.user_id === m.user_id ? m : x))
      : [...list, m],
  );
}

export function removeMember(qc: QueryClient, guildId: string, userId: string) {
  update(qc, guildId, (list) => list.filter((x) => x.user_id !== userId));
}

/** Cargo excluído: tira o id dos membros que o tinham. */
export function dropRoleFromMembers(qc: QueryClient, guildId: string, roleId: string) {
  update(qc, guildId, (list) =>
    list.map((m) =>
      m.role_ids?.includes(roleId) ? { ...m, role_ids: m.role_ids.filter((r) => r !== roleId) } : m,
    ),
  );
}
