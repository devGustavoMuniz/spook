import { type MessagePayload, Permission } from "@spook/shared";
import type { FakeSocket } from "@spook/shared/testing";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationPrefs } from "@/features/notifications/prefs";
import { useReadStateStore } from "@/features/notifications/read-state";
import { resetAckMemory } from "@/features/notifications/use-auto-ack";
import { channel, dm, guild, ME, member, messages, recipient } from "@/test/fixtures";
import { connectGateway, serverSends } from "@/test/gateway";
import { fakeSubscription, stubPush } from "@/test/push";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";

const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;
const GEN = "g1-txt"; // geral
const DEV = "g1-dev"; // dev
const DM1 = "1100";
const me = recipient(ME, "ana");
const bia = recipient("50", "bia", "Bia Souza");

function seed(s: Backend["state"]) {
  s.guilds.push(
    guild("g1", "Alfa", {
      permissions: BASE,
      channels: [
        channel("g1-cat", "Canais", 0, 2),
        { ...channel(GEN, "geral", 1, 0, "g1-cat"), guild_id: "g1" },
        { ...channel(DEV, "dev", 2, 0, "g1-cat"), guild_id: "g1" },
      ],
    }),
  );
  s.members.g1 = [member(ME, "ana"), member("50", "bia")];
  s.dms = [dm(DM1, [me, bia], { last_message_id: "1901" })];
  s.messages[GEN] = messages(GEN, 2, 1000);
  s.messages[DEV] = messages(DEV, 3, 2000);
  s.messages[DM1] = messages(DM1, 2, 1900);
}

const msg = (
  channelId: string,
  id: string,
  extra: Partial<MessagePayload> = {},
): MessagePayload => ({
  id,
  channel_id: channelId,
  author: { id: "50", username: "bia" },
  content: `texto ${id}`,
  edited_at: null,
  created_at: "2026-10-31T12:00:00Z",
  attachments: [],
  mention_ids: [],
  ...extra,
});

const rs = (channel_id: string, extra: Record<string, unknown> = {}) => ({
  channel_id,
  guild_id: "g1",
  last_read_message_id: "1000",
  mention_count: 0,
  unread_count: 0,
  ...extra,
});

async function open(
  path: string,
  read_states: ReturnType<typeof rs>[] = [],
  extra: Partial<Parameters<typeof connectGateway>[2]> = {},
) {
  const app = await renderApp(path, { signedIn: true, seed });
  await screen.findByRole("navigation", { name: "Servidores" });
  const sock = await connectGateway(app.state.guilds, "sess-1", {
    private_channels: app.state.dms,
    read_states,
    ...extra,
  });
  await act(async () => {});
  return { ...app, sock };
}

const rail = () => screen.getByRole("navigation", { name: "Servidores" });
const channels = () => screen.findByRole("navigation", { name: "Canais" });

beforeEach(() => {
  useReadStateStore.getState().reset();
  useNotificationPrefs.getState().setMuted(false);
  resetAckMemory();
});

describe("indicadores de não lidas", () => {
  it("READY mostra o negrito/ponto nos canais, o contador de menções, o badge do servidor e o título", async () => {
    await open(`/channels/g1/${GEN}`, [
      rs(DEV, { unread_count: 4, mention_count: 2, last_read_message_id: "2000" }),
      rs(DM1, {
        guild_id: undefined,
        unread_count: 3,
        mention_count: 3,
        last_read_message_id: "1900",
      }),
    ]);
    const nav = await channels();
    const dev = within(nav).getByRole("link", { name: /dev/ });
    expect(within(dev).getByRole("img", { name: "2 menções em #dev" })).toBeInTheDocument();
    expect(dev.className).toContain("font-semibold");
    // servidor: badge de menções (a soma do servidor, sem as DMs)
    expect(within(rail()).getByRole("img", { name: "2 menções em Alfa" })).toBeInTheDocument();
    // Início: DMs entram como menções
    expect(
      within(rail()).getByRole("img", { name: "3 mensagens diretas não lidas" }),
    ).toBeInTheDocument();
    // título da aba: menções + DMs
    await waitFor(() => expect(document.title).toBe("(5) Spook"));
  });

  it("não lidas sem menção mostram só o ponto; sem nada, nenhum indicador", async () => {
    await open(`/channels/g1/${GEN}`, [rs(DEV, { unread_count: 1, last_read_message_id: "2000" })]);
    const nav = await channels();
    expect(within(nav).getByRole("img", { name: "Mensagens novas em #dev" })).toBeInTheDocument();
    expect(within(nav).queryByRole("img", { name: /em #geral/ })).toBeNull();
    expect(within(rail()).queryByRole("img", { name: /menções/ })).toBeNull();
    expect(document.title).toBe("Spook");
  });

  it("teto: mais de 99 vira 99+", async () => {
    await open(`/channels/g1/${GEN}`, [
      rs(DEV, { mention_count: 150, unread_count: 100, last_read_message_id: "2000" }),
    ]);
    const nav = await channels();
    expect(within(nav).getByRole("img", { name: "99+ menções em #dev" })).toBeInTheDocument();
    expect(within(rail()).getByRole("img", { name: "99+ menções em Alfa" })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("(99+) Spook"));
  });

  it("MESSAGE_CREATE em canal fora de vista incrementa; READ_STATE_UPDATE traz as menções", async () => {
    const { sock } = await open(`/channels/g1/${GEN}`);
    const nav = await channels();
    serverSends(sock, "MESSAGE_CREATE", 2, msg(DEV, "2100"));
    expect(
      await within(nav).findByRole("img", { name: "Mensagens novas em #dev" }),
    ).toBeInTheDocument();
    expect(useReadStateStore.getState().channels[DEV]?.unread).toBe(1);
    serverSends(sock, "MESSAGE_CREATE", 3, msg(DEV, "2101", { mention_ids: [ME] }));
    serverSends(sock, "READ_STATE_UPDATE", 4, {
      channel_id: DEV,
      last_read_message_id: "2000",
      mention_count: 1,
    });
    expect(await within(nav).findByRole("img", { name: "1 menção em #dev" })).toBeInTheDocument();
    expect(useReadStateStore.getState().channels[DEV]?.unread).toBe(2);
    expect(within(rail()).getByRole("img", { name: "1 menção em Alfa" })).toBeInTheDocument();
  });

  it("READ_STATE_UPDATE de outra sessão (ack) limpa o badge", async () => {
    const { sock } = await open(`/channels/g1/${GEN}`, [
      rs(DEV, { unread_count: 1, mention_count: 1, last_read_message_id: "2000" }),
    ]);
    const nav = await channels();
    serverSends(sock, "MESSAGE_CREATE", 2, msg(DEV, "2100"));
    expect(await within(nav).findByRole("img", { name: "1 menção em #dev" })).toBeInTheDocument();
    serverSends(sock, "READ_STATE_UPDATE", 3, {
      channel_id: DEV,
      last_read_message_id: "2100",
      mention_count: 0,
    });
    await waitFor(() => expect(within(nav).queryByRole("img", { name: /em #dev/ })).toBeNull());
    expect(within(rail()).queryByRole("img", { name: /em Alfa/ })).toBeNull();
  });

  it("reconexão com buraco refaz o snapshot pelo GET e reconcilia", async () => {
    const { sock, state } = await open(`/channels/g1/${GEN}`, [
      rs(DEV, { unread_count: 1, last_read_message_id: "2000" }),
    ]);
    const nav = await channels();
    expect(
      await within(nav).findByRole("img", { name: "Mensagens novas em #dev" }),
    ).toBeInTheDocument();
    state.readStates = [
      rs(DEV, { unread_count: 7, mention_count: 2, last_read_message_id: "2000" }),
    ];
    act(() => sock.serverClose(1006));
    await waitFor(() => expect(sock.constructor).toBeDefined());
    // sessão nova (READY depois de uma anterior) = onInvalidated
    const { FakeSocket } = await import("@spook/shared/testing");
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3_000 });
    const next = FakeSocket.last as FakeSocket;
    act(() => {
      next.hello();
      next.receive({ op: 9, d: false });
      next.dispatch("READY", 1, {
        session_id: "sess-2",
        user: { id: ME },
        guilds: state.guilds,
        read_states: [],
      });
    });
    expect(await within(nav).findByRole("img", { name: "2 menções em #dev" })).toBeInTheDocument();
    expect(state.requests.some((r) => r.path === "/api/users/@me/read-states")).toBe(true);
  });
});

describe("marcar como lido", () => {
  it("abrir o canal acusa leitura da última mensagem uma vez só e limpa o badge", async () => {
    const user = userEvent.setup();
    const { state } = await open(`/channels/g1/${GEN}`, [
      rs(DEV, { unread_count: 3, mention_count: 1, last_read_message_id: "2000" }),
    ]);
    const nav = await channels();
    expect(await within(nav).findByRole("img", { name: "1 menção em #dev" })).toBeInTheDocument();
    await user.click(within(nav).getByRole("link", { name: /dev/ }));
    await waitFor(() => expect(state.acks).toEqual([{ channelId: DEV, messageId: "2002" }]));
    await waitFor(() => expect(within(nav).queryByRole("img", { name: /em #dev/ })).toBeNull());
    await act(async () => new Promise((r) => setTimeout(r, 700)));
    expect(state.acks).toHaveLength(1); // sem acks redundantes
  });

  it("canal sem nada a limpar não acusa nada ao abrir", async () => {
    const { state } = await open(`/channels/g1/${GEN}`);
    await screen.findByRole("log", { name: "Mensagens de geral" });
    await act(async () => new Promise((r) => setTimeout(r, 700)));
    expect(state.acks).toHaveLength(0);
  });

  it("mensagem que chega com o canal aberto e no fim é acusada, sem aparecer como não lida", async () => {
    const { sock, state } = await open(`/channels/g1/${GEN}`);
    const list = await screen.findByRole("log", { name: "Mensagens de geral" });
    await within(list).findByText("mensagem 1001");
    // dá tempo de a lista reportar que está no fim
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    const novo = msg(GEN, "1100");
    state.messages[GEN] = [...(state.messages[GEN] ?? []), novo];
    serverSends(sock, "MESSAGE_CREATE", 2, novo);
    expect(await within(list).findByText("texto 1100")).toBeInTheDocument();
    expect(useReadStateStore.getState().channels[GEN]?.unread ?? 0).toBe(0);
    await waitFor(() => expect(state.acks).toEqual([{ channelId: GEN, messageId: "1100" }]));
  });

  it("aba sem foco: a mensagem conta como não lida e não é acusada até voltar", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      const { sock, state } = await open(`/channels/g1/${GEN}`);
      const list = await screen.findByRole("log", { name: "Mensagens de geral" });
      await within(list).findByText("mensagem 1001");
      const novo = msg(GEN, "1100");
      state.messages[GEN] = [...(state.messages[GEN] ?? []), novo];
      serverSends(sock, "MESSAGE_CREATE", 2, novo);
      await within(list).findByText("texto 1100");
      expect(useReadStateStore.getState().channels[GEN]?.unread).toBe(1);
      await act(async () => new Promise((r) => setTimeout(r, 700)));
      expect(state.acks).toHaveLength(0);
      focus.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(state.acks).toEqual([{ channelId: GEN, messageId: "1100" }]));
    } finally {
      focus.mockRestore();
    }
  });

  it("separador 'Novas mensagens' fica antes da primeira não lida ao abrir o canal", async () => {
    const { state } = await open(`/channels/g1/${DEV}`, [
      rs(DEV, { unread_count: 2, last_read_message_id: "2000" }),
    ]);
    const list = await screen.findByRole("log", { name: "Mensagens de dev" });
    await within(list).findByText("mensagem 2002");
    const sep = within(list).getByText("Novas mensagens");
    const article = sep.closest("article") as HTMLElement;
    expect(within(article).getByText("mensagem 2001")).toBeInTheDocument();
    expect(state.acks.length).toBeLessThanOrEqual(1);
  });
});

describe("menções e avisos", () => {
  it("mensagem que cita o usuário ganha destaque e o @username é marcado", async () => {
    const { sock, state } = await open(`/channels/g1/${GEN}`);
    const list = await screen.findByRole("log", { name: "Mensagens de geral" });
    await within(list).findByText("mensagem 1001");
    const m = msg(GEN, "1100", { content: "oi @ana, tudo bem? (ana@x.com)", mention_ids: [ME] });
    state.messages[GEN] = [...(state.messages[GEN] ?? []), m];
    serverSends(sock, "MESSAGE_CREATE", 2, m);
    const text = await within(list).findByText(/tudo bem\?/);
    const article = text.closest("article") as HTMLElement;
    expect(article).toHaveAttribute("data-mention", "true");
    expect(within(article).getByText("@ana").tagName).toBe("MARK");
    expect(
      within(article)
        .getAllByText(/@/)
        .filter((e) => e.tagName === "MARK"),
    ).toHaveLength(1);
    // mensagem sem menção: sem destaque
    expect(within(list).getByText("mensagem 1000").closest("article")).not.toHaveAttribute(
      "data-mention",
    );
  });

  it("DM em canal que não está aberto gera toast que leva à conversa", async () => {
    const user = userEvent.setup();
    const { sock, router } = await open(`/channels/g1/${GEN}`);
    serverSends(sock, "MESSAGE_CREATE", 2, msg(DM1, "2000", { content: "ei, tem um minuto?" }));
    expect(await screen.findByText("ei, tem um minuto?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abrir" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/channels/@me/${DM1}`));
  });

  it("silenciar notificações tira o toast, mas a contagem de não lidas segue", async () => {
    useNotificationPrefs.getState().setMuted(true);
    const { sock } = await open(`/channels/g1/${GEN}`);
    serverSends(sock, "MESSAGE_CREATE", 2, msg(DM1, "2000", { content: "sem aviso" }));
    await waitFor(() => expect(useReadStateStore.getState().channels[DM1]?.unread).toBe(1));
    expect(screen.queryByText("sem aviso")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abrir" })).toBeNull();
  });

  it("menção em canal de servidor fora de vista gera toast; mensagem comum não", async () => {
    const { sock } = await open(`/channels/g1/${GEN}`);
    serverSends(sock, "MESSAGE_CREATE", 2, msg(DEV, "2100", { content: "papo qualquer" }));
    serverSends(
      sock,
      "MESSAGE_CREATE",
      3,
      msg(DEV, "2101", { content: "e aí @ana?", mention_ids: [ME] }),
    );
    expect(await screen.findByText("bia (#dev · Alfa)")).toBeInTheDocument();
    expect(screen.getByText("e aí @ana?")).toBeInTheDocument();
    expect(screen.queryByText("papo qualquer")).toBeNull();
  });

  it("não avisa da conversa que já está aberta e à vista", async () => {
    const { sock } = await open(`/channels/@me/${DM1}`);
    const list = await screen.findByRole("log", { name: /Mensagens de/ });
    await within(list).findByText("mensagem 1901");
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    serverSends(sock, "MESSAGE_CREATE", 2, msg(DM1, "2000", { content: "dentro da conversa" }));
    await within(list).findByText("dentro da conversa");
    expect(screen.queryByRole("button", { name: "Abrir" })).toBeNull();
  });
});

describe("anexos pelo gateway", () => {
  it("MESSAGE_UPDATE com thumbnail troca a imagem na mesma mensagem", async () => {
    const { sock, state } = await open(`/channels/g1/${GEN}`);
    const list = await screen.findByRole("log", { name: "Mensagens de geral" });
    await within(list).findByText("mensagem 1001");
    const att = {
      id: "a1",
      filename: "foto.png",
      content_type: "image/png",
      size: 4000,
      url: "https://s.test/orig/a1",
    };
    const created = msg(GEN, "1100", { content: "", attachments: [att] });
    state.messages[GEN] = [...(state.messages[GEN] ?? []), created];
    serverSends(sock, "MESSAGE_CREATE", 2, created);
    const img = await within(list).findByRole("img", { name: "foto.png" });
    expect(img).toHaveAttribute("src", "https://s.test/orig/a1");

    const updated = {
      ...created,
      attachments: [{ ...att, thumbnail_url: "https://s.test/th/a1", width: 800, height: 600 }],
    };
    serverSends(sock, "MESSAGE_UPDATE", 3, updated);
    await waitFor(() =>
      expect(within(list).getByRole("img", { name: "foto.png" })).toHaveAttribute(
        "src",
        "https://s.test/th/a1",
      ),
    );
    expect(within(list).getAllByRole("article")).toHaveLength(3);
  });
});

describe("configurações de notificação", () => {
  let browser: ReturnType<typeof stubPush> | undefined;
  afterEach(() => browser?.restore());

  it("silenciar notificações persiste neste navegador", async () => {
    const user = userEvent.setup();
    await open("/settings/notifications");
    const sw = await screen.findByRole("switch", { name: /Silenciar notificações/ });
    expect(sw).not.toBeChecked();
    await user.click(sw);
    expect(sw).toBeChecked();
    expect(useNotificationPrefs.getState().muted).toBe(true);
    expect(localStorage.getItem("spook.notifications.muted")).toBe("1");
  });

  it("ativar push: só por clique, pede permissão, inscreve e mostra o estado; desativar desfaz", async () => {
    const user = userEvent.setup();
    browser = stubPush();
    const { state } = await open("/settings/notifications");
    expect(await screen.findByText("Desativadas neste dispositivo.")).toBeInTheDocument();
    expect(browser.requestPermission).not.toHaveBeenCalled(); // nada de pedir permissão sozinho
    await user.click(screen.getByRole("button", { name: "Ativar notificações" }));
    expect(await screen.findByText("Ativas neste dispositivo.")).toBeInTheDocument();
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    expect(state.push.subscribed).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Desativar notificações" }));
    expect(await screen.findByText("Desativadas neste dispositivo.")).toBeInTheDocument();
    expect(state.push.unsubscribed).toEqual(["https://push.test/abc"]);
  });

  it("estados: bloqueado, sem suporte, precisa instalar (iOS) e desligado pelo servidor", async () => {
    browser = stubPush({ permission: "denied" });
    await open("/settings/notifications");
    expect(await screen.findByText(/bloqueadas para este site/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ativar notificações" })).toBeNull();
  });

  it("sem suporte no navegador", async () => {
    browser = stubPush({ serviceWorker: false });
    await open("/settings/notifications");
    expect(await screen.findByText(/não oferece notificações push/)).toBeInTheDocument();
  });

  it("iPhone fora do app instalado explica como instalar", async () => {
    browser = stubPush({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    await open("/settings/notifications");
    expect(await screen.findByText(/Adicionar à Tela de Início/)).toBeInTheDocument();
  });

  it("servidor sem VAPID (503)", async () => {
    browser = stubPush();
    const app = await renderApp("/settings/notifications", {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.push.publicKey = null;
      },
    });
    await connectGateway(app.state.guilds);
    expect(
      await screen.findByText("As notificações push estão desligadas neste servidor."),
    ).toBeInTheDocument();
  });

  it("erro do servidor ao inscrever (409) aparece e o estado segue 'desativado'", async () => {
    const user = userEvent.setup();
    browser = stubPush();
    const { state } = await open("/settings/notifications");
    state.push.subscribeStatus = 409;
    await user.click(await screen.findByRole("button", { name: "Ativar notificações" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/10 dispositivos/);
    expect(screen.getByText("Desativadas neste dispositivo.")).toBeInTheDocument();
  });

  it("entrar no app reenvia a inscrição que o navegador já tem", async () => {
    browser = stubPush({
      permission: "granted",
      subscription: fakeSubscription("https://push.test/ja"),
    });
    const { state } = await open(`/channels/g1/${GEN}`);
    await waitFor(() =>
      expect(state.push.subscribed.map((s) => s.endpoint)).toEqual(["https://push.test/ja"]),
    );
  });
});
