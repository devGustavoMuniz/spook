import { Permission } from "@spook/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { usePresenceStore } from "@/features/presence/store";
import { dm, guild, ME, member, messages, recipient } from "@/test/fixtures";
import { connectGateway, serverSends } from "@/test/gateway";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";

const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;
const me = recipient(ME, "ana");
const bia = recipient("50", "bia", "Bia Souza");
const caio = recipient("60", "caio");
const duda = recipient("70", "duda");

const ONE = "1100"; // 1:1 com a bia
const GROUP = "1200"; // grupo meu: ana (dona), bia, caio, nome "Estudo de Go"
const OTHER_GROUP = "1300"; // grupo do caio, sem nome: ana, bia, caio

function seed(s: Backend["state"]) {
  s.guilds.push(guild("g1", "Alfa", { permissions: BASE }));
  s.members.g1 = [
    member(ME, "ana"),
    member("50", "bia"),
    member("60", "caio"),
    member("70", "duda"),
  ];
  s.dms = [
    dm(ONE, [me, bia], { last_message_id: "2000" }),
    dm(GROUP, [me, bia, caio], {
      type: 4,
      owner_id: ME,
      name: "Estudo de Go",
      last_message_id: "3000",
    }),
    dm(OTHER_GROUP, [me, bia, caio], { type: 4, owner_id: "60", last_message_id: "1500" }),
  ];
  s.messages[ONE] = messages(ONE, 2, 1900, "50");
  s.messages[GROUP] = messages(GROUP, 1, 2900, "60");
}

const conversations = () => screen.findByRole("navigation", { name: "Conversas" });
const incoming = (channel: string, id: string, author = "50") => ({
  id,
  channel_id: channel,
  author: { id: author, username: author === ME ? "ana" : "bia" },
  content: `dm ${id}`,
  edited_at: null,
  created_at: "2026-10-31T12:00:00Z",
  attachments: [],
  mention_ids: [],
});

describe("lista de conversas", () => {
  it("mostra 1:1 pelo nome do outro e grupos pelo nome (ou pelos participantes), por atividade", async () => {
    await renderApp("/channels/@me", { signedIn: true, seed });
    const nav = await conversations();
    const links = await within(nav).findAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Estudo de Go",
      "Bia Souza",
      "Bia Souza, caio", // grupo sem nome: os demais participantes
    ]);
    expect(links[0]).toHaveAttribute("href", `/channels/@me/${GROUP}`);
  });

  it("sem conversas mostra o estado vazio", async () => {
    await renderApp("/channels/@me", { signedIn: true, seed: () => {} });
    expect(await screen.findByText("Você ainda não tem conversas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nova conversa em grupo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar conversa em grupo" })).toBeInTheDocument();
  });

  it("o botão Início da barra de servidores leva às conversas", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/channels/g1", { signedIn: true, seed });
    await user.click(await screen.findByRole("link", { name: "Início" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/channels/@me"));
    expect(await screen.findByText("Escolha uma conversa")).toBeInTheDocument();
  });
});

describe("conversa aberta", () => {
  it("carrega o histórico, envia e só o autor edita ou exclui (sem permissões de servidor)", async () => {
    const user = userEvent.setup();
    const app = await renderApp(`/channels/@me/${ONE}`, { signedIn: true, seed });
    const log = await screen.findByRole("log", { name: "Mensagens de Bia Souza" });
    expect(await within(log).findByText("mensagem 1901")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bia Souza" })).toBeInTheDocument();
    // mensagem da bia: nada de "excluir" (não há MANAGE_MESSAGES em DM)
    expect(within(log).queryByRole("button", { name: "Excluir mensagem" })).toBeNull();

    await user.type(screen.getByLabelText("Mensagem para Bia Souza"), "oi, bia{Enter}");
    expect(await within(log).findByText("oi, bia")).toBeInTheDocument();
    expect(within(log).getAllByRole("button", { name: "Excluir mensagem" })).toHaveLength(1);
    expect(
      app.state.requests.some((r) => r.method === "POST" && r.path.endsWith(`/${ONE}/messages`)),
    ).toBe(true);
  });

  it("DM inexistente (ou da qual saí) mostra aviso", async () => {
    await renderApp("/channels/@me/999", { signedIn: true, seed });
    expect(await screen.findByText("Conversa não encontrada")).toBeInTheDocument();
  });
});

describe("iniciar DM", () => {
  it("pelo menu de um membro: abre a conversa existente ou cria a 1:1", async () => {
    const user = userEvent.setup();
    const app = await renderApp("/channels/g1/g1-txt", {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.dms = [];
      },
    });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await within(panel).findByText("bia");
    expect(within(panel).queryByRole("button", { name: "Opções de ana" })).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "Opções de bia" }));
    await user.click(await screen.findByRole("menuitem", { name: "Enviar mensagem" }));
    await waitFor(() =>
      expect(app.router.state.location.pathname).toMatch(/^\/channels\/@me\/\d+$/),
    );
    expect(
      app.state.requests.find((r) => r.method === "POST" && r.path === "/api/users/@me/channels")
        ?.body,
    ).toEqual({
      recipient_id: "50",
    });
    expect(await screen.findByRole("log", { name: "Mensagens de bia" })).toBeInTheDocument();
  });

  it("403 (sem servidor em comum) vira aviso em pt-br", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1/g1-txt", {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.openDmError = { status: 403, detail: "forbidden" };
      },
    });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await within(panel).findByText("bia");
    await user.click(within(panel).getByRole("button", { name: "Opções de bia" }));
    await user.click(await screen.findByRole("menuitem", { name: "Enviar mensagem" }));
    expect(
      await screen.findByText("Você só pode conversar com quem compartilha um servidor com você."),
    ).toBeInTheDocument();
  });
});

describe("nova conversa em grupo", () => {
  async function openDialog(extra: (s: Backend["state"]) => void = () => {}) {
    const user = userEvent.setup();
    const app = await renderApp("/channels/@me", {
      signedIn: true,
      seed: (s) => {
        seed(s);
        extra(s);
      },
    });
    await conversations();
    await user.click(screen.getByRole("button", { name: "Nova conversa em grupo" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova conversa em grupo" });
    await within(dialog).findByRole("checkbox", { name: /bia/ });
    return { user, app, dialog };
  }

  it("lista quem divide servidor comigo (sem mim), cria o grupo, dá o nome e abre a conversa", async () => {
    const { user, app, dialog } = await openDialog();
    expect(within(dialog).queryByRole("checkbox", { name: /ana/ })).toBeNull();
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(3);
    const submit = within(dialog).getByRole("button", { name: "Criar conversa" });
    expect(submit).toBeDisabled(); // ninguém escolhido

    await user.click(within(dialog).getByRole("checkbox", { name: /caio/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /duda/ }));
    await user.type(within(dialog).getByLabelText("Nome do grupo (opcional)"), "Projeto");
    await user.click(submit);

    await waitFor(() =>
      expect(app.router.state.location.pathname).toMatch(/^\/channels\/@me\/\d+$/),
    );
    const create = app.state.requests.find(
      (r) => r.method === "POST" && r.path === "/api/users/@me/channels",
    );
    expect(create?.body).toEqual({ recipient_ids: ["60", "70"] });
    expect(
      app.state.requests.some(
        (r) => r.method === "PATCH" && (r.body as { name?: string }).name === "Projeto",
      ),
    ).toBe(true);
    expect(await screen.findByRole("heading", { name: "Projeto" })).toBeInTheDocument();
  });

  it("filtra por nome e limita a 9 pessoas", async () => {
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText("Buscar pessoas"), "duda");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(dialog).getByText("0 de 9 selecionadas")).toBeInTheDocument();
  });

  it("429 mostra o tempo de espera e mantém o diálogo aberto", async () => {
    const { user, dialog } = await openDialog((s) => {
      s.openDmError = { status: 429, detail: "limite", retryAfter: 12 };
    });
    await user.click(within(dialog).getByRole("checkbox", { name: /caio/ }));
    await user.click(within(dialog).getByRole("button", { name: "Criar conversa" }));
    expect(await screen.findByText(/Tente de novo em 12 s/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Nova conversa em grupo" })).toBeInTheDocument();
  });

  it("422 e 409 também têm mensagem", async () => {
    const { user, dialog } = await openDialog((s) => {
      s.openDmError = { status: 422, detail: "invalid" };
    });
    await user.click(within(dialog).getByRole("checkbox", { name: /caio/ }));
    await user.click(within(dialog).getByRole("button", { name: "Criar conversa" }));
    expect(
      await screen.findByText("Escolha de 1 a 9 pessoas, sem incluir você."),
    ).toBeInTheDocument();
  });
});

describe("gestão do grupo", () => {
  it("o dono adiciona e remove participantes", async () => {
    const user = userEvent.setup();
    const app = await renderApp(`/channels/@me/${GROUP}`, { signedIn: true, seed });
    await user.click(await screen.findByRole("button", { name: /Participantes \(3\)/ }));
    const dialog = await screen.findByRole("dialog", { name: "Conversa em grupo" });
    expect(within(dialog).getByText("(dono)")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remover ana" })).toBeNull();

    await user.click(await within(dialog).findByRole("checkbox", { name: /duda/ }));
    await user.click(within(dialog).getByRole("button", { name: "Adicionar" }));
    await waitFor(() =>
      expect(
        app.state.requests.some(
          (r) => r.method === "PUT" && r.path === `/api/channels/${GROUP}/recipients/70`,
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByRole("button", { name: /Participantes \(4\)/, hidden: true }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Remover caio" }));
    await waitFor(() =>
      expect(
        app.state.requests.some(
          (r) => r.method === "DELETE" && r.path === `/api/channels/${GROUP}/recipients/60`,
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByRole("button", { name: /Participantes \(3\)/, hidden: true }),
    ).toBeInTheDocument();
  });

  it("o dono renomeia o grupo", async () => {
    const user = userEvent.setup();
    const app = await renderApp(`/channels/@me/${GROUP}`, { signedIn: true, seed });
    await user.click(await screen.findByRole("button", { name: /Participantes/ }));
    const dialog = await screen.findByRole("dialog", { name: "Conversa em grupo" });
    const input = within(dialog).getByLabelText("Nome do grupo");
    await user.clear(input);
    await user.type(input, "Go avançado");
    await user.click(within(dialog).getByRole("button", { name: "Salvar nome" }));
    await waitFor(() =>
      expect(app.state.dms.find((c) => c.id === GROUP)?.name).toBe("Go avançado"),
    );
    expect(
      await screen.findByRole("heading", { name: "Go avançado", hidden: true }),
    ).toBeInTheDocument();
  });

  it("participante não vê as ações do dono e consegue sair", async () => {
    const user = userEvent.setup();
    const app = await renderApp(`/channels/@me/${OTHER_GROUP}`, { signedIn: true, seed });
    await user.click(await screen.findByRole("button", { name: /Participantes/ }));
    const dialog = await screen.findByRole("dialog", { name: "Conversa em grupo" });
    expect(within(dialog).queryByRole("button", { name: /Remover/ })).toBeNull();
    expect(within(dialog).queryByText("Adicionar pessoas")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Sair da conversa" }));
    await user.click(await screen.findByRole("button", { name: "Sair" }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe("/channels/@me"));
    expect(
      app.state.requests.some(
        (r) => r.method === "DELETE" && r.path === `/api/channels/${OTHER_GROUP}/recipients/@me`,
      ),
    ).toBe(true);
    const nav = await conversations();
    expect(within(nav).queryByText("Bia Souza, caio")).toBeNull();
  });
});

describe("tempo real nas DMs", () => {
  async function open(path = `/channels/@me/${ONE}`) {
    const app = await renderApp(path, { signedIn: true, seed });
    if (path.includes("@me")) await screen.findByRole("navigation", { name: "Conversas" });
    const sock = await connectGateway(app.state.guilds, "sess-1", {
      private_channels: app.state.dms,
      presences: [
        { user_id: "50", status: "online" },
        { user_id: "60", status: "idle" },
      ],
    });
    await act(async () => {});
    return { ...app, sock };
  }

  it("o READY semeia as presenças; PRESENCE_UPDATE muda os indicadores na lista e no cabeçalho", async () => {
    const { sock } = await open();
    const nav = await conversations();
    const link = within(nav).getByRole("link", { name: /Bia Souza$/ });
    expect(within(link).getByRole("img", { name: "Online" })).toBeInTheDocument();
    const header = screen.getByRole("heading", { name: "Bia Souza" }).parentElement as HTMLElement;
    expect(within(header).getAllByRole("img", { name: "Online" }).length).toBeGreaterThan(0);

    serverSends(sock, "PRESENCE_UPDATE", 2, { user_id: "50", status: "idle" });
    await waitFor(() =>
      expect(within(link).getByRole("img", { name: "Ausente" })).toBeInTheDocument(),
    );
    serverSends(sock, "PRESENCE_UPDATE", 3, { user_id: "50", status: "offline" });
    await waitFor(() =>
      expect(within(link).getByRole("img", { name: "Offline" })).toBeInTheDocument(),
    );
    expect(within(header).getByText("Offline")).toBeInTheDocument();
    // o próprio usuário aparece online para si (o snapshot não o inclui)
    expect(usePresenceStore.getState().statuses[ME]).toBe("online");
  });

  it("indicadores de presença também aparecem na lista de membros do servidor", async () => {
    const app = await renderApp("/channels/g1/g1-txt", { signedIn: true, seed });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await within(panel).findByText("bia");
    const sock = await connectGateway(app.state.guilds, "sess-1", {
      presences: [{ user_id: "50", status: "online" }],
    });
    const row = within(panel).getByText("bia").closest("li") as HTMLElement;
    await waitFor(() =>
      expect(within(row).getByRole("img", { name: "Online" })).toBeInTheDocument(),
    );
    serverSends(sock, "PRESENCE_UPDATE", 2, { user_id: "50", status: "idle" });
    await waitFor(() =>
      expect(within(row).getByRole("img", { name: "Ausente" })).toBeInTheDocument(),
    );
    const caioRow = within(panel).getByText("caio").closest("li") as HTMLElement;
    expect(within(caioRow).getByRole("img", { name: "Offline" })).toBeInTheDocument();
  });

  it("mensagem nova na DM aparece sem recarregar", async () => {
    const { sock } = await open();
    const log = await screen.findByRole("log", { name: "Mensagens de Bia Souza" });
    await within(log).findByText("mensagem 1901");
    serverSends(sock, "MESSAGE_CREATE", 2, incoming(ONE, "2100"));
    expect(await within(log).findByText("dm 2100")).toBeInTheDocument();
  });

  it("DM com mensagem nova fora de vista marca o Início e a conversa; abrir limpa e acusa leitura", async () => {
    const user = userEvent.setup();
    const { sock, state } = await open("/channels/g1/g1-txt");
    state.messages[GROUP] = [incoming(GROUP, "3100", "60")]; // o servidor já tem a mensagem ao abrir
    serverSends(sock, "MESSAGE_CREATE", 2, incoming(GROUP, "3100", "60"));
    expect(await screen.findByRole("img", { name: "Mensagens diretas novas" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Início" }));
    const nav = await conversations();
    const item = within(nav).getByRole("link", { name: /Estudo de Go/ });
    expect(within(item).getByRole("img", { name: "Mensagens novas" })).toBeInTheDocument();
    // a conversa com mensagem nova sobe para o topo
    expect(within(nav).getAllByRole("link")[0]).toBe(item);
    await user.click(item);
    await waitFor(() => expect(state.acks).toEqual([{ channelId: GROUP, messageId: "3100" }]));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "Mensagens diretas novas" })).toBeNull(),
    );
  });

  it("CHANNEL_CREATE (alguém abriu uma DM comigo) entra na lista; CHANNEL_UPDATE troca os participantes", async () => {
    const { sock } = await open("/channels/@me");
    serverSends(sock, "CHANNEL_CREATE", 2, dm("1400", [me, duda]));
    const nav = await conversations();
    expect(await within(nav).findByRole("link", { name: /duda/ })).toBeInTheDocument();
    expect(within(nav).getByText("Bia Souza, caio")).toBeInTheDocument();
    serverSends(sock, "CHANNEL_UPDATE", 3, dm(OTHER_GROUP, [me, bia], { type: 4, owner_id: "60" }));
    await waitFor(() => expect(within(nav).queryByText("Bia Souza, caio")).toBeNull());
  });

  it("CHANNEL_DELETE da conversa aberta (fui removido) avisa e volta à lista", async () => {
    const { sock, router, state } = await open(`/channels/@me/${OTHER_GROUP}`);
    state.dms = state.dms.filter((c) => c.id !== OTHER_GROUP);
    serverSends(
      sock,
      "CHANNEL_DELETE",
      2,
      dm(OTHER_GROUP, [me, bia, caio], { type: 4, owner_id: "60" }),
    );
    expect(
      await screen.findByText(/Você não está mais na conversa Bia Souza, caio\./),
    ).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/channels/@me"));
    const nav = await conversations();
    expect(within(nav).queryByRole("link", { name: /Bia Souza, caio/ })).toBeNull();
  });
});

describe('"digitando…"', () => {
  async function open() {
    const app = await renderApp(`/channels/@me/${ONE}`, { signedIn: true, seed });
    const log = await screen.findByRole("log", { name: "Mensagens de Bia Souza" });
    await within(log).findByText("mensagem 1901");
    const sock = await connectGateway(app.state.guilds, "sess-1", {
      private_channels: app.state.dms,
    });
    await act(async () => {});
    return { ...app, sock };
  }
  const indicator = () => screen.getByTestId("typing-indicator");
  const typingStart = (userId: string) => ({
    channel_id: ONE,
    guild_id: null,
    user_id: userId,
    timestamp: 1,
  });

  it("aparece com o nome de quem digita, ignora o meu próprio evento e some quando a pessoa envia", async () => {
    const { sock } = await open();
    expect(indicator()).toBeEmptyDOMElement();
    serverSends(sock, "TYPING_START", 2, typingStart(ME));
    expect(indicator()).toBeEmptyDOMElement();
    serverSends(sock, "TYPING_START", 3, typingStart("50"));
    await waitFor(() => expect(indicator()).toHaveTextContent("Bia Souza está digitando…"));
    serverSends(sock, "MESSAGE_CREATE", 4, incoming(ONE, "2200", "50"));
    await waitFor(() => expect(indicator()).toBeEmptyDOMElement());
  });

  it("expira 8 s depois do último evento (um novo evento renova)", async () => {
    const { sock } = await open();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      serverSends(sock, "TYPING_START", 2, typingStart("50"));
      expect(indicator()).toHaveTextContent("Bia Souza está digitando…");
      act(() => vi.advanceTimersByTime(6000));
      serverSends(sock, "TYPING_START", 3, typingStart("50"));
      act(() => vi.advanceTimersByTime(6000)); // 12 s desde o primeiro, 6 s desde o segundo
      expect(indicator()).toHaveTextContent("está digitando");
      act(() => vi.advanceTimersByTime(2000));
      expect(indicator()).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });

  it("digitar no composer avisa o servidor no máximo uma vez a cada 3 s e não ao apagar", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    const box = screen.getByLabelText("Mensagem para Bia Souza");
    await user.type(box, "olá, tudo bem?");
    expect(state.typing).toEqual([ONE]);
    await user.clear(box);
    expect(state.typing).toEqual([ONE]);
    // enviar zera o intervalo, mas o texto vazio não avisa
    await user.type(box, "x{Enter}");
    await screen.findByText("x");
    expect(state.typing.length).toBeLessThanOrEqual(2);
  });
});
