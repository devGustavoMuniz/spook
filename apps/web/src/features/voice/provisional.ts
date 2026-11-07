import type { VoiceStatePayload } from "@spook/shared";

/**
 * Quem está no canal, com um item PROVISÓRIO meu enquanto o servidor ainda não confirmou a entrada (o voice state
 * vem do webhook do LiveKit): quem clica em "entrar" se vê na hora, no palco e na lista do canal, sem esperar a rede.
 * Quando o estado real chega ele substitui o provisório (mesmo `user_id`). Sem `active`/`meId`, devolve a lista como está.
 */
export function withProvisionalSelf(
  list: VoiceStatePayload[],
  opts: {
    meId: string | undefined;
    channelId: string;
    guildId: string | null;
    active: boolean;
    /** Intenção local de mudo/surdo (o provisório já nasce coerente com ela). */
    selfMute?: boolean;
    selfDeaf?: boolean;
  },
): VoiceStatePayload[] {
  const { meId, channelId, guildId, active } = opts;
  if (!active || !meId || list.some((p) => p.user_id === meId)) return list;
  const mine: VoiceStatePayload = {
    guild_id: guildId,
    channel_id: channelId,
    user_id: meId,
    self_mute: opts.selfMute ?? false,
    self_deaf: opts.selfDeaf ?? false,
    self_video: false,
    self_screen: false,
    screen_preview: false,
  };
  return [mine, ...list];
}
