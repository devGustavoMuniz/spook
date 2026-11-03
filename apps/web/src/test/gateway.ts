import type {
  ChannelPayload,
  DetailPayload,
  ReadStatePayload,
  VoiceStatePayload,
} from "@spook/shared";
import { FakeSocket } from "@spook/shared/testing";
import { act, waitFor } from "@testing-library/react";
import { ME } from "./fixtures";

/** Espera o provider abrir o WebSocket falso e completa HELLO + READY (usuário `ME`). */
export async function connectGateway(
  guilds: DetailPayload[],
  session = "sess-1",
  extra: {
    private_channels?: ChannelPayload[];
    presences?: {
      user_id: string;
      status: "online" | "idle" | "dnd";
      custom_status?: { text?: string; emoji?: string };
    }[];
    self_presence?: { status_pref: "online" | "dnd" | "invisible"; custom_status?: object };
    notification_settings?: object[];
    voice_states?: VoiceStatePayload[];
    read_states?: ReadStatePayload[];
    relationships?: object;
    calls?: object[];
  } = {},
) {
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  const sock = FakeSocket.last;
  act(() => {
    sock.hello();
    sock.dispatch("READY", 1, {
      session_id: session,
      user: { id: ME },
      guilds,
      private_channels: extra.private_channels ?? [],
      presences: extra.presences ?? [],
      voice_states: extra.voice_states ?? [],
      read_states: extra.read_states ?? [],
      ...(extra.self_presence ? { self_presence: extra.self_presence } : {}),
      notification_settings: extra.notification_settings ?? [],
      ...(extra.relationships ? { relationships: extra.relationships } : {}),
      calls: extra.calls ?? [],
    });
  });
  return sock;
}

/** Evento de dispatch vindo do servidor, dentro de `act`. */
export function serverSends(sock: FakeSocket, t: string, s: number, d: unknown) {
  act(() => sock.dispatch(t, s, d));
}

/** Voice state como o gateway envia. */
export function voiceState(
  userId: string,
  channelId: string | null,
  extra: Partial<VoiceStatePayload> = {},
): VoiceStatePayload {
  return {
    guild_id: channelId?.startsWith("g") ? "g1" : null,
    channel_id: channelId,
    user_id: userId,
    self_mute: false,
    self_deaf: false,
    self_video: false,
    self_screen: false,
    screen_preview: false,
    ...extra,
  };
}
