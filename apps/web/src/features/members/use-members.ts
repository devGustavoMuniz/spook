import { type MemberPayload, useListGuildMembers } from "@spook/shared";
import { useMemo } from "react";
import { shownName } from "@/features/account/removed-user";
import { type Guild, memberColor } from "@/lib/guild";

const MEMBERS_LIMIT = 1000;

export function useGuildMembers(guildId: string, enabled = true) {
  return useListGuildMembers(guildId, { limit: MEMBERS_LIMIT }, { query: { enabled } });
}

export const memberName = (m: MemberPayload) => shownName(m.nickname || m.display_name, m.username);

/** user_id → cor do cargo mais alto; usada para colorir autores das mensagens e a lista de membros. */
export function useMemberColors(guild: Guild | undefined): ReadonlyMap<string, string> {
  const { data } = useGuildMembers(guild?.id ?? "", !!guild);
  return useMemo(() => {
    const map = new Map<string, string>();
    if (!guild) return map;
    for (const m of data?.members ?? []) {
      const c = memberColor(guild, m);
      if (c) map.set(m.user_id, c);
    }
    return map;
  }, [data, guild]);
}
