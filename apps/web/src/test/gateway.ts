import type { ChannelPayload, DetailPayload } from "@spook/shared";
import { FakeSocket } from "@spook/shared/testing";
import { act, waitFor } from "@testing-library/react";
import { ME } from "./fixtures";

/** Espera o provider abrir o WebSocket falso e completa HELLO + READY (usuário `ME`). */
export async function connectGateway(
  guilds: DetailPayload[],
  session = "sess-1",
  extra: {
    private_channels?: ChannelPayload[];
    presences?: { user_id: string; status: "online" | "idle" }[];
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
    });
  });
  return sock;
}

/** Evento de dispatch vindo do servidor, dentro de `act`. */
export function serverSends(sock: FakeSocket, t: string, s: number, d: unknown) {
  act(() => sock.dispatch(t, s, d));
}
