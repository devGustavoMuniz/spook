import { useListGuilds } from "@spook/shared";

/** A lista de servidores (com canais, cargos e permissões) é a fonte de verdade; um servidor é um item dela. */
export function useGuild(guildId: string) {
  const q = useListGuilds();
  return { ...q, guild: q.data?.find((g) => g.id === guildId) };
}
