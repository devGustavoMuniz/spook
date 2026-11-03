import type { CallPayload, Relationship } from "@spook/shared";

/** Chamada de DM como o gateway envia (padrão: tocando, iniciada por "50"). */
export function callPayload(channelId: string, extra: Partial<CallPayload> = {}): CallPayload {
  return {
    channel_id: channelId,
    state: "ringing",
    started_by: "50",
    started_at: "2026-11-03T12:00:00Z",
    expires_at: new Date(Date.now() + 45_000).toISOString(),
    group: false,
    caller: { id: "50", username: "bia", display_name: "Bia Souza" },
    ...extra,
  };
}

/** Relacionamento como a API devolve. */
export function rel(
  id: string,
  username: string,
  type: Relationship["type"],
  display_name?: string,
): Relationship {
  return {
    user: { id, username, ...(display_name ? { display_name } : {}) },
    type,
    since: "2026-11-03T12:00:00Z",
  };
}
