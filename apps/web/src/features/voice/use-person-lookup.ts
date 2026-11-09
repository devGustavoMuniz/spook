import { useGetMe } from "@spook/shared";
import { useMemo } from "react";
import { useDms } from "@/features/dms/use-dms";
import { memberName, useGuildMembers } from "@/features/members/use-members";
import type { PlanTier } from "@/features/nitro/plans";
import { t } from "@/i18n";

export type PersonInfo = { name: string; avatarUrl?: string; plan?: PlanTier };
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
    if (me)
      map.set(me.id, {
        name: me.display_name || me.username,
        avatarUrl: me.avatar_url,
        plan: me.plan,
      });
    // Inclusive eu: o apelido do servidor vence o nome de exibição.
    for (const m of members.data?.members ?? [])
      map.set(m.user_id, { name: memberName(m), avatarUrl: m.avatar_url, plan: m.plan });
    const dm = scope.dmId ? dms.list.find((c) => c.id === scope.dmId) : undefined;
    for (const r of dm?.recipients ?? [])
      if (r.id !== me?.id)
        map.set(r.id, {
          name: r.display_name || r.username,
          avatarUrl: r.avatar_url,
          plan: r.plan,
        });
    return (id) => map.get(id) ?? { name: t("voice.user") };
  }, [me, members.data, dms.list, scope.dmId]);
}
