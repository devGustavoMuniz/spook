import { Permission } from "@spook/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { dm, guild, ME, member, messages, recipient } from "@/test/fixtures";
import { connectGateway, serverSends } from "@/test/gateway";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";

const CH = "g1-txt";
const path = `/channels/g1/${CH}`;
const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;

function seed(opts: { count?: number; permissions?: number; authorId?: string } = {}) {
  return (s: Backend["state"]) => {
    s.guilds.push(guild("g1", "Alfa", { permissions: opts.permissions ?? BASE }));
    s.members.g1 = [member(ME, "ana"), member("50", "bia")];
    s.messages[CH] = messages(CH, opts.count ?? 3, 1000, opts.authorId);
  };
}

const log = () => screen.findByRole("log", { name: "Mensagens de geral" });
const postBodies = (state: Backend["state"]) =>
  state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages"));

/** O botão "Responder" da mensagem com este texto. */
async function replyButton(text: string) {
  const list = await log();
  const row = (await within(list).findByText(text)).closest("article") as HTMLElement;
  return within(row).getByRole("button", { name: "Responder" });
}

describe("responder", () => {
  it("barra 'Respondendo a', envia reply_to + mention_reply e mostra a citação acima da resposta", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: seed() });
    await user.click(await replyButton("mensagem 1001"));

    const bar = await screen.findByRole("group", { name: "Respondendo a bia" });
    expect(within(bar).getByText(/mensagem 1001/)).toBeInTheDocument();
    expect(screen.getByLabelText("Mensagem em #geral")).toHaveFocus();
    expect(within(bar).getByRole("button", { name: "Mencionar bia" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.type(screen.getByLabelText("Mensagem em #geral"), "concordo{Enter}");
    const list = await log();
    expect(await within(list).findByText("concordo")).toBeInTheDocument();
    expect(postBodies(state)[0]?.body).toEqual({
      content: "concordo",
      reply_to: "1001",
      mention_reply: true,
    });
    // citação acima da resposta: autor + trecho, clicável
    const quote = within(list).getByRole("button", { name: /Ir para a mensagem original de bia/ });
    expect(quote).toHaveTextContent("@bia");
    expect(quote).toHaveTextContent("mensagem 1001");
    // a barra some depois do envio
    expect(screen.queryByRole("group", { name: /Respondendo a/ })).not.toBeInTheDocument();
  });

  it("o interruptor de @ desliga a menção (mention_reply: false)", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: seed() });
    await user.click(await replyButton("mensagem 1000"));
    const toggle = await screen.findByRole("button", { name: "Mencionar bia" });
    expect(toggle).toHaveTextContent("ativado");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("desativado");
    await user.type(screen.getByLabelText("Mensagem em #geral"), "ok{Enter}");
    await waitFor(() => expect(postBodies(state)).toHaveLength(1));
    expect(postBodies(state)[0]?.body).toMatchObject({ reply_to: "1000", mention_reply: false });
  });

  it("Esc e o botão cancelam a resposta; sem resposta não manda reply_to", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: seed() });
    await user.click(await replyButton("mensagem 1000"));
    await screen.findByRole("group", { name: "Respondendo a bia" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /Respondendo a/ })).not.toBeInTheDocument();

    await user.click(await replyButton("mensagem 1002"));
    await user.click(await screen.findByRole("button", { name: "Cancelar resposta" }));
    expect(screen.queryByRole("group", { name: /Respondendo a/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Mensagem em #geral")).toHaveFocus();

    await user.type(screen.getByLabelText("Mensagem em #geral"), "solta{Enter}");
    await waitFor(() => expect(postBodies(state)).toHaveLength(1));
    expect(postBodies(state)[0]?.body).toEqual({ content: "solta" });
  });

  it("atalho R com a mensagem focada responde", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const list = await log();
    const row = (await within(list).findByText("mensagem 1001")).closest("article") as HTMLElement;
    row.focus();
    await user.keyboard("r");
    expect(await screen.findByRole("group", { name: "Respondendo a bia" })).toBeInTheDocument();
  });

  it("responder a si mesmo não oferece o interruptor de menção", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed({ authorId: ME }) });
    await user.click(await replyButton("mensagem 1000"));
    const bar = await screen.findByRole("group", { name: "Respondendo a ana" });
    expect(within(bar).queryByRole("button", { name: /Mencionar/ })).not.toBeInTheDocument();
  });

  it("422 (original apagada): mostra o motivo do servidor e cancela a resposta, mantendo o texto", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: seed() });
    await user.click(await replyButton("mensagem 1000"));
    // a original some no servidor antes do envio
    state.messages[CH] = (state.messages[CH] ?? []).filter((m) => m.id !== "1000");
    await user.type(screen.getByLabelText("Mensagem em #geral"), "e aí{Enter}");
    expect(await screen.findByText(/mensagem respondida não existe mais/i)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Respondendo a/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Mensagem em #geral")).toHaveValue("e aí");
  });

  it("sem SEND_MESSAGES não há ação de responder", async () => {
    await renderApp(path, { signedIn: true, seed: seed({ permissions: Permission.VIEW_CHANNEL }) });
    const list = await log();
    await within(list).findByText("mensagem 1000");
    expect(within(list).queryByRole("button", { name: "Responder" })).not.toBeInTheDocument();
  });

  it("citação de mensagem apagada mostra 'Mensagem original apagada' (sem link)", async () => {
    await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed({ count: 1 })(s);
        s.messages[CH] = [
          {
            ...messages(CH, 1, 2000)[0],
            id: "2000",
            reply_to: {
              id: "1",
              author: { id: "50", username: "bia" },
              content: "",
              has_attachments: false,
              deleted: true,
            },
          } as never,
        ];
      },
    });
    const list = await log();
    expect(await within(list).findByText("Mensagem original apagada")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Ir para a mensagem original/ })).toBeNull();
  });

  it("clicar na citação rola até a original que está no cache e a destaca", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed({ count: 3 })(s);
        s.messages[CH] = [
          ...(s.messages[CH] ?? []),
          {
            ...messages(CH, 1, 1100)[0],
            reply_to: {
              id: "1000",
              author: { id: "50", username: "bia" },
              content: "mensagem 1000",
              has_attachments: false,
              deleted: false,
            },
          } as never,
        ];
      },
    });
    const list = await log();
    await user.click(
      await within(list).findByRole("button", { name: /Ir para a mensagem original de bia/ }),
    );
    // "mensagem 1000" aparece também na citação: o parágrafo é o texto da própria mensagem
    const text = within(list)
      .getAllByText("mensagem 1000")
      .find((el) => el.tagName === "P") as HTMLElement;
    await waitFor(() => expect(text.closest("article")).toHaveAttribute("data-highlighted"));
  });

  it("se a original está em páginas anteriores, carrega até achar e destaca", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed({ count: 130 })(s); // 1000..1129: a primeira página traz 1080..1129
        s.messages[CH] = [
          ...(s.messages[CH] ?? []),
          {
            ...messages(CH, 1, 1500)[0],
            reply_to: {
              id: "1010",
              author: { id: "50", username: "bia" },
              content: "mensagem 1010",
              has_attachments: false,
              deleted: false,
            },
          } as never,
        ];
      },
    });
    const list = await log();
    await user.click(
      await within(list).findByRole("button", { name: /Ir para a mensagem original de bia/ }),
    );
    await waitFor(() => {
      const gets = state.requests.filter((r) => r.path.endsWith(`/${CH}/messages`));
      expect(gets.length).toBeGreaterThanOrEqual(3); // 1ª página + 2 anteriores
    });
    await waitFor(() => {
      const text = within(list)
        .getAllByText("mensagem 1010")
        .find((el) => el.tagName === "P") as HTMLElement;
      expect(text.closest("article")).toHaveAttribute("data-highlighted");
    });
  });

  it("original fora do histórico: avisa em vez de rolar", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed({ count: 2 })(s);
        s.messages[CH] = [
          ...(s.messages[CH] ?? []),
          {
            ...messages(CH, 1, 1500)[0],
            reply_to: {
              id: "3",
              author: { id: "50", username: "bia" },
              content: "antiga",
              has_attachments: false,
              deleted: false,
            },
          } as never,
        ];
      },
    });
    const list = await log();
    await user.click(
      await within(list).findByRole("button", { name: /Ir para a mensagem original de bia/ }),
    );
    expect(await screen.findByText(/fora do histórico carregado/)).toBeInTheDocument();
  });

  it("funciona numa DM (barra e citação)", async () => {
    const user = userEvent.setup();
    const bia = recipient("50", "bia", "Bia Souza");
    const { state } = await renderApp("/channels/@me/1100", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(guild("g1", "Alfa", { permissions: BASE }));
        s.dms = [dm("1100", [recipient(ME, "ana"), bia])];
        s.messages["1100"] = messages("1100", 2, 1900, "50");
      },
    });
    const dmLog = await screen.findByRole("log", { name: "Mensagens de Bia Souza" });
    const row = (await within(dmLog).findByText("mensagem 1901")).closest("article") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Responder" }));
    expect(await screen.findByRole("group", { name: "Respondendo a bia" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Mensagem para Bia Souza"), "fechado{Enter}");
    expect(await within(dmLog).findByText("fechado")).toBeInTheDocument();
    expect(postBodies(state)[0]?.body).toMatchObject({ reply_to: "1901" });
  });
});

describe("editar a última com ↑", () => {
  it("campo vazio + ↑ abre a edição da última mensagem própria; Esc cancela e devolve o foco", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed({ count: 2 })(s);
        // 1000 e 1001 da bia; 1002 e 1003 minhas; a última da bia vem depois
        s.messages[CH] = [...messages(CH, 2, 1000, ME), ...messages(CH, 1, 1002, "50")];
      },
    });
    const list = await log();
    await within(list).findByText("mensagem 1002");
    const box = screen.getByLabelText("Mensagem em #geral");
    await user.click(box);
    await user.keyboard("{ArrowUp}");
    const edit = await within(list).findByRole("textbox", { name: "Editar mensagem" });
    expect(edit).toHaveValue("mensagem 1001"); // a mais recente DELE, não a última do canal
    await user.keyboard("{Escape}");
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
    await waitFor(() => expect(box).toHaveFocus());
  });

  it("Enter salva a edição aberta com ↑", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: seed({ authorId: ME }) });
    const list = await log();
    await within(list).findByText("mensagem 1002");
    await user.click(screen.getByLabelText("Mensagem em #geral"));
    await user.keyboard("{ArrowUp}");
    const edit = await within(list).findByRole("textbox", { name: "Editar mensagem" });
    await user.clear(edit);
    await user.type(edit, "corrigida{Enter}");
    expect(await within(list).findByText(/corrigida/)).toBeInTheDocument();
    expect(state.requests.find((r) => r.method === "PATCH")?.path).toMatch(/messages\/1002$/);
  });

  it("não dispara com texto digitado, com Shift/Ctrl, nem sem mensagem própria", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() }); // só mensagens da bia
    const list = await log();
    await within(list).findByText("mensagem 1002");
    const box = screen.getByLabelText("Mensagem em #geral");
    await user.click(box);
    await user.keyboard("{ArrowUp}");
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("com texto no campo, ↑ não abre edição", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed({ authorId: ME }) });
    const list = await log();
    await within(list).findByText("mensagem 1002");
    const box = screen.getByLabelText("Mensagem em #geral");
    await user.type(box, "rascunho{ArrowUp}");
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
    expect(box).toHaveValue("rascunho");
  });

  it("não dispara durante composição (IME)", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed({ authorId: ME }) });
    const list = await log();
    await within(list).findByText("mensagem 1002");
    const box = screen.getByLabelText("Mensagem em #geral");
    await user.click(box);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.keyDown(box, { key: "ArrowUp", isComposing: true });
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.keyDown(box, { key: "ArrowUp", shiftKey: true });
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("fixar", () => {
  const withManage = BASE | Permission.MANAGE_MESSAGES;

  it("sem MANAGE_MESSAGES não há ação de fixar (mas o painel abre)", async () => {
    await renderApp(path, { signedIn: true, seed: seed({ count: 1 }) });
    const list = await log();
    await within(list).findByText("mensagem 1000");
    expect(within(list).queryByRole("button", { name: /Fixar mensagem/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mensagens fixadas" })).toBeInTheDocument();
  });

  it("com permissão: fixa (PUT), mostra o alfinete e desafixa (DELETE)", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, {
      signedIn: true,
      seed: seed({ count: 2, permissions: withManage }),
    });
    const list = await log();
    const row = (await within(list).findByText("mensagem 1000")).closest("article") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Fixar mensagem" }));
    expect(await within(row).findByRole("img", { name: "Mensagem fixada" })).toBeInTheDocument();
    expect(state.requests.some((r) => r.method === "PUT" && r.path.endsWith("/pins/1000"))).toBe(
      true,
    );
    expect(await screen.findByText("Mensagem fixada.")).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "Desafixar mensagem" }));
    await waitFor(() =>
      expect(within(row).queryByRole("img", { name: "Mensagem fixada" })).not.toBeInTheDocument(),
    );
    expect(state.requests.some((r) => r.method === "DELETE" && r.path.endsWith("/pins/1000"))).toBe(
      true,
    );
  });

  it("erros 403, 409 (limite) e 404 aparecem em pt-br", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, {
      signedIn: true,
      seed: seed({ count: 1, permissions: withManage }),
    });
    const list = await log();
    const row = (await within(list).findByText("mensagem 1000")).closest("article") as HTMLElement;
    state.pinError = { status: 403, detail: "sem permissão" };
    await user.click(within(row).getByRole("button", { name: "Fixar mensagem" }));
    expect(await screen.findByText("Você não tem permissão para fazer isso.")).toBeInTheDocument();
    state.pinError = { status: 409, detail: "este canal já tem 50 mensagens fixadas" };
    await user.click(within(row).getByRole("button", { name: "Fixar mensagem" }));
    expect(await screen.findByText(/Este canal já tem 50 mensagens fixadas/)).toBeInTheDocument();
    state.pinError = { status: 404, detail: "x" };
    await user.click(within(row).getByRole("button", { name: "Fixar mensagem" }));
    expect(await screen.findByText(/Não encontramos isso/)).toBeInTheDocument();
    expect(within(row).queryByRole("img", { name: "Mensagem fixada" })).not.toBeInTheDocument();
  });

  it("painel de fixadas: lista (mais recente primeiro), vazio, ir até a mensagem e desafixar", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed({ count: 3, permissions: withManage })(s);
        s.messages[CH] = (s.messages[CH] ?? []).map((m) =>
          m.id === "1000" || m.id === "1002" ? { ...m, pinned: true } : m,
        );
        s.pins[CH] = ["1002", "1000"];
      },
    });
    const list = await log();
    await within(list).findByText("mensagem 1001");
    await user.click(screen.getByRole("button", { name: "Mensagens fixadas" }));
    const panel = await screen.findByRole("dialog", { name: "Mensagens fixadas" });
    const items = await within(panel).findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("mensagem 1002");
    expect(items[1]).toHaveTextContent("mensagem 1000");

    // desafixar pelo painel
    await user.click(within(items[1] as HTMLElement).getByRole("button", { name: /Desafixar/ }));
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(1));
    expect(state.requests.some((r) => r.method === "DELETE" && r.path.endsWith("/pins/1000"))).toBe(
      true,
    );

    // ir até a mensagem: fecha o painel e destaca a linha
    await user.click(within(panel).getByRole("button", { name: /Ir para a mensagem de/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const target = within(list).getByText("mensagem 1002").closest("article") as HTMLElement;
    await waitFor(() => expect(target).toHaveAttribute("data-highlighted"));

    // sem fixadas: mensagem vazia
    await user.click(screen.getByRole("button", { name: "Mensagens fixadas" }));
    const again = await screen.findByRole("dialog", { name: "Mensagens fixadas" });
    await user.click(await within(again).findByRole("button", { name: /Desafixar/ }));
    expect(await within(again).findByText(/Nenhuma mensagem fixada/)).toBeInTheDocument();
  });

  it("sem permissão o painel lista mas não oferece desafixar", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        seed({ count: 2 })(s);
        s.messages[CH] = (s.messages[CH] ?? []).map((m) =>
          m.id === "1001" ? { ...m, pinned: true } : m,
        );
        s.pins[CH] = ["1001"];
      },
    });
    await user.click(await screen.findByRole("button", { name: "Mensagens fixadas" }));
    const panel = await screen.findByRole("dialog", { name: "Mensagens fixadas" });
    expect(await within(panel).findByText("mensagem 1001")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /Desafixar/ })).not.toBeInTheDocument();
  });

  it("numa DM qualquer participante fixa", async () => {
    const user = userEvent.setup();
    const bia = recipient("50", "bia", "Bia Souza");
    const { state } = await renderApp("/channels/@me/1100", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(guild("g1", "Alfa", { permissions: BASE }));
        s.dms = [dm("1100", [recipient(ME, "ana"), bia])];
        s.messages["1100"] = messages("1100", 2, 1900, "50");
      },
    });
    const dmLog = await screen.findByRole("log", { name: "Mensagens de Bia Souza" });
    const row = (await within(dmLog).findByText("mensagem 1900")).closest("article") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Fixar mensagem" }));
    expect(await within(row).findByRole("img", { name: "Mensagem fixada" })).toBeInTheDocument();
    expect(
      state.requests.some((r) => r.method === "PUT" && r.path.includes("/1100/pins/1900")),
    ).toBe(true);
  });
});

describe("fixadas e respostas pelo gateway", () => {
  async function open() {
    const app = await renderApp(path, { signedIn: true, seed: seed({ count: 3 }) });
    const list = await log();
    await within(list).findByText("mensagem 1002");
    const sock = await connectGateway(app.state.guilds);
    await act(async () => {});
    return { ...app, sock, list };
  }

  it("MESSAGE_UPDATE com pinned atualiza a linha e o painel aberto; MESSAGE_DELETE tira da lista", async () => {
    const user = userEvent.setup();
    const { sock, list, state } = await open();
    await user.click(screen.getByRole("button", { name: "Mensagens fixadas" }));
    const panel = await screen.findByRole("dialog", { name: "Mensagens fixadas" });
    expect(await within(panel).findByText(/Nenhuma mensagem fixada/)).toBeInTheDocument();

    const pinned = { ...(state.messages[CH]?.[1] as object), pinned: true };
    serverSends(sock, "MESSAGE_UPDATE", 2, pinned);
    expect(await within(panel).findByText("mensagem 1001")).toBeInTheDocument();
    const row = (within(list).getByText("mensagem 1001") as HTMLElement).closest("article");
    expect(
      within(row as HTMLElement).getByRole("img", { name: "Mensagem fixada" }),
    ).toBeInTheDocument();

    // a mais recente vai para o topo
    serverSends(sock, "MESSAGE_UPDATE", 3, {
      ...(state.messages[CH]?.[2] as object),
      pinned: true,
    });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(2));
    expect(within(panel).getAllByRole("listitem")[0]).toHaveTextContent("mensagem 1002");

    // desafixar em outra sessão
    serverSends(sock, "MESSAGE_UPDATE", 4, {
      ...(state.messages[CH]?.[2] as object),
      pinned: false,
    });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(1));

    // apagar a fixada tira do painel
    serverSends(sock, "MESSAGE_DELETE", 5, { id: "1001", channel_id: CH, guild_id: "g1" });
    expect(await within(panel).findByText(/Nenhuma mensagem fixada/)).toBeInTheDocument();
  });

  it("resposta recebida mostra a citação; apagar a original troca a citação por 'apagada'", async () => {
    const { sock, list } = await open();
    serverSends(sock, "MESSAGE_CREATE", 2, {
      id: "2000",
      channel_id: CH,
      author: { id: "50", username: "bia" },
      content: "respondendo",
      edited_at: null,
      created_at: "2026-10-31T12:00:00Z",
      attachments: [],
      mention_ids: [ME],
      reply_to: {
        id: "1001",
        author: { id: "50", username: "bia" },
        content: "mensagem 1001",
        has_attachments: false,
        deleted: false,
      },
      pinned: false,
    });
    expect(
      await within(list).findByRole("button", { name: /Ir para a mensagem original de bia/ }),
    ).toBeInTheDocument();
    // a resposta me menciona: a linha ganha o destaque de menção
    const row = within(list).getByText("respondendo").closest("article") as HTMLElement;
    expect(row).toHaveAttribute("data-mention");

    serverSends(sock, "MESSAGE_DELETE", 3, { id: "1001", channel_id: CH, guild_id: "g1" });
    expect(await within(list).findByText("Mensagem original apagada")).toBeInTheDocument();
  });

  it("a edição da original atualiza o trecho da citação", async () => {
    const { sock, list, state } = await open();
    serverSends(sock, "MESSAGE_CREATE", 2, {
      id: "2000",
      channel_id: CH,
      author: { id: "50", username: "bia" },
      content: "resposta",
      edited_at: null,
      created_at: "2026-10-31T12:00:00Z",
      attachments: [],
      mention_ids: [],
      reply_to: {
        id: "1001",
        author: { id: "50", username: "bia" },
        content: "mensagem 1001",
        has_attachments: false,
        deleted: false,
      },
      pinned: false,
    });
    const quote = await within(list).findByRole("button", {
      name: /Ir para a mensagem original de bia/,
    });
    serverSends(sock, "MESSAGE_UPDATE", 3, {
      ...(state.messages[CH]?.[1] as object),
      content: "texto novo da original",
      edited_at: "2026-10-31T12:30:00Z",
    });
    await waitFor(() => expect(quote).toHaveTextContent("texto novo da original"));
  });
});
