import { Permission } from "@spook/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCallStore } from "@/features/social/call-store";
import { useSocialStore } from "@/features/social/store";
import { resetVoiceController } from "@/features/voice/controller";
import { setVoiceEngineFactory } from "@/features/voice/engine-provider";
import { useVoiceStatesStore } from "@/features/voice/store";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { channel, dm, guild, ME, member, messages, recipient } from "@/test/fixtures";
import { connectGateway, serverSends, voiceState } from "@/test/gateway";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";
import { callPayload, rel } from "@/test/social";

const ring = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("@/features/voice/call-sounds", async (orig) => ({
  ...(await orig<typeof import("@/features/voice/call-sounds")>()),
  startRing: ring.start,
  stopRing: ring.stop,
}));

const FULL = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.CREATE_INVITE;
const BIA = "50";
const CAIO = "60";
const DUDA = "70";
const EVA = "80";
const FABI = "90";
const DM = "dm1";

let fake: FakeVoiceEngine;
beforeEach(() => {
  fake = new FakeVoiceEngine();
  setVoiceEngineFactory(() => fake);
  resetVoiceController();
  useVoiceStatesStore.getState().reset();
  ring.start.mockClear();
  ring.stop.mockClear();
});

function seed(s: Backend["state"]) {
  s.guilds.push(
    guild("g1", "Alfa", {
      permissions: FULL,
      channels: [channel("g1-txt", "geral", 0), channel("g1-voz", "Geral", 1, 1)],
    }),
    guild("g2", "Beta", { permissions: Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES }),
  );
  s.members.g1 = [member(ME, "ana"), member(BIA, "bia"), member(CAIO, "caio")];
  s.dms = [dm(DM, [recipient(ME, "ana"), recipient(BIA, "bia", "Bia Souza")])];
  s.social.users = {
    duda: { id: DUDA, username: "duda" },
    bia: { id: BIA, username: "bia", display_name: "Bia Souza" },
  };
  s.social.relationships = [
    rel(BIA, "bia", "friend", "Bia Souza"),
    rel(CAIO, "caio", "friend"),
    rel(DUDA, "duda", "incoming"),
    rel(EVA, "eva", "outgoing"),
    rel(FABI, "fabi", "blocked"),
  ];
}

async function openFriends() {
  const app = await renderApp("/channels/@me/friends", { signedIn: true, seed });
  const sock = await connectGateway(app.state.guilds, "s1", {
    private_channels: app.state.dms,
    presences: [{ user_id: BIA, status: "online" }],
    relationships: {
      friend_count: 2,
      incoming_count: 1,
      outgoing_count: 1,
      blocked_ids: [FABI],
      items: app.state.social.relationships.filter((r) => r.type !== "blocked"),
      truncated: false,
    },
  });
  await screen.findByRole("heading", { name: "Amigos", level: 1 });
  return { ...app, sock };
}

const tab = (name: RegExp | string) => screen.findByRole("tab", { name });

describe("tela de Amigos", () => {
  it("abas Online e Todos; só os amigos online aparecem em Online", async () => {
    const user = userEvent.setup();
    await openFriends();
    const online = await screen.findByRole("list", { name: "Amigos online, 1" });
    expect(within(online).getByText("Bia Souza")).toBeInTheDocument();
    expect(within(online).queryByText("caio")).not.toBeInTheDocument();
    expect(within(online).getByText(/Online/)).toBeInTheDocument();

    await user.click(await tab("Todos"));
    const all = await screen.findByRole("list", { name: "Todos os amigos, 2" });
    expect(within(all).getByText("Bia Souza")).toBeInTheDocument();
    expect(within(all).getByText("caio")).toBeInTheDocument();
    expect(within(all).getByText(/Offline/)).toBeInTheDocument();
  });

  it("mostra onde o amigo está na voz quando compartilham o servidor", async () => {
    const user = userEvent.setup();
    const { sock } = await openFriends();
    serverSends(sock, "VOICE_STATE_UPDATE", 2, voiceState(BIA, "g1-voz"));
    await user.click(await tab("Todos"));
    expect(await screen.findByText(/Em voz em Geral · Alfa/)).toBeInTheDocument();
  });

  it("Pendentes: selo com os pedidos recebidos, aceitar e recusar", async () => {
    const user = userEvent.setup();
    const { state } = await openFriends();
    const pendingTab = await tab(/Pendentes/);
    expect(within(pendingTab).getByLabelText("1 pedido recebido")).toBeInTheDocument();
    await user.click(pendingTab);
    const list = await screen.findByRole("list", { name: "Pedidos pendentes, 2" });
    expect(within(list).getByText(/Pedido de amizade recebido/)).toBeInTheDocument();
    expect(within(list).getByText(/Pedido de amizade enviado/)).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: "Aceitar" }));
    await waitFor(() => expect(state.social.accepts).toEqual([DUDA]));
    expect(await screen.findByText("Você e @duda agora são amigos.")).toBeInTheDocument();
    expect(state.social.relationships.find((r) => r.user.id === DUDA)?.type).toBe("friend");

    await user.click(await screen.findByRole("button", { name: "Cancelar pedido para eva" }));
    await waitFor(() => expect(state.social.removes).toContain(EVA));
  });

  it("recusar um pedido recebido faz DELETE", async () => {
    const user = userEvent.setup();
    const { state } = await openFriends();
    await user.click(await tab(/Pendentes/));
    await user.click(await screen.findByRole("button", { name: "Recusar pedido de duda" }));
    await waitFor(() => expect(state.social.removes).toEqual([DUDA]));
  });

  it("Adicionar amigo: envia por username, avisa erro e impede adicionar a si mesmo", async () => {
    const user = userEvent.setup();
    const { state } = await openFriends();
    await user.click(await tab(/Adicionar amigo/));
    const input = await screen.findByLabelText("Nome de usuário");
    await user.type(input, "ana");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Você não pode adicionar a si mesmo.",
    );
    expect(screen.getByRole("button", { name: /Enviar pedido/ })).toBeDisabled();

    await user.clear(input);
    await user.type(input, "@fantasma");
    await user.click(screen.getByRole("button", { name: /Enviar pedido/ }));
    expect(
      await screen.findByText("Não encontramos ninguém com esse nome de usuário."),
    ).toBeInTheDocument();
    expect(state.social.requests).toEqual(["fantasma"]);

    state.social.users.zeca = { id: "95", username: "zeca" };
    await user.clear(input);
    await user.type(input, "zeca");
    await user.click(screen.getByRole("button", { name: /Enviar pedido/ }));
    expect(await screen.findByText("Pedido enviado para @zeca.")).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("429 no pedido mostra o tempo de espera em pt-br", async () => {
    const user = userEvent.setup();
    const { state } = await openFriends();
    state.social.requestError = { status: 429, detail: "muitos" };
    await user.click(await tab(/Adicionar amigo/));
    await user.type(await screen.findByLabelText("Nome de usuário"), "duda");
    await user.click(screen.getByRole("button", { name: /Enviar pedido/ }));
    expect(await screen.findByText(/Muitas ações seguidas/)).toBeInTheDocument();
  });

  it("Bloquear pede confirmação, bloqueia e vai para a aba Bloqueados; Desbloquear devolve", async () => {
    const user = userEvent.setup();
    const { state } = await openFriends();
    await user.click(await tab("Todos"));
    await user.click(await screen.findByRole("button", { name: "Mais opções de caio" }));
    await user.click(await screen.findByRole("menuitem", { name: /Bloquear/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Bloquear caio\?/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Ela não é avisada do bloqueio/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Bloquear" }));
    await waitFor(() => expect(state.social.blocks).toEqual([CAIO]));
    expect(useSocialStore.getState().blocked[CAIO]).toBe(true);

    await user.click(await tab("Bloqueados"));
    const list = await screen.findByRole("list", { name: /Bloqueados, 2/ });
    expect(within(list).getByText("fabi")).toBeInTheDocument();
    await user.click(
      within(list).getAllByRole("button", { name: "Desbloquear" })[0] as HTMLElement,
    );
    await waitFor(() => expect(state.social.unblocks).toHaveLength(1));
  });

  it("Remover amigo pede confirmação", async () => {
    const user = userEvent.setup();
    const { state } = await openFriends();
    await user.click(await tab("Todos"));
    await user.click(await screen.findByRole("button", { name: "Mais opções de caio" }));
    await user.click(await screen.findByRole("menuitem", { name: /Remover amigo/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(state.social.removes).toEqual([]);
    await user.click(await screen.findByRole("button", { name: "Mais opções de caio" }));
    await user.click(await screen.findByRole("menuitem", { name: /Remover amigo/ }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remover amigo" }),
    );
    await waitFor(() => expect(state.social.removes).toEqual([CAIO]));
  });

  it("Convidar para servidor lista só os servidores onde posso convidar", async () => {
    const user = userEvent.setup();
    const { state } = await openFriends();
    await user.click(await tab("Todos"));
    await user.click(await screen.findByRole("button", { name: "Mais opções de caio" }));
    await user.click(await screen.findByRole("menuitem", { name: /Convidar para servidor/ }));
    const dialog = await screen.findByRole("dialog", { name: "Convidar para servidor" });
    expect(within(dialog).getByText("Alfa")).toBeInTheDocument();
    expect(within(dialog).queryByText("Beta")).not.toBeInTheDocument(); // sem CREATE_INVITE
    await user.click(within(dialog).getByRole("button", { name: /Alfa/ }));
    await waitFor(() => expect(state.social.invites).toEqual([{ userId: CAIO, guildId: "g1" }]));
    expect(await screen.findByText("Convite para Alfa enviado a caio.")).toBeInTheDocument();
  });

  it("erro ao convidar (já é membro) aparece em pt-br", async () => {
    const user = userEvent.setup();
    const { state } = await openFriends();
    state.social.inviteError = { status: 409, detail: "essa pessoa já está no servidor" };
    await user.click(await tab("Todos"));
    await user.click(await screen.findByRole("button", { name: "Mais opções de caio" }));
    await user.click(await screen.findByRole("menuitem", { name: /Convidar para servidor/ }));
    await user.click(await screen.findByRole("button", { name: /Alfa/ }));
    expect(await screen.findByText("Essa pessoa já está no servidor")).toBeInTheDocument();
  });

  it("Mensagem abre a DM com o amigo", async () => {
    const user = userEvent.setup();
    const { router } = await openFriends();
    await user.click(await screen.findByRole("button", { name: "Enviar mensagem para Bia Souza" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/channels/@me/${DM}`));
  });

  it("estados vazios com ilustração e ação", async () => {
    const user = userEvent.setup();
    const app = await renderApp("/channels/@me/friends", {
      signedIn: true,
      seed: (s) => s.guilds.push(guild("g1", "Alfa")),
    });
    await connectGateway(app.state.guilds);
    expect(await screen.findByText("Ninguém online agora")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Adicionar amigo/, hidden: false }));
    expect(await screen.findByLabelText("Nome de usuário")).toBeInTheDocument();
    await user.click(await tab(/Pendentes/));
    expect(await screen.findByText("Nenhum pedido pendente")).toBeInTheDocument();
    await user.click(await tab("Bloqueados"));
    expect(await screen.findByText("Ninguém bloqueado")).toBeInTheDocument();
  });
});

describe("selo de pedidos e eventos", () => {
  it("o READY e os eventos mantêm o selo no Início e o link Amigos", async () => {
    const app = await renderApp("/channels/@me", { signedIn: true, seed });
    const sock = await connectGateway(app.state.guilds, "s1", {
      private_channels: app.state.dms,
      relationships: {
        friend_count: 2,
        incoming_count: 1,
        outgoing_count: 1,
        blocked_ids: [],
        items: [rel(DUDA, "duda", "incoming")],
        truncated: false,
      },
    });
    const home = await screen.findByRole("link", { name: "Início" });
    expect(
      await within(home.parentElement as HTMLElement).findByRole("img", {
        name: "1 pedido de amizade",
      }),
    ).toBeInTheDocument();
    const friends = screen.getByRole("link", { name: /Amigos/ });
    expect(within(friends).getByLabelText("1 pedido de amizade")).toBeInTheDocument();

    serverSends(sock, "RELATIONSHIP_ADD", 2, rel("99", "gabi", "incoming"));
    expect(
      await within(home.parentElement as HTMLElement).findByRole("img", {
        name: "2 pedidos de amizade",
      }),
    ).toBeInTheDocument();
    serverSends(sock, "RELATIONSHIP_UPDATE", 3, rel("99", "gabi", "friend"));
    serverSends(sock, "RELATIONSHIP_REMOVE", 4, { user_id: DUDA });
    await waitFor(() =>
      expect(
        within(home.parentElement as HTMLElement).queryByRole("img", { name: /pedido/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it("bloqueio vindo de outra sessão marca a pessoa como bloqueada", async () => {
    const app = await renderApp("/channels/@me", { signedIn: true, seed });
    const sock = await connectGateway(app.state.guilds);
    serverSends(sock, "RELATIONSHIP_ADD", 2, rel(CAIO, "caio", "blocked"));
    await waitFor(() => expect(useSocialStore.getState().blocked[CAIO]).toBe(true));
    serverSends(sock, "RELATIONSHIP_REMOVE", 3, { user_id: CAIO });
    await waitFor(() => expect(useSocialStore.getState().blocked[CAIO]).toBeUndefined());
  });
});

describe("cartão de perfil", () => {
  const path = "/channels/g1/g1-txt";
  async function openCard(name: string) {
    const user = userEvent.setup();
    const app = await renderApp(path, { signedIn: true, seed });
    await connectGateway(app.state.guilds, "s1", { private_channels: app.state.dms });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await user.click(await within(panel).findByRole("button", { name: `Ver perfil de ${name}` }));
    const card = await screen.findByRole("dialog", { name: `Perfil de ${name}` });
    return { user, app, card };
  }

  it("amigo: mensagem, ligar, convidar, remover e bloquear (um GET de relacionamento)", async () => {
    const { app, card } = await openCard("bia");
    expect(
      await within(card).findByRole("button", { name: "Enviar mensagem" }),
    ).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Ligar para bia" })).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /Convidar para servidor/ }),
    ).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Remover amigo/ })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Bloquear/ })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Adicionar amigo/ })).not.toBeInTheDocument();
    const gets = app.state.requests.filter((r) => r.path === `/api/users/${BIA}/relationship`);
    expect(gets.length).toBeLessThanOrEqual(1);
  });

  it("quem não é amigo: Adicionar amigo envia o pedido por username", async () => {
    const user = userEvent.setup();
    const app = await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.social.relationships = [];
        s.social.users.bia = { id: BIA, username: "bia" };
      },
    });
    await connectGateway(app.state.guilds, "s1", { private_channels: app.state.dms });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await user.click(await within(panel).findByRole("button", { name: "Ver perfil de bia" }));
    const card = await screen.findByRole("dialog", { name: "Perfil de bia" });
    await user.click(await within(card).findByRole("button", { name: /Adicionar amigo/ }));
    await waitFor(() => expect(app.state.social.requests).toEqual(["bia"]));
    // depois do pedido o cartão mostra Cancelar pedido
    expect(
      await within(card).findByRole("button", { name: /Cancelar pedido/ }),
    ).toBeInTheDocument();
  });

  it("pedido recebido: Aceitar pedido", async () => {
    const user = userEvent.setup();
    const app = await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.social.relationships = [rel(BIA, "bia", "incoming")];
      },
    });
    await connectGateway(app.state.guilds, "s1", { private_channels: app.state.dms });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await user.click(await within(panel).findByRole("button", { name: "Ver perfil de bia" }));
    const card = await screen.findByRole("dialog", { name: "Perfil de bia" });
    await user.click(await within(card).findByRole("button", { name: /Aceitar pedido/ }));
    await waitFor(() => expect(app.state.social.accepts).toEqual([BIA]));
  });

  it("Bloquear pede confirmação e fecha o cartão; bloqueado vê Desbloquear e não tem mensagem/ligar", async () => {
    const { user, app, card } = await openCard("caio");
    await user.click(await within(card).findByRole("button", { name: /Bloquear/ }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Bloquear" }),
    );
    await waitFor(() => expect(app.state.social.blocks).toEqual([CAIO]));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Perfil de caio" })).not.toBeInTheDocument(),
    );
    // reabre: agora bloqueado
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await user.click(await within(panel).findByRole("button", { name: "Ver perfil de caio" }));
    const again = await screen.findByRole("dialog", { name: "Perfil de caio" });
    expect(await within(again).findByRole("button", { name: "Desbloquear" })).toBeInTheDocument();
    expect(
      within(again).queryByRole("button", { name: "Enviar mensagem" }),
    ).not.toBeInTheDocument();
    expect(within(again).queryByRole("button", { name: /Ligar/ })).not.toBeInTheDocument();
  });
});

describe("mensagens de usuários bloqueados", () => {
  it("ficam recolhidas com 'mostrar' e voltam a aparecer só nessa linha", async () => {
    const user = userEvent.setup();
    const app = await renderApp("/channels/g1/g1-txt", {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.messages["g1-txt"] = [
          ...messages("g1-txt", 1, 1000, BIA),
          ...messages("g1-txt", 1, 1001, CAIO).map((m) => ({
            ...m,
            author: { id: CAIO, username: "caio" },
          })),
        ];
      },
    });
    await connectGateway(app.state.guilds, "s1", {
      private_channels: app.state.dms,
      relationships: {
        friend_count: 0,
        incoming_count: 0,
        outgoing_count: 0,
        blocked_ids: [BIA],
        items: [],
        truncated: false,
      },
    });
    expect(await screen.findByText("mensagem 1001")).toBeInTheDocument();
    expect(screen.queryByText("mensagem 1000")).not.toBeInTheDocument();
    const collapsed = screen.getByRole("article", { name: "Mensagem de usuário bloqueado" });
    expect(collapsed).toHaveTextContent("Mensagem de usuário bloqueado —");
    await user.click(within(collapsed).getByRole("button", { name: "mostrar" }));
    expect(await screen.findByText("mensagem 1000")).toBeInTheDocument();
  });
});

describe("chamadas em DM com toque", () => {
  async function openDm(extra: Parameters<typeof connectGateway>[2] = {}) {
    const app = await renderApp(`/channels/@me/${DM}`, { signedIn: true, seed });
    const sock = await connectGateway(app.state.guilds, "s1", {
      private_channels: app.state.dms,
      ...extra,
    });
    await screen.findByRole("heading", { name: "Bia Souza" });
    return { ...app, sock };
  }

  it("CALL_RING mostra o alertdialog, toca até responder e Atender entra na sala com o token do servidor", async () => {
    const user = userEvent.setup();
    const { sock, state, router } = await openDm();
    serverSends(sock, "CALL_RING", 2, callPayload(DM));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Bia Souza")).toBeInTheDocument();
    expect(within(dialog).getByText(/Chamada de voz recebida/)).toBeInTheDocument();
    expect(ring.start).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("button", { name: /Atender/ })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: /Atender/ }));
    await waitFor(() => expect(state.social.accepts_call).toEqual([DM]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(ring.stop).toHaveBeenCalled();
    await waitFor(() => expect(fake.connects.at(-1)?.token).toBe(`accept-${DM}`));
    expect(state.voice.tokensFor).toEqual([]); // usou o token da resposta de atender
    expect(router.state.location.pathname).toBe(`/channels/@me/${DM}`);
  });

  it("Recusar e Esc recusam; o toque para", async () => {
    const user = userEvent.setup();
    const { sock, state } = await openDm();
    serverSends(sock, "CALL_RING", 2, callPayload(DM));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /Recusar/ }));
    await waitFor(() => expect(state.social.declines).toEqual([DM]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(ring.stop).toHaveBeenCalled();

    serverSends(sock, "CALL_RING", 3, callPayload(DM));
    const again = await screen.findByRole("alertdialog");
    expect(within(again).getByRole("button", { name: /Atender/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(state.social.declines).toEqual([DM, DM]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("CALL_END e CALL_UPDATE (atendida em outro dispositivo) encerram o toque", async () => {
    const { sock } = await openDm();
    serverSends(sock, "CALL_RING", 2, callPayload(DM));
    await screen.findByRole("alertdialog");
    serverSends(sock, "CALL_END", 3, callPayload(DM, { state: "ended", reason: "cancelled" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(ring.stop).toHaveBeenCalled();

    serverSends(sock, "CALL_RING", 4, callPayload(DM));
    await screen.findByRole("alertdialog");
    serverSends(
      sock,
      "CALL_UPDATE",
      5,
      callPayload(DM, { state: "active", reason: "answered", user_id: ME }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("o toque vence sozinho no prazo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { sock } = await openDm();
      serverSends(
        sock,
        "CALL_RING",
        2,
        callPayload(DM, { expires_at: new Date(Date.now() + 5_000).toISOString() }),
      );
      await screen.findByRole("alertdialog");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_500);
      });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(ring.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("chamada que já tocava no READY (recarregou a página) volta a tocar", async () => {
    await openDm({ calls: [callPayload(DM)] });
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(ring.start).toHaveBeenCalled();
  });

  it("Ligar toca o outro lado e mostra Chamando… com Cancelar", async () => {
    const user = userEvent.setup();
    const { state, sock } = await openDm();
    await user.click(await screen.findByRole("button", { name: /Ligar/ }));
    await screen.findByRole("region", { name: "Controles de voz" });
    expect(state.social.rings).toEqual([DM]);
    expect(await screen.findByText("Chamando…")).toBeInTheDocument();

    // O outro lado atende: o estado de "Chamando…" some e vira "Em chamada".
    serverSends(
      sock,
      "CALL_UPDATE",
      2,
      callPayload(DM, { started_by: ME, state: "active", reason: "answered", user_id: BIA }),
    );
    await waitFor(() => expect(screen.queryByText("Chamando…")).not.toBeInTheDocument());
    expect(screen.getByText("Em chamada")).toBeInTheDocument();
  });

  it("Cancelar interrompe o toque e sai da sala", async () => {
    const user = userEvent.setup();
    const { state } = await openDm();
    await user.click(await screen.findByRole("button", { name: /Ligar/ }));
    await screen.findByText("Chamando…");
    await user.click(screen.getByRole("button", { name: /Cancelar/ }));
    await waitFor(() => expect(state.social.cancels).toEqual([DM]));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Controles de voz" })).not.toBeInTheDocument(),
    );
  });

  it("recusa do servidor ao ligar (bloqueou a pessoa) avisa e não entra na sala", async () => {
    const user = userEvent.setup();
    const { state } = await openDm();
    state.social.ringError = {
      status: 403,
      detail: "você bloqueou esta pessoa: desbloqueie para ligar",
    };
    await user.click(await screen.findByRole("button", { name: /Ligar/ }));
    expect(
      await screen.findByText("Você bloqueou esta pessoa: desbloqueie para ligar"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Controles de voz" })).not.toBeInTheDocument();
    expect(state.voice.tokensFor).toEqual([]);
  });

  it("voz indisponível (503 no toque) ainda deixa o fluxo normal de voz explicar", async () => {
    const user = userEvent.setup();
    const { state } = await openDm();
    state.social.ringError = { status: 503, detail: "voz indisponível" };
    await user.click(await screen.findByRole("button", { name: /Ligar/ }));
    await waitFor(() => expect(state.voice.tokensFor).toEqual([DM]));
  });

  it("chamada em andamento vira Entrar na chamada, sem tocar de novo", async () => {
    const user = userEvent.setup();
    const { state, sock } = await openDm();
    serverSends(sock, "VOICE_STATE_UPDATE", 2, voiceState(BIA, DM));
    await user.click(await screen.findByRole("button", { name: "Entrar na chamada" }));
    await screen.findByRole("region", { name: "Controles de voz" });
    expect(state.social.rings).toEqual([]);
  });

  it("DND no servidor: nenhum CALL_RING chega, então nada toca", async () => {
    await openDm();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(ring.start).not.toHaveBeenCalled();
    expect(useCallStore.getState().incoming).toEqual({});
  });
});

describe("Configurações > Bloqueados", () => {
  it("lista quem está bloqueado e desbloqueia", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/settings/blocked", { signedIn: true, seed });
    const list = await screen.findByRole("list", { name: "Pessoas bloqueadas" });
    expect(within(list).getByText("fabi")).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "Desbloquear" }));
    await waitFor(() => expect(state.social.unblocks).toEqual([FABI]));
    expect(await screen.findByText("Você não bloqueou ninguém.")).toBeInTheDocument();
  });

  it("a seção aparece na navegação das configurações", async () => {
    await renderApp("/settings/profile", { signedIn: true, seed });
    expect(await screen.findByRole("link", { name: /Bloqueados/ })).toHaveAttribute(
      "href",
      "/settings/blocked",
    );
  });
});

describe("chamada com a aba oculta", () => {
  it("CALL_RING com a aba oculta avisa pelo navegador/SO", async () => {
    const app = await renderApp(`/channels/@me/${DM}`, { signedIn: true, seed });
    const sock = await connectGateway(app.state.guilds, "s1", { private_channels: app.state.dms });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const created: string[] = [];
    vi.stubGlobal(
      "Notification",
      class {
        static permission = "granted";
        onclick: unknown = null;
        constructor(title: string) {
          created.push(title);
        }
        close() {}
      },
    );
    try {
      serverSends(sock, "CALL_RING", 2, callPayload(DM));
      await waitFor(() => expect(created).toEqual(["Bia Souza"]));
    } finally {
      visibility.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
