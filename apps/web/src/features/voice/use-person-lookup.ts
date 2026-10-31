import { useGetMe } from "@spook/shared";
import { useMemo } from "react";
import { useDms } from "@/features/dms/use-dms";
import { memberName, useGuildMembers } from "@/features/members/use-members";

export type PersonInfo = { name: string; avatarUrl?: string };
export type PersonLookup = (userId: string) => PersonInfo;

/**
 * Nome e avatar de quem está em voz. Servidor: lista de membros (só é buscada com `enabled`, isto é,
 * quando há alguém em voz); DM: os participantes da conversa. Desconhecido vira "Usuário".
 */
export function usePersonLookup(
  scope: { guildId: string | null; dmId?: string },
  enabled = true,
): PersonLookup {
  const { data: me } = useGetMe();
  const members = useGuildMembers(scope.guildId ?? "", enabled && !!scope.guildId);
  const dms = useDms();
  return useMemo(() => {
    const map = new Map<string, PersonInfo>();
    if (me) map.set(me.id, { name: me.display_name || me.username, avatarUrl: me.avatar_url });
    for (const m of members.data?.members ?? [])
      if (!map.has(m.user_id) || m.user_id !== me?.id)
        map.set(m.user_id, { name: memberName(m), avatarUrl: m.avatar_url });
    const dm = scope.dmId ? dms.list.find((c) => c.id === scope.dmId) : undefined;
    for (const r of dm?.recipients ?? [])
      if (r.id !== me?.id)
        map.set(r.id, { name: r.display_name || r.username, avatarUrl: r.avatar_url });
    return (id) => map.get(id) ?? { name: "Usuário" };
  }, [me, members.data, dms.list, scope.dmId]);
}
