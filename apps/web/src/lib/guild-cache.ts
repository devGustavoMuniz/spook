import type { ChannelPayload, DetailPayload, GuildPayload, RolePayload } from "@spook/shared";
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

function updateGuild(qc: QueryClient, guildId: string, fn: (g: DetailPayload) => DetailPayload) {
  qc.setQueryData<DetailPayload[] | null>(queryKeys.guilds(), (old) =>
    old ? old.map((g) => (g.id === guildId ? fn(g) : g)) : old,
  );
}

/** Desempate por id (Snowflake: numérico e crescente com o tempo; ids não numéricos só nos testes). */
function idOrder(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

/** Substitui a lista inteira (READY): é o estado do servidor no momento do identify. */
export function setGuilds(qc: QueryClient, guilds: DetailPayload[]) {
  qc.setQueryData<DetailPayload[] | null>(queryKeys.guilds(), guilds);
}

/** Dados básicos do servidor (nome, ícone, dono) sem mexer em canais, cargos e permissões. */
export function patchGuild(qc: QueryClient, g: GuildPayload) {
  updateGuild(qc, g.id, (old) => ({
    ...old,
    name: g.name,
    icon_key: g.icon_key,
    owner_id: g.owner_id,
    icon_url: g.icon_url ?? (g.icon_key === old.icon_key ? old.icon_url : undefined),
  }));
}

/** Canal novo ou alterado; a lista fica por posição (como o servidor devolve). */
export function upsertChannel(qc: QueryClient, ch: ChannelPayload) {
  if (!ch.guild_id) return;
  updateGuild(qc, ch.guild_id, (g) => ({
    ...g,
    channels: [...(g.channels ?? []).filter((c) => c.id !== ch.id), ch].sort(
      (a, b) => a.position - b.position || idOrder(a.id, b.id),
    ),
  }));
}

export function removeChannel(qc: QueryClient, guildId: string, channelId: string) {
  updateGuild(qc, guildId, (g) => ({
    ...g,
    // excluir uma categoria solta os filhos no servidor (que emite CHANNEL_UPDATE para cada um)
    channels: (g.channels ?? []).filter((c) => c.id !== channelId),
  }));
}

/** Cargo novo ou alterado; a lista fica do mais alto para o mais baixo. */
export function upsertRole(qc: QueryClient, role: RolePayload) {
  updateGuild(qc, role.guild_id, (g) => ({
    ...g,
    roles: [...(g.roles ?? []).filter((r) => r.id !== role.id), role].sort(
      (a, b) => b.position - a.position || idOrder(a.id, b.id),
    ),
  }));
}

export function removeRole(qc: QueryClient, guildId: string, roleId: string) {
  updateGuild(qc, guildId, (g) => ({
    ...g,
    roles: (g.roles ?? []).filter((r) => r.id !== roleId),
    my_role_ids: (g.my_role_ids ?? []).filter((id) => id !== roleId),
  }));
}
