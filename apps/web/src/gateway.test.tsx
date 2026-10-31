import { Permission } from "@spook/shared";
import { FakeSocket } from "@spook/shared/testing";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useGatewayStore } from "@/features/gateway/store";
import { channel, guild, ME, member, messages } from "@/test/fixtures";
import { connectGateway, serverSends } from "@/test/gateway";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";

const CH = "g1-txt";
const path = `/channels/g1/${CH}`;
const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;

function seed(s: Backend["state"]) {
  s.guilds.push(guild("g1", "Alfa", { permissions: BASE }));
  s.members.g1 = [member(ME, "ana"), member("50", "bia")];
  s.messages[CH] = messages(CH, 2, 1000);
}

const log = () => screen.findByRole("log", { name: "Mensagens de geral" });
const incoming = (id: string, content: string, author = "50") => ({
  id,
  channel_id: CH,
  author: { id: author, username: author === ME ? "ana" : "bia" },
  content,
  edited_at: null,
  created_at: "2026-10-31T12:00:00Z",
});

async function open() {
  const app = await renderApp(path, { signedIn: true, seed });
  const list = await log();
  await within(list).findByText("mensagem 1001");
  const sock = await connectGateway(app.state.guilds);
  // o READY refaz o histórico aberto (fecha a janela entre o GET e a assinatura): espera assentar
  await waitFor(() => expect(historyGets(app.state)).toBe(2));
  await act(async () => {});
  return { ...app, sock, list };
}

const historyGets = (state: Backend["state"]) =>
  state.requests.filter((r) => r.path.endsWith(`/${CH}/messages`)).length;

/** O servidor grava a mensagem e depois publica o evento (como no backend real). */
function publish(
  state: Backend["state"],
  sock: FakeSocket,
  s: number,
  msg: ReturnType<typeof incoming>,
) {
  state.messages[CH] = [...(state.messages[CH] ?? []), msg];
  serverSends(sock, "MESSAGE_CREATE", s, msg);
}

describe("tempo real", () => {
  it("conecta ao gateway ao entrar, identifica como web e guarda a sessão no store", async () => {
    const { sock } = await open();
    expect(sock.url).toContain("/api/gateway");
    expect(sock.url).not.toContain("ticket"); // web: cookie, sem ticket
    expect(sock.ops(2)[0]?.d).toEqual({ client: "web" });
    await waitFor(() => expect(useGatewayStore.getState().status).toBe("connected"));
    expect(useGatewayStore.getState()).toMatchObject({ sessionId: "sess-1", userId: ME });
  });

  it("mensagem de outra pessoa aparece sem recarregar; edição e exclusão também", async () => {
    const { sock, list, state } = await open();
    publish(state, sock, 2, incoming("2000", "oi, tempo real"));
    expect(await within(list).findByText("oi, tempo real")).toBeInTheDocument();

    const edited = { ...incoming("2000", "oi, editado"), edited_at: "2026-10-31T12:05:00Z" };
    state.messages[CH] = (state.messages[CH] ?? []).map((m) => (m.id === "2000" ? edited : m));
    serverSends(sock, "MESSAGE_UPDATE", 3, edited);
    expect(await within(list).findByText("oi, editado")).toBeInTheDocument();
    expect(within(list).queryByText("oi, tempo real")).toBeNull();

    state.messages[CH] = (state.messages[CH] ?? []).filter((m) => m.id !== "2000");
    serverSends(sock, "MESSAGE_DELETE", 4, { id: "2000", channel_id: CH, guild_id: "g1" });
    await waitFor(() => expect(within(list).queryByText("oi, editado")).toBeNull());
  });

  it("a mensagem que eu mesmo enviei não duplica quando o evento chega", async () => {
    const user = userEvent.setup();
    const { sock, list, state } = await open();
    await user.type(screen.getByLabelText("Mensagem em #geral"), "enviada por mim{Enter}");
    expect(await within(list).findByText("enviada por mim")).toBeInTheDocument();
    const own = state.messages[CH]?.at(-1);
    expect(own?.content).toBe("enviada por mim");

    serverSends(sock, "MESSAGE_CREATE", 2, own);
    await act(async () => {});
    expect(within(list).getAllByText("enviada por mim")).toHaveLength(1);
  });

  it("evento duplicado (mesmo s) é descartado pelo cliente", async () => {
    const { sock, list, state } = await open();
    publish(state, sock, 2, incoming("2000", "uma vez só"));
    serverSends(sock, "MESSAGE_CREATE", 2, incoming("2001", "repetido pelo servidor"));
    expect(await within(list).findByText("uma vez só")).toBeInTheDocument();
    expect(within(list).queryByText("repetido pelo servidor")).toBeNull();
  });

  it("sair do app (desmontar) fecha o WebSocket e zera o store", async () => {
    const { sock, unmount } = await open();
    unmount();
    expect(sock.closedWith?.code).toBe(1000);
    expect(useGatewayStore.getState()).toMatchObject({ status: "closed", sessionId: null });
  });

  it("GUILD_DELETE do servidor aberto leva ao início com um aviso", async () => {
    const { sock, router, state } = await open();
    state.guilds.length = 0;
    serverSends(sock, "GUILD_DELETE", 2, { id: "g1" });
    expect(await screen.findByText("Você não está mais em Alfa.")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(await screen.findByText("Você ainda não está em nenhum servidor")).toBeInTheDocument();
  });

  it("CHANNEL_DELETE do canal aberto leva a outro canal do servidor", async () => {
    const app = await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.guilds[0]?.channels?.push(channel("g1-txt2", "outro", 3, 0, "g1-cat"));
        s.messages["g1-txt2"] = [];
      },
    });
    await log();
    const sock = await connectGateway(app.state.guilds);
    serverSends(sock, "CHANNEL_DELETE", 2, {
      ...channel(CH, "geral", 1, 0, "g1-cat"),
      guild_id: "g1",
    });
    expect(await screen.findByText("O canal #geral não está mais disponível.")).toBeInTheDocument();
    await waitFor(() => expect(app.router.state.location.pathname).toBe("/channels/g1/g1-txt2"));
  });

  it("perder o meu cargo (GUILD_MEMBER_UPDATE) refaz o servidor e esconde o composer", async () => {
    const { sock, state } = await open();
    expect(screen.getByLabelText("Mensagem em #geral")).toBeInTheDocument();
    const before = state.requests.filter((r) => r.path === "/api/guilds").length;
    // o servidor passa a devolver o servidor sem SEND_MESSAGES
    state.guilds[0] = guild("g1", "Alfa", { permissions: Permission.VIEW_CHANNEL });
    serverSends(sock, "GUILD_MEMBER_UPDATE", 2, { ...member(ME, "ana"), guild_id: "g1" });
    expect(
      await screen.findByText("Você não tem permissão para enviar mensagens neste canal."),
    ).toBeInTheDocument();
    expect(state.requests.filter((r) => r.path === "/api/guilds").length).toBeGreaterThan(before);
  });
});

describe("permissões", () => {
  it("perder VIEW_CHANNEL (cargo do @everyone alterado) tira o usuário do canal com um aviso", async () => {
    const { sock, state, router } = await open();
    // o servidor passa a devolver o servidor sem VIEW_CHANNEL: canais vêm vazios (SPEC 5.5)
    state.guilds[0] = guild("g1", "Alfa", { permissions: 0, channels: [] });
    serverSends(sock, "ROLE_UPDATE", 2, {
      id: "g1",
      guild_id: "g1",
      name: "@everyone",
      color: null,
      position: 0,
      permissions: 0,
      is_everyone: true,
    });
    expect(await screen.findByText("Este canal não está mais disponível.")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/channels/g1"));
    expect(screen.queryByRole("log")).toBeNull();
  });
});

describe("reconexão", () => {
  it("queda: reconecta e retoma a sessão com o último s, sem refazer os GETs", async () => {
    const { sock, list, state } = await open();
    publish(state, sock, 2, incoming("2000", "antes da queda"));
    await within(list).findByText("antes da queda");
    const before = historyGets(state);

    act(() => sock.serverClose(1006));
    await waitFor(() => expect(useGatewayStore.getState().status).toBe("reconnecting"));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3_000 });
    const next = FakeSocket.last;
    act(() => next.hello());
    expect(next.ops(3)[0]?.d).toEqual({ session_id: "sess-1", seq: 2 });

    // evento reenviado + RESUMED
    publish(state, next, 3, incoming("2001", "perdida na queda"));
    act(() => next.dispatch("RESUMED", null, { session_id: "sess-1", replayed: 1 }));
    expect(await within(list).findByText("perdida na queda")).toBeInTheDocument();
    await waitFor(() => expect(useGatewayStore.getState().status).toBe("connected"));
    expect(historyGets(state)).toBe(before); // resume cobriu tudo: nada de GET
  });

  it("sessão perdida (op 9): identifica de novo e refaz servidores e histórico", async () => {
    const { sock, list, state } = await open();
    const before = historyGets(state);
    // enquanto estava fora, chegou uma mensagem que o resume não consegue entregar
    state.messages[CH] = [...(state.messages[CH] ?? []), ...messages(CH, 1, 3000, "50")];

    act(() => sock.serverClose(1006));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3_000 });
    const next = FakeSocket.last;
    act(() => {
      next.hello();
      next.receive({ op: 9, d: false });
    });
    expect(next.ops(2)).toHaveLength(1);
    act(() =>
      next.dispatch("READY", 1, { session_id: "sess-2", user: { id: ME }, guilds: state.guilds }),
    );
    expect(await within(list).findByText("mensagem 3000")).toBeInTheDocument();
    expect(historyGets(state)).toBeGreaterThan(before);
    expect(useGatewayStore.getState().sessionId).toBe("sess-2");
  });

  it("4002 (sessão aberta em outro lugar): não reconecta e oferece reconectar", async () => {
    const { sock } = await open();
    act(() => sock.serverClose(4002));
    expect(await screen.findByText("Sessão aberta em outro lugar.")).toBeInTheDocument();
    expect(FakeSocket.instances).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "Reconectar" }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
  });

  it("voltar a internet reconecta sem esperar o backoff", async () => {
    const { sock } = await open();
    act(() => window.dispatchEvent(new Event("offline")));
    await waitFor(() => expect(useGatewayStore.getState().status).toBe("reconnecting"));
    expect(sock.closedWith).not.toBeNull();
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
  });
});
