import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFeedbackFocus } from "@/features/feedback/focus-store";
import { buildTechContext, detectOS } from "@/features/feedback/tech-context";
import { setLocale } from "@/i18n";
import { connectGateway, serverSends } from "@/test/gateway";
import { renderApp } from "@/test/render";
import { server } from "@/test/server";

type Msg = { id: string; kind: "user" | "admin"; body: string; created_at: string };
type TicketRec = {
  id: string;
  kind: "bug" | "suggestion" | "feedback";
  status: "open" | "in_review" | "answered" | "resolved" | "closed";
  title: string;
  unread: boolean;
  context?: Record<string, string>;
  messages: Msg[];
};

const at = "2026-10-31T12:00:00Z";
const summary = (t: TicketRec) => ({
  id: t.id,
  kind: t.kind,
  status: t.status,
  title: t.title,
  message_count: t.messages.length,
  unread: t.unread,
  created_at: at,
  last_activity_at: at,
});
const detail = (t: TicketRec) => ({ ...summary(t), context: t.context, messages: t.messages });

/** Servidor falso de /api/tickets com estado: guarda o que recebeu para as asserções. */
function ticketsApi(initial: TicketRec[] = []) {
  const state = {
    tickets: initial,
    created: [] as unknown[],
    replies: [] as unknown[],
    statuses: [] as string[],
  };
  server.use(
    http.get("*/api/tickets", ({ request }) => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      const all = state.tickets;
      // duas páginas de 10 só quando há mais de 10 chamados
      const items = cursor ? all.slice(10) : all.slice(0, 10);
      const next = !cursor && all.length > 10 ? "cursor-2" : null;
      return HttpResponse.json({ items: items.map(summary), next_cursor: next });
    }),
    http.post("*/api/tickets", async ({ request }) => {
      const body = (await request.json()) as {
        kind: TicketRec["kind"];
        title: string;
        description: string;
        context?: Record<string, string>;
      };
      state.created.push(body);
      const rec: TicketRec = {
        id: `t${state.tickets.length + 1}`,
        kind: body.kind,
        status: "open",
        title: body.title,
        unread: false,
        context: body.context,
        messages: [{ id: "m1", kind: "user", body: body.description, created_at: at }],
      };
      state.tickets = [rec, ...state.tickets];
      return HttpResponse.json(detail(rec), { status: 201 });
    }),
    http.get("*/api/tickets/:id", ({ params }) => {
      const t = state.tickets.find((x) => x.id === params.id);
      if (!t)
        return HttpResponse.json(
          { title: "Not Found", status: 404, detail: "chamado não encontrado" },
          { status: 404 },
        );
      const out = detail(t);
      t.unread = false; // abrir marca como lido
      return HttpResponse.json(out);
    }),
    http.post("*/api/tickets/:id/messages", async ({ params, request }) => {
      const body = (await request.json()) as { body: string };
      state.replies.push(body);
      const t = state.tickets.find((x) => x.id === params.id) as TicketRec;
      const m: Msg = {
        id: `m${t.messages.length + 1}`,
        kind: "user",
        body: body.body,
        created_at: at,
      };
      t.messages.push(m);
      return HttpResponse.json(m, { status: 201 });
    }),
    http.put("*/api/tickets/:id/status", async ({ params, request }) => {
      const body = (await request.json()) as { status: TicketRec["status"] };
      state.statuses.push(body.status);
      const t = state.tickets.find((x) => x.id === params.id) as TicketRec;
      t.status = body.status;
      return HttpResponse.json(summary(t));
    }),
  );
  return state;
}

const ticket = (over: Partial<TicketRec> = {}): TicketRec => ({
  id: "t1",
  kind: "bug",
  status: "answered",
  title: "A voz cai ao compartilhar tela",
  unread: true,
  messages: [
    { id: "m1", kind: "user", body: "Acontece sempre.", created_at: at },
    { id: "m2", kind: "admin", body: "Obrigado! Vamos olhar.", created_at: at },
  ],
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  useFeedbackFocus.getState().clear();
});
afterEach(() => setLocale("pt-BR"));

describe("Ajuda e feedback (Configurações)", () => {
  it("a seção aparece no menu do grupo App e abre com o formulário e a lista vazia", async () => {
    ticketsApi();
    await renderApp("/settings/feedback", { signedIn: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Ajuda e feedback" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Novo chamado" })).toBeInTheDocument();
    expect(await screen.findByText("Você ainda não abriu nenhum chamado.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Bug/ })).toBeChecked();
  });

  it("valida título e descrição no front antes de enviar", async () => {
    const user = userEvent.setup();
    const api = ticketsApi();
    await renderApp("/settings/feedback", { signedIn: true });
    await user.type(await screen.findByLabelText("Título"), "ab");
    await user.click(screen.getByRole("button", { name: "Enviar chamado" }));
    expect(
      await screen.findByText("O título precisa de pelo menos 3 caracteres."),
    ).toBeInTheDocument();
    expect(screen.getByText("Descreva o chamado.")).toBeInTheDocument();
    expect(api.created).toHaveLength(0);
  });

  it("envia o chamado com o contexto técnico e abre a conversa", async () => {
    const user = userEvent.setup();
    const api = ticketsApi();
    await renderApp("/settings/feedback", { signedIn: true });
    await user.click(await screen.findByRole("radio", { name: /Sugestão/ }));
    await user.type(screen.getByLabelText("Título"), "Modo escuro mais escuro");
    await user.type(screen.getByLabelText("Descrição"), "Gostaria de um tema preto puro.");
    // a prévia mostra exatamente o que vai junto
    const preview = screen.getByLabelText("O que será enviado");
    expect(within(preview).getByText("route")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enviar chamado" }));
    await waitFor(() => expect(api.created).toHaveLength(1));
    const sent = api.created[0] as {
      kind: string;
      title: string;
      description: string;
      context: Record<string, string>;
    };
    expect(sent).toMatchObject({
      kind: "suggestion",
      title: "Modo escuro mais escuro",
      description: "Gostaria de um tema preto puro.",
    });
    expect(sent.context).toMatchObject({ client: "web", locale: "pt-BR" });
    expect(sent.context.app_version).toBeTruthy();
    // abre a conversa do chamado criado
    expect(
      await screen.findByRole("heading", { level: 2, name: "Modo escuro mais escuro" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Gostaria de um tema preto puro.")).toBeInTheDocument();
  });

  it("desligar as informações técnicas não envia contexto (opt-out)", async () => {
    const user = userEvent.setup();
    const api = ticketsApi();
    await renderApp("/settings/feedback", { signedIn: true });
    await user.type(await screen.findByLabelText("Título"), "Sem contexto");
    await user.type(screen.getByLabelText("Descrição"), "Detalhes.");
    await user.click(screen.getByRole("switch", { name: /Incluir informações técnicas/ }));
    await user.click(screen.getByRole("button", { name: "Enviar chamado" }));
    await waitFor(() => expect(api.created).toHaveLength(1));
    expect(api.created[0]).not.toHaveProperty("context");
  });

  it("lista meus chamados com estado e selo de resposta nova; abrir mostra a conversa sem identificar o admin", async () => {
    const user = userEvent.setup();
    ticketsApi([
      ticket(),
      ticket({ id: "t2", title: "Ideia", kind: "suggestion", status: "open", unread: false }),
    ]);
    await renderApp("/settings/feedback", { signedIn: true });
    const list = await screen.findByRole("list", { name: "Meus chamados" });
    const first = within(list).getAllByRole("listitem")[0] as HTMLElement;
    expect(within(first).getByText("Respondido")).toBeInTheDocument();
    expect(within(first).getByText("Nova resposta")).toBeInTheDocument();
    await user.click(within(first).getByRole("button"));
    expect(await screen.findByText("Obrigado! Vamos olhar.")).toBeInTheDocument();
    expect(screen.getByText(/Equipe do Spook/)).toBeInTheDocument();
    expect(screen.getByText(/Você ·/)).toBeInTheDocument();
    // voltar: a lista já não tem o selo (o servidor marcou como lido ao abrir)
    await user.click(screen.getByRole("button", { name: "Voltar aos chamados" }));
    await waitFor(() => expect(screen.queryByText("Nova resposta")).toBeNull());
  });

  it("responde, fecha e reabre o chamado", async () => {
    const user = userEvent.setup();
    const api = ticketsApi([ticket({ status: "open", unread: false })]);
    await renderApp("/settings/feedback", { signedIn: true });
    await user.click(await screen.findByRole("button", { name: /A voz cai/ }));
    await user.type(await screen.findByRole("textbox", { name: "Responder" }), "Só no Windows.");
    await user.click(screen.getByRole("button", { name: "Responder" }));
    await waitFor(() => expect(api.replies).toEqual([{ body: "Só no Windows." }]));
    expect(await screen.findByText("Só no Windows.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fechar chamado" }));
    await waitFor(() => expect(api.statuses).toEqual(["closed"]));
    expect(
      await screen.findByText("Este chamado está fechado. Reabra para responder."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Responder" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reabrir chamado" }));
    await waitFor(() => expect(api.statuses).toEqual(["closed", "open"]));
    expect(await screen.findByRole("textbox", { name: "Responder" })).toBeInTheDocument();
  });

  it("paginação: Carregar mais busca a próxima página pelo cursor", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 12 }, (_, i) =>
      ticket({ id: `x${i}`, title: `Chamado ${i}`, status: "open", unread: false }),
    );
    ticketsApi(many);
    await renderApp("/settings/feedback", { signedIn: true });
    const list = await screen.findByRole("list", { name: "Meus chamados" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Carregar mais" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(12));
    expect(screen.queryByRole("button", { name: "Carregar mais" })).toBeNull();
  });

  it("erro do servidor ao enviar mostra a mensagem traduzida (limite de chamados)", async () => {
    const user = userEvent.setup();
    ticketsApi();
    server.use(
      http.post("*/api/tickets", () =>
        HttpResponse.json(
          {
            title: "Conflict",
            status: 409,
            detail:
              "você já tem 20 chamados em andamento: aguarde respostas ou feche alguns antes de abrir outro",
          },
          { status: 409 },
        ),
      ),
    );
    await renderApp("/settings/feedback", { signedIn: true });
    await user.type(await screen.findByLabelText("Título"), "Mais um");
    await user.type(screen.getByLabelText("Descrição"), "Detalhes.");
    await user.click(screen.getByRole("button", { name: "Enviar chamado" }));
    expect(await screen.findByText(/já tem 20 chamados em andamento/i)).toBeInTheDocument();
  });

  it("em inglês, a seção e o formulário vêm traduzidos", async () => {
    setLocale("en");
    ticketsApi();
    await renderApp("/settings/feedback", { signedIn: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Help and feedback" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send ticket" })).toBeInTheDocument();
    expect(await screen.findByText("You have not opened any tickets yet.")).toBeInTheDocument();
  });
});

describe("aviso em tempo real (TICKET_UPDATE)", () => {
  it("resposta da equipe mostra o aviso com atalho para abrir a conversa e refaz a lista", async () => {
    const user = userEvent.setup();
    const api = ticketsApi([
      ticket({
        status: "open",
        unread: false,
        messages: [{ id: "m1", kind: "user", body: "Acontece sempre.", created_at: at }],
      }),
    ]);
    await renderApp("/channels/@me", { signedIn: true });
    const sock = await connectGateway([]);
    // a equipe respondeu
    api.tickets[0] = ticket();
    serverSends(sock, "TICKET_UPDATE", 2, {
      ...summaryOf(api.tickets[0] as TicketRec),
      by_admin: true,
    });
    expect(await screen.findByText("A equipe respondeu ao seu chamado.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abrir" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Ajuda e feedback" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Obrigado! Vamos olhar.")).toBeInTheDocument();
  });

  it("ação do próprio autor (by_admin=false) não gera aviso", async () => {
    const api = ticketsApi([ticket()]);
    await renderApp("/settings/feedback", { signedIn: true });
    const sock = await connectGateway([]);
    serverSends(sock, "TICKET_UPDATE", 2, {
      ...summaryOf(api.tickets[0] as TicketRec),
      by_admin: false,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("A equipe respondeu ao seu chamado.")).toBeNull();
  });
});

function summaryOf(t: TicketRec) {
  return summary(t);
}

describe("contexto técnico", () => {
  it("detectOS reconhece os sistemas comuns sem expor a versão", () => {
    expect(detectOS({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("Windows");
    expect(detectOS({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe(
      "macOS",
    );
    expect(detectOS({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("Linux");
    expect(detectOS({ userAgent: "x", userAgentData: { platform: "Android" } })).toBe("Android");
  });

  it("buildTechContext limita os tamanhos e usa a rota informada", () => {
    const c = buildTechContext(`/channels/${"1".repeat(300)}`, "0.1.6");
    expect(c.app_version).toBe("0.1.6");
    expect(c.client).toBe("web");
    expect((c.route ?? "").length).toBeLessThanOrEqual(200);
    expect((c.browser ?? "").length).toBeLessThanOrEqual(160);
  });
});
