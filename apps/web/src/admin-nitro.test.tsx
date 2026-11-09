import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { relativeExpiry } from "@/pages/admin/nitro";
import { renderApp } from "@/test/render";
import { server } from "@/test/server";

const at = "2026-11-01T12:00:00Z";
const asAdmin = (s: { user: { is_admin?: boolean } }) => {
  s.user.is_admin = true;
};

const grant = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: "7",
  username: "bia",
  display_name: "Bia Souza",
  tier: "nitro",
  source: "admin",
  expires_at: "2099-01-01T00:00:00Z",
  granted_by: "gustavo",
  revoked_at: null,
  created_at: at,
  active: true,
  ...over,
});

const code = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  hint: "AB12",
  tier: "nitro",
  days: 30,
  state: "unused",
  created_at: at,
  created_by: "gustavo",
  redeemed_at: null,
  expires_at: null,
  ...over,
});

function api(
  over: {
    grants?: unknown[];
    total?: number;
    grantStatus?: number;
    revokeStatus?: number;
    codesStatus?: number;
    codes?: unknown[];
  } = {},
) {
  const hits = {
    grants: [] as URLSearchParams[],
    codes: [] as URLSearchParams[],
    granted: [] as { id: string; body: unknown }[],
    revoked: [] as string[],
    created: [] as unknown[],
  };
  server.use(
    http.get("*/api/admin/users", () =>
      HttpResponse.json({
        items: [
          {
            id: "7",
            username: "bia",
            email: "bia@x.dev",
            created_at: at,
            guilds_member: 0,
            guilds_owned: 0,
            messages_sent: 0,
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      }),
    ),
    http.get("*/api/admin/entitlements", ({ request }) => {
      const u = new URL(request.url);
      hits.grants.push(u.searchParams);
      return HttpResponse.json({
        items: over.grants ?? [grant("g1"), grant("g2", { tier: "nitro_plus", expires_at: null })],
        total: over.total ?? 2,
        page: Number(u.searchParams.get("page") ?? 1),
        page_size: 25,
      });
    }),
    http.post("*/api/admin/users/:id/entitlement", async ({ request, params }) => {
      hits.granted.push({ id: String(params.id), body: await request.json() });
      if (over.grantStatus)
        return HttpResponse.json(
          { title: "x", status: over.grantStatus, detail: "x" },
          { status: over.grantStatus },
        );
      return HttpResponse.json(grant("g9"), { status: 201 });
    }),
    http.delete("*/api/admin/entitlements/:id", ({ params }) => {
      hits.revoked.push(String(params.id));
      if (over.revokeStatus)
        return HttpResponse.json(
          { title: "x", status: over.revokeStatus, detail: "x" },
          { status: over.revokeStatus },
        );
      return HttpResponse.json({ revoked: 1, plan: { tier: "free" } });
    }),
    http.get("*/api/admin/redeem-codes", ({ request }) => {
      const u = new URL(request.url);
      hits.codes.push(u.searchParams);
      return HttpResponse.json({
        items: over.codes ?? [
          code("c1"),
          code("c2", { state: "used", hint: "ZZ99", redeemed_by: "bia", redeemed_at: at }),
        ],
        total: over.codes?.length ?? 2,
        page: 1,
        page_size: 25,
      });
    }),
    http.post("*/api/admin/redeem-codes", async ({ request }) => {
      hits.created.push(await request.json());
      if (over.codesStatus)
        return HttpResponse.json(
          { title: "x", status: over.codesStatus, detail: "x" },
          { status: over.codesStatus },
        );
      return HttpResponse.json(
        {
          items: [
            {
              id: "n1",
              code: "SPOOK-AAAA-BBBB-CCCC-DDDD",
              tier: "nitro",
              days: 30,
              expires_at: null,
            },
            {
              id: "n2",
              code: "SPOOK-EEEE-FFFF-GGGG-HHHH",
              tier: "nitro",
              days: 30,
              expires_at: null,
            },
          ],
        },
        { status: 201 },
      );
    }),
  );
  return hits;
}

const open = () => renderApp("/admin/nitro", { signedIn: true, seed: asAdmin });

describe("relativeExpiry", () => {
  it("formata futuro, passado e permanente", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    expect(relativeExpiry(null, now)).toBe("Permanente");
    expect(relativeExpiry("2026-11-19T12:00:00Z", now)).toBe("em 10 dias");
    expect(relativeExpiry("2026-11-09T15:00:00Z", now)).toBe("em 3 h");
    expect(relativeExpiry("2026-11-07T12:00:00Z", now)).toBe("venceu há 2 dias");
  });
});

describe("/admin/nitro", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("menu tem o item Nitro e a aba Concessões lista origem e vencimento", async () => {
    api();
    await open();
    const nav = screen.getByRole("navigation", { name: "Administração" });
    expect(within(nav).getByRole("link", { name: /Nitro/ })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Concessões de plano" });
    await within(table).findAllByText("@bia");
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText("@bia")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Administração")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText(/^em /)).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Permanente")).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader").length).toBeGreaterThan(5);
  });

  it("concede: busca o usuário, escolhe plano e dias personalizados", async () => {
    const user = userEvent.setup();
    const hits = api();
    await open();
    await screen.findByRole("table", { name: "Concessões de plano" });
    const submit = screen.getByRole("button", { name: "Conceder" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Buscar usuário"), "bi");
    await user.click(await screen.findByRole("button", { name: /^@bia/ }));
    await user.click(screen.getByRole("radio", { name: "Nitro+" }));
    await user.selectOptions(screen.getByLabelText("Duração"), "custom");
    await user.type(screen.getByLabelText("Dias (1 a 3650)"), "45");
    await user.click(screen.getByRole("button", { name: "Conceder" }));
    await waitFor(() =>
      expect(hits.granted).toEqual([{ id: "7", body: { tier: "nitro_plus", days: 45 } }]),
    );
    expect(await screen.findByText("Nitro+ concedido a @bia.")).toBeInTheDocument();
  });

  it("concede permanente: sem o campo days", async () => {
    const user = userEvent.setup();
    const hits = api();
    await open();
    await user.type(await screen.findByLabelText("Buscar usuário"), "bi");
    await user.click(await screen.findByRole("button", { name: /^@bia/ }));
    await user.selectOptions(screen.getByLabelText("Duração"), "forever");
    await user.click(screen.getByRole("button", { name: "Conceder" }));
    await waitFor(() => expect(hits.granted).toEqual([{ id: "7", body: { tier: "nitro" } }]));
  });

  it("dias personalizados fora de 1..3650 mantêm o botão desabilitado", async () => {
    const user = userEvent.setup();
    api();
    await open();
    await user.type(await screen.findByLabelText("Buscar usuário"), "bi");
    await user.click(await screen.findByRole("button", { name: /^@bia/ }));
    await user.selectOptions(screen.getByLabelText("Duração"), "custom");
    await user.type(screen.getByLabelText("Dias (1 a 3650)"), "4000");
    expect(screen.getByRole("button", { name: "Conceder" })).toBeDisabled();
  });

  it.each([
    [403, "Sem permissão para esta ação."],
    [404, "Usuário não encontrado"],
    [422, "Dados inválidos"],
  ])("conceder com erro %i mostra a mensagem", async (status, text) => {
    const user = userEvent.setup();
    api({ grantStatus: status });
    await open();
    await user.type(await screen.findByLabelText("Buscar usuário"), "bi");
    await user.click(await screen.findByRole("button", { name: /^@bia/ }));
    await user.click(screen.getByRole("button", { name: "Conceder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("revoga com confirmação; cancelar não chama a API", async () => {
    const user = userEvent.setup();
    const hits = api();
    await open();
    const btn = await screen.findByRole("button", { name: "Revogar Nitro de @bia" });
    await user.click(btn);
    const dlg = await screen.findByRole("alertdialog");
    await user.click(within(dlg).getByRole("button", { name: "Manter" }));
    expect(hits.revoked).toEqual([]);
    await user.click(await screen.findByRole("button", { name: "Revogar Nitro de @bia" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revogar" }),
    );
    await waitFor(() => expect(hits.revoked).toEqual(["g1"]));
    expect(await screen.findByText("Concessão de @bia revogada.")).toBeInTheDocument();
  });

  it.each([
    [404, "não existe mais"],
    [403, "Sem permissão"],
  ])("revogar com erro %i avisa", async (status, text) => {
    const user = userEvent.setup();
    api({ revokeStatus: status });
    await open();
    await user.click(await screen.findByRole("button", { name: "Revogar Nitro de @bia" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revogar" }),
    );
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });

  it("inativas não têm botão revogar e mostram a data da revogação", async () => {
    api({ grants: [grant("g3", { active: false, revoked_at: at })] });
    await open();
    expect(await screen.findByText("Revogada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revogar/ })).toBeNull();
  });

  it("filtros e busca vão como parâmetros; paginação avança a página", async () => {
    const user = userEvent.setup();
    const hits = api({ total: 60 });
    await open();
    await screen.findByRole("table", { name: "Concessões de plano" });
    expect(hits.grants[0]?.get("state")).toBe("active");
    await user.selectOptions(screen.getByLabelText("Filtrar por estado"), "inactive");
    await user.selectOptions(screen.getByLabelText("Filtrar por plano"), "nitro_plus");
    await user.type(screen.getByLabelText("Buscar por username ou nome"), "bia");
    await waitFor(() => {
      const last = hits.grants.at(-1) as URLSearchParams;
      expect(last.get("state")).toBe("inactive");
      expect(last.get("tier")).toBe("nitro_plus");
      expect(last.get("q")).toBe("bia");
    });
    await user.click(screen.getByRole("button", { name: /Próxima/ }));
    await waitFor(() => expect(hits.grants.at(-1)?.get("page")).toBe("2"));
  });

  it("erro 403 na lista mostra o alerta com 'Tentar de novo'", async () => {
    server.use(
      http.get("*/api/admin/entitlements", () =>
        HttpResponse.json({ title: "x", status: 403, detail: "x" }, { status: 403 }),
      ),
    );
    await open();
    expect(await screen.findByText(/Não foi possível carregar a lista/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("gera códigos, mostra uma vez, copia todos e fecha", async () => {
    const user = userEvent.setup();
    const hits = api();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open();
    await user.click(await screen.findByRole("tab", { name: "Códigos" }));
    await user.clear(screen.getByLabelText("Quantidade (1 a 100)"));
    await user.type(screen.getByLabelText("Quantidade (1 a 100)"), "2");
    await user.type(screen.getByLabelText(/Validade do código/), "14");
    await user.click(screen.getByRole("button", { name: "Gerar códigos" }));
    await waitFor(() =>
      expect(hits.created).toEqual([{ tier: "nitro", days: 30, quantity: 2, expires_in_days: 14 }]),
    );
    const box = await screen.findByRole("region", { name: "Códigos gerados" });
    expect(within(box).getByText(/não serão mostrados de novo/)).toBeInTheDocument();
    const area = within(box).getByLabelText("Códigos gerados, um por linha") as HTMLTextAreaElement;
    expect(area.value).toBe("SPOOK-AAAA-BBBB-CCCC-DDDD\nSPOOK-EEEE-FFFF-GGGG-HHHH");
    await user.click(within(box).getByRole("button", { name: "Copiar todos" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "SPOOK-AAAA-BBBB-CCCC-DDDD\nSPOOK-EEEE-FFFF-GGGG-HHHH",
      ),
    );
    await user.click(within(box).getByRole("button", { name: "Já copiei, fechar" }));
    expect(screen.queryByText("SPOOK-AAAA-BBBB-CCCC-DDDD")).toBeNull();
    expect(screen.queryByRole("region", { name: "Códigos gerados" })).toBeNull();
  });

  it("falha ao copiar avisa", async () => {
    const user = userEvent.setup();
    api();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
      configurable: true,
    });
    await open();
    await user.click(await screen.findByRole("tab", { name: "Códigos" }));
    await user.click(screen.getByRole("button", { name: "Gerar códigos" }));
    const box = await screen.findByRole("region", { name: "Códigos gerados" });
    await user.click(within(box).getByRole("button", { name: "Copiar todos" }));
    expect(await screen.findByText(/Não foi possível copiar/)).toBeInTheDocument();
  });

  it.each([
    [403, "Sem permissão"],
    [422, "Dados inválidos"],
  ])("gerar códigos com erro %i", async (status, text) => {
    const user = userEvent.setup();
    api({ codesStatus: status });
    await open();
    await user.click(await screen.findByRole("tab", { name: "Códigos" }));
    await user.click(screen.getByRole("button", { name: "Gerar códigos" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByRole("region", { name: "Códigos gerados" })).toBeNull();
  });

  it("quantidade fora de 1..100 desabilita gerar", async () => {
    const user = userEvent.setup();
    api();
    await open();
    await user.click(await screen.findByRole("tab", { name: "Códigos" }));
    await user.clear(screen.getByLabelText("Quantidade (1 a 100)"));
    await user.type(screen.getByLabelText("Quantidade (1 a 100)"), "101");
    expect(screen.getByRole("button", { name: "Gerar códigos" })).toBeDisabled();
  });

  it("lista de códigos mostra só o final, filtra por estado e plano", async () => {
    const user = userEvent.setup();
    const hits = api();
    await open();
    await user.click(await screen.findByRole("tab", { name: "Códigos" }));
    const table = await screen.findByRole("table", { name: "Códigos de resgate" });
    expect(await within(table).findByText("SPOOK-····-AB12")).toBeInTheDocument();
    expect(within(table).getByText("Usado")).toBeInTheDocument();
    expect(hits.codes[0]?.get("state")).toBe("unused");
    await user.selectOptions(screen.getByLabelText("Filtrar códigos por estado"), "expired");
    await user.selectOptions(screen.getByLabelText("Filtrar códigos por plano"), "nitro_plus");
    await waitFor(() => {
      const last = hits.codes.at(-1) as URLSearchParams;
      expect(last.get("state")).toBe("expired");
      expect(last.get("tier")).toBe("nitro_plus");
    });
  });
});
