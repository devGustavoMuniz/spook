import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleUser, server } from "@/test/server";
import { resetLimits } from "./limits-store";
import { NitroSection } from "./nitro-section";
import { PLAN_LIMITS, type PlanTier } from "./plans";
import { WelcomeTrialBanner } from "./welcome-trial";

const KEY = `spook:nitro-welcome-seen:${sampleUser.id}`;

const plan = (tier: PlanTier, days: number | null, source: string) =>
  HttpResponse.json({
    tier,
    expires_at:
      days === null ? null : new Date(Date.now() + days * 86_400_000 - 60_000).toISOString(),
    source: tier === "free" ? null : source,
    limits: PLAN_LIMITS[tier],
  });

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  resetLimits();
  localStorage.clear();
  server.use(http.get("*/api/users/me", () => HttpResponse.json(sampleUser)));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WelcomeTrialBanner", () => {
  it("mostra os dias reais da cortesia, uma vez só, e dispensar grava no localStorage", async () => {
    server.use(http.get("*/api/me/plan", () => plan("nitro_plus", 14, "trial")));
    const user = userEvent.setup();
    const { unmount } = renderWith(<WelcomeTrialBanner />);
    expect(await screen.findByText("Bem-vindo! Você ganhou 14 dias de Nitro+")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dispensar aviso de boas-vindas" }));
    expect(screen.queryByTestId("nitro-welcome")).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("1");
    unmount();
    // Reabrir o app: não volta.
    renderWith(<WelcomeTrialBanner />);
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByTestId("nitro-welcome")).toBeNull();
  });

  it("usa os dias que sobram (3 dias, singular com 1) e 'Ver o que inclui' abre a seção Nitro", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    server.use(http.get("*/api/me/plan", () => plan("nitro", 3, "trial")));
    const user = userEvent.setup();
    renderWith(<WelcomeTrialBanner />);
    expect(await screen.findByText("Bem-vindo! Você ganhou 3 dias de Nitro")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver o que inclui" }));
    expect(assign).toHaveBeenCalledWith("/settings/nitro");
    expect(localStorage.getItem(KEY)).toBe("1");
    expect(screen.queryByTestId("nitro-welcome")).toBeNull();
  });

  it("não aparece para outras origens nem no plano grátis", async () => {
    server.use(http.get("*/api/me/plan", () => plan("nitro_plus", 30, "admin")));
    renderWith(<WelcomeTrialBanner />);
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByTestId("nitro-welcome")).toBeNull();
  });

  it("funciona sem localStorage (try/catch): aparece e some ao dispensar", async () => {
    server.use(http.get("*/api/me/plan", () => plan("nitro_plus", 14, "trial")));
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    renderWith(<WelcomeTrialBanner />);
    await screen.findByTestId("nitro-welcome");
    await user.click(screen.getByRole("button", { name: "Dispensar aviso de boas-vindas" }));
    expect(screen.queryByTestId("nitro-welcome")).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("origem do plano na seção Nitro", () => {
  it("trial aparece como 'Período de cortesia' com a validade", async () => {
    server.use(http.get("*/api/me/plan", () => plan("nitro_plus", 14, "trial")));
    renderWith(<NitroSection />);
    expect(await screen.findByText("Plano atual: Nitro+")).toBeInTheDocument();
    expect(screen.getByText(/Origem: Período de cortesia/)).toBeInTheDocument();
    expect(screen.getByText(/^Vence em/)).toBeInTheDocument();
  });
});
