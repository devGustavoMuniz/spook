import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "@/test/server";
import { applyEntitlementUpdate } from "./entitlement";
import { effectiveLimits, resetLimits, useLimitsStore } from "./limits-store";
import { Locked } from "./locked";
import { NitroBadge } from "./nitro-badge";
import { isNitroRequired, NitroRequiredDialog } from "./nitro-required-dialog";
import { NitroSection } from "./nitro-section";
import { PLAN_LIMITS, type PlanTier } from "./plans";
import { usePlan } from "./use-plan";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const plan = (tier: PlanTier, expires_at: string | null = null, source = "admin") =>
  HttpResponse.json({
    tier,
    expires_at,
    source: tier === "free" ? null : source,
    limits: PLAN_LIMITS[tier],
  });

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>),
  };
}

beforeEach(() => resetLimits());
afterEach(() => vi.clearAllMocks());

describe("NitroBadge", () => {
  it("só aparece para quem tem plano, com o nome no tooltip e no rótulo", () => {
    const { rerender } = render(<NitroBadge tier="nitro" />);
    const badge = screen.getByRole("img", { name: "Plano Nitro" });
    expect(badge).toHaveAttribute("title", "Nitro");
    rerender(<NitroBadge tier="nitro_plus" />);
    expect(screen.getByRole("img", { name: "Plano Nitro+" })).toHaveAttribute("title", "Nitro+");
    rerender(<NitroBadge tier="free" />);
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<NitroBadge tier={undefined} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("usePlan e Locked", () => {
  function Probe() {
    const p = usePlan();
    return (
      <p>
        {p.tier}|{p.limits.screen_max_height}|{String(p.isAtLeast("nitro"))}
      </p>
    );
  }

  it("sem resposta vale grátis; com Nitro+ vale 1440 e publica os limites para a voz", async () => {
    server.use(http.get("*/api/me/plan", () => plan("nitro_plus")));
    renderWith(<Probe />);
    expect(screen.getByText("free|720|false")).toBeInTheDocument();
    expect(await screen.findByText("nitro_plus|1440|true")).toBeInTheDocument();
    await waitFor(() => expect(effectiveLimits().screen_max_height).toBe(1440));
  });

  it("Locked: grátis vê o cadeado e 'Requer Nitro'; com plano vê o conteúdo", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const user = userEvent.setup();
    renderWith(
      <Locked requires="nitro" label="Avatar animado">
        <span>conteúdo</span>
      </Locked>,
    );
    const btn = await screen.findByRole("button", {
      name: "Avatar animado: requer Nitro. Ver planos.",
    });
    expect(within(btn).getByText("Requer Nitro")).toBeInTheDocument();
    await user.click(btn);
    expect(assign).toHaveBeenCalledWith("/settings/nitro");
    vi.unstubAllGlobals();
  });

  it("Locked libera o conteúdo para quem tem o plano", async () => {
    server.use(http.get("*/api/me/plan", () => plan("nitro")));
    renderWith(
      <Locked requires="nitro" label="x">
        <span>conteúdo</span>
      </Locked>,
    );
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(screen.getByText("conteúdo")).toBeInTheDocument();
  });
});

describe("limites para a voz", () => {
  it("o limite do token da sala vale sobre o do plano; trocar de plano descarta o do token", () => {
    useLimitsStore.getState().setPlan(PLAN_LIMITS.nitro_plus);
    expect(effectiveLimits().screen_max_height).toBe(1440);
    useLimitsStore.getState().setVoice(PLAN_LIMITS.free);
    expect(effectiveLimits().screen_max_height).toBe(720);
    useLimitsStore.getState().setPlan(PLAN_LIMITS.nitro);
    expect(effectiveLimits().screen_max_height).toBe(1080);
  });
});

describe("NitroSection", () => {
  it("grátis: mostra o plano, a tabela e NÃO oferece assinar", async () => {
    renderWith(<NitroSection />);
    expect(await screen.findByText("Você está no plano Grátis.")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Recurso", "GrátisSeu plano", "Nitro", "Nitro+"]);
    expect(within(table).getByText("Até 720p, 30 fps")).toBeInTheDocument();
    expect(within(table).getByText("Até 1080p, 60 fps")).toBeInTheDocument();
    expect(within(table).getByText("Até 1440p, 60 fps")).toBeInTheDocument();
    expect(screen.queryByTestId("nitro-subscribe")).toBeNull();
    expect(screen.queryByRole("button", { name: /Assinar/ })).toBeNull();
    expect(screen.queryByTestId("nitro-expiring")).toBeNull();
  });

  it("com plano: nome, validade e origem; perto de vencer avisa", async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    server.use(http.get("*/api/me/plan", () => plan("nitro", soon, "code")));
    renderWith(<NitroSection />);
    expect(await screen.findByText("Plano atual: Nitro")).toBeInTheDocument();
    const current = screen.getByTestId("nitro-current");
    expect(within(current).getByText(/^Vence em/)).toBeInTheDocument();
    expect(within(current).getByText(/Origem: Código de resgate/)).toBeInTheDocument();
    expect(screen.getByTestId("nitro-expiring")).toHaveTextContent(
      "Seu Nitro está perto de vencer",
    );
  });

  it("permanente não tem aviso de vencimento", async () => {
    server.use(http.get("*/api/me/plan", () => plan("nitro_plus", null, "admin")));
    renderWith(<NitroSection />);
    expect(await screen.findByText("Permanente, sem data de vencimento.")).toBeInTheDocument();
    expect(screen.getByText(/Concedido pela equipe/)).toBeInTheDocument();
    expect(screen.queryByTestId("nitro-expiring")).toBeNull();
  });

  it("resgate com sucesso: avisa, atualiza o plano e limpa o campo", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/me/plan/redeem", async ({ request }) => {
        expect(await request.json()).toEqual({ code: "SPOOK-AAAA-BBBB-CCCC-DDDD" });
        return plan("nitro", new Date(Date.now() + 30 * 86_400_000).toISOString(), "code");
      }),
    );
    renderWith(<NitroSection />);
    const input = await screen.findByLabelText("Código de resgate");
    await user.type(input, " SPOOK-AAAA-BBBB-CCCC-DDDD ");
    await user.click(screen.getByRole("button", { name: "Resgatar" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Nitro ativado"));
    expect(await screen.findByText("Plano atual: Nitro")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it.each([
    [404, "Código inválido. Confira os caracteres e tente de novo."],
    [409, "Este código já foi usado."],
    [410, "Este código venceu e não pode mais ser resgatado."],
    [429, "Muitas tentativas. Aguarde um pouco e tente de novo."],
  ])("resgate %i mostra o erro claro", async (status, text) => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/me/plan/redeem", () =>
        HttpResponse.json({ title: String(status), status, detail: "x" }, { status }),
      ),
    );
    renderWith(<NitroSection />);
    await user.type(await screen.findByLabelText("Código de resgate"), "CODIGO");
    await user.click(screen.getByRole("button", { name: "Resgatar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("campo vazio não chama o servidor", async () => {
    const user = userEvent.setup();
    renderWith(<NitroSection />);
    await user.click(await screen.findByRole("button", { name: "Resgatar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Digite o código para resgatar.");
  });
});

describe("ENTITLEMENT_UPDATE", () => {
  const ev = (tier: PlanTier, reason: "granted" | "revoked" | "redeemed" | "expired") => ({
    tier,
    expires_at: null,
    source: tier === "free" ? null : ("admin" as const),
    limits: PLAN_LIMITS[tier],
    reason,
  });

  it("atualiza o cache do plano, o selo do meu perfil e os limites; avisa conforme o motivo", () => {
    const qc = new QueryClient();
    qc.setQueryData(["/api/users/me"], { id: "1", plan: "free" });
    applyEntitlementUpdate(qc, ev("nitro", "granted"));
    expect(qc.getQueryData(["/api/me/plan"])).toMatchObject({ tier: "nitro" });
    expect(qc.getQueryData(["/api/users/me"])).toMatchObject({ plan: "nitro" });
    expect(effectiveLimits().screen_max_height).toBe(1080);
    expect(toast.success).toHaveBeenCalledWith("Nitro ativado");

    applyEntitlementUpdate(qc, ev("nitro_plus", "redeemed"));
    expect(toast.success).toHaveBeenLastCalledWith("Nitro+ ativado");

    applyEntitlementUpdate(qc, ev("free", "expired"));
    expect(toast.info).toHaveBeenCalledWith("Seu Nitro venceu. Você voltou ao plano Grátis.");
    expect(effectiveLimits().screen_max_height).toBe(720);

    applyEntitlementUpdate(qc, ev("free", "revoked"));
    expect(toast.info).toHaveBeenLastCalledWith("Seu plano mudou para Grátis.");
  });
});

describe("NitroRequiredDialog", () => {
  it("explica e leva à seção Nitro", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<NitroRequiredDialog open onOpenChange={onOpenChange} />);
    expect(await screen.findByText("Requer Nitro")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver planos" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(assign).toHaveBeenCalledWith("/settings/nitro");
    vi.unstubAllGlobals();
  });

  it("isNitroRequired reconhece só o 403 com o código", async () => {
    const { ApiError } = await import("@spook/shared");
    expect(isNitroRequired(new ApiError(403, "x", [], undefined, "nitro_required"))).toBe(true);
    expect(isNitroRequired(new ApiError(403, "x"))).toBe(false);
    expect(isNitroRequired(new ApiError(422, "x", [], undefined, "nitro_required"))).toBe(false);
    expect(isNitroRequired(new Error("x"))).toBe(false);
  });
});
