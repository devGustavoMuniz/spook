import type { DetailPayload } from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

/** Servidor novo (criado ou aceito por convite) entra no fim da lista, sem esperar um refetch. */
export function appendGuild(qc: QueryClient, guild: DetailPayload) {
  qc.setQueryData<DetailPayload[] | null>(queryKeys.guilds(), (old) => [
    ...(old ?? []).filter((g) => g.id !== guild.id),
    guild,
  ]);
}

export function removeGuild(qc: QueryClient, guildId: string) {
  qc.setQueryData<DetailPayload[] | null>(queryKeys.guilds(), (old) =>
    (old ?? []).filter((g) => g.id !== guildId),
  );
  qc.removeQueries({ queryKey: queryKeys.members(guildId) });
}

/** Servidor/canais/cargos/permissões mudaram: refaz a lista (fonte de verdade da barra lateral). */
export function refreshGuilds(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: queryKeys.guilds() });
}
