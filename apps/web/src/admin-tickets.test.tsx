import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { server } from "@/test/server";

const at = "2026-10-31T12:00:00Z";
const asAdmin = (s: { user: { is_admin?: boolean } }) => {
  s.user.is_admin = true;
};
const author = { id: "7", username: "bia", display_name: "Bia Souza", email: "bia@x.dev" };

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "bug",
  status: "open",
  title: `Chamado ${id}`,
  message_count: 1,
  unread: false,
  created_at: at,
  last_activity_at: at,
  author,
  ...over,
});

const full = {
  ...row("t1", { title: "A voz cai ao compartilhar tela" }),
  context: { app_version: "0.1.6", client: "desktop", route: "/channels/1/2" },
  messages: [
    { id: "m1", kind: "user", body: "Acontece sempre.", created_at: at, username: "bia" },
    {
      id: "m2",
      kind: "internal",
      body: "Suspeita: driver de vídeo.",
      created_at: at,
      username: "ana",
      attachments: [
        {
          id: "a9",
          filename: "driver.png",
          content_type: "image/png",
          size: 2048,
          url: "https://storage.test/tickets/t1/a9.png",
        },
      ],
    },
  ],
};

type Hits = { list: URLSearchParams[]; replies: unknown[]; statuses: unknown[] };

function api(
  over: {
    open?: number;
    pages?: Record<string, { items: unknown[]; next_cursor: string | null }>;
  } = {},
) {
  const hits: Hits = { list: [], replies: [], statuses: [] };
  server.use(
    http.get("*/api/admin/tickets/summary", () =>
      HttpResponse.json({
        open: over.open ?? 3,
        in_review: 1,
        answered: 0,
        resolved: 2,
        closed: 4,
        total: 10,
      }),
    ),
    http.get("*/api/admin/tickets", ({ request }) => {
      const u = new URL(request.url);
      hits.list.push(u.searchParams);
      const cursor = u.searchParams.get("cursor") ?? "";
      const page = over.pages?.[cursor] ?? {
        items: [
          row("t1", { title: "A voz cai ao compartilhar tela" }),
          row("t2", { kind: "suggestion", status: "answered" }),
        ],
        next_cursor: null,
      };
      return HttpResponse.json(page);
    }),
    http.get("*/api/admin/tickets/:id", ({ params }) =>
      HttpResponse.json({ ...full, id: params.id }),
    ),
    http.post("*/api/admin/tickets/:id/messages", async ({ request }) => {
      const body = await request.json();
      hits.replies.push(body);
      return HttpResponse.json(
        { id: "m9", kind: "admin", body: "ok", created_at: at },
        { status: 201 },
      );
    }),
    http.put("*/api/admin/tickets/:id/status", async ({ request }) => {
      const body = (await request.json()) as { status: string };
      hits.statuses.push(body.status);
      return HttpResponse.json(row("t1", { status: body.status }));
    }),
  );
  return hits;
}

describe("/admin/tickets", () => {
  it("lista a fila com estado, tipo e autor, e o menu mostra a contagem de abertos", async () => {
    api();
    await renderApp("/admin/tickets", {
      signedIn: true,
      seed: asAdmin,
    });
    const list = await screen.findByRole("list", { name: "Chamados" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("Aberto")).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText("@bia")).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText("Respondido")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Administração" });
    expect(await within(nav).findByText("3 chamados abertos")).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Chamados/ })).toBeInTheDocument();
  });

  it("filtros, busca e ordenação vão como parâmetros da consulta", async () => {
    const user = userEvent.setup();
    const hits = api();
    await renderApp("/admin/tickets", {
      signedIn: true,
      seed: asAdmin,
    });
    await screen.findByRole("list", { name: "Chamados" });
    await user.selectOptions(screen.getByLabelText("Filtrar por estado"), "in_review");
    await user.selectOptions(screen.getByLabelText("Filtrar por tipo"), "bug");
    await user.selectOptions(screen.getByLabelText("Ordenar"), "oldest");
    await user.type(screen.getByLabelText("Buscar por título ou usuário"), "voz");
    await waitFor(() => {
      const last = hits.list.at(-1) as URLSearchParams;
      expect(last.get("status")).toBe("in_review");
      expect(last.get("kind")).toBe("bug");
      expect(last.get("sort")).toBe("oldest");
      expect(last.get("q")).toBe("voz");
    });
  });

  it("paginação por cursor: Carregar mais", async () => {
    const user = userEvent.setup();
    const hits = api({
      pages: {
        "": { items: [row("t1")], next_cursor: "c2" },
        c2: { items: [row("t2", { title: "Segundo" })], next_cursor: null },
      },
    });
    await renderApp("/admin/tickets", {
      signedIn: true,
      seed: asAdmin,
    });
    await screen.findByText("Chamado t1");
    await user.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(await screen.findByText("Segundo")).toBeInTheDocument();
    expect(hits.list.at(-1)?.get("cursor")).toBe("c2");
    expect(screen.queryByRole("button", { name: "Carregar mais" })).toBeNull();
  });

  it("detalhe: autor, e-mail, contexto, nota interna destacada; responde e registra nota interna", async () => {
    const user = userEvent.setup();
    const hits = api();
    await renderApp("/admin/tickets/t1", {
      signedIn: true,
      seed: asAdmin,
    });
    expect(
      await screen.findByRole("heading", { level: 2, name: "A voz cai ao compartilhar tela" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "bia@x.dev" })).toHaveAttribute(
      "href",
      "mailto:bia@x.dev",
    );
    expect(screen.getByText("Contexto técnico")).toBeInTheDocument();
    const msgs = within(screen.getByRole("list", { name: "Mensagens" })).getAllByRole("listitem");
    expect(msgs[1]).toHaveAttribute("data-kind", "internal");
    expect(within(msgs[1] as HTMLElement).getByText("Nota interna")).toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "Responder ao usuário" }),
      "Já estamos corrigindo.",
    );
    await user.click(screen.getByRole("button", { name: "Enviar resposta" }));
    await waitFor(() =>
      expect(hits.replies).toEqual([{ body: "Já estamos corrigindo.", internal: false }]),
    );

    await user.click(screen.getByRole("checkbox", { name: /Nota interna/ }));
    await user.type(screen.getByRole("textbox", { name: "Nota interna" }), "Falar com o Gustavo.");
    await user.click(screen.getByRole("button", { name: "Salvar nota" }));
    await waitFor(() =>
      expect(hits.replies.at(-1)).toEqual({ body: "Falar com o Gustavo.", internal: true }),
    );
  });

  it("mostra a miniatura das imagens anexadas (inclusive na nota interna)", async () => {
    api();
    await renderApp("/admin/tickets/t1", { signedIn: true, seed: asAdmin });
    const thumb = await screen.findByRole("button", { name: /driver\.png/ });
    expect(thumb.querySelector("img")).toHaveAttribute(
      "src",
      "https://storage.test/tickets/t1/a9.png",
    );
    expect(screen.getByRole("button", { name: "Anexar imagens" })).toBeInTheDocument();
  });

  it("muda o estado do chamado", async () => {
    const user = userEvent.setup();
    const hits = api();
    await renderApp("/admin/tickets/t1", {
      signedIn: true,
      seed: asAdmin,
    });
    await screen.findByRole("heading", { level: 2, name: "A voz cai ao compartilhar tela" });
    await user.selectOptions(screen.getByLabelText("Alterar o estado"), "resolved");
    await waitFor(() => expect(hits.statuses).toEqual(["resolved"]));
  });

  it("quem não é admin é redirecionado para fora do /admin", async () => {
    api();
    const { router } = await renderApp("/admin/tickets", { signedIn: true });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });
});
