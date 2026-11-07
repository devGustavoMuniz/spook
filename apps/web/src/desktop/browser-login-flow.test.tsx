import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { sampleUser, server } from "@/test/server";
import * as ipc from "./ipc";
import { clearSessionToken } from "./token";

const CODE = "codigo-de-uso-unico-123456";

// O evento `spook-auth-code` que o Rust emite depois de validar `spook://auth?code=...`.
const events = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    events.handlers.set(name, cb);
    return events.unlisten;
  },
}));
const emitCode = (payload: unknown) => events.handlers.get("spook-auth-code")?.({ payload });

type Call = { cmd: string; args?: Record<string, unknown> };
function fakeIpc() {
  const calls: Call[] = [];
  vi.spyOn(ipc, "invoke").mockImplementation(
    async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "auth_set_token") return { token: args?.token, persistent: true };
      return undefined;
    },
  );
  return calls;
}

beforeEach(() => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.stubEnv("VITE_DESKTOP_BROWSER_LOGIN", "true");
});

afterEach(async () => {
  await clearSessionToken();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  events.handlers.clear();
  events.unlisten.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Entrar pelo navegador (desktop)", () => {
  it("deep link simulado -> troca do código -> sessão e entrada no app", async () => {
    const calls = fakeIpc();
    let exchanged: { code: string; code_verifier: string } | null = null;
    server.use(
      http.post("*/api/auth/desktop/exchange", async ({ request }) => {
        exchanged = (await request.json()) as { code: string; code_verifier: string };
        return HttpResponse.json({ token: "token-bearer", user: sampleUser });
      }),
    );
    const view = await renderApp("/login");
    await userEvent.click(await screen.findByRole("button", { name: "Entrar pelo navegador" }));

    // aguardando: abriu o navegador com o desafio PKCE e oferece cancelar
    expect(await screen.findByText(/Aguardando a confirmação no navegador/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:opener|open_url")).toBe(true));
    const opened = new URL(
      calls.find((c) => c.cmd === "plugin:opener|open_url")?.args?.url as string,
    );
    expect(opened.pathname).toBe("/desktop-login");
    expect(opened.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    emitCode("invalido"); // formato inesperado: ignorado, segue aguardando
    expect(screen.getByText(/Aguardando a confirmação/)).toBeInTheDocument();
    emitCode(CODE);

    await waitFor(() => expect(view.router.state.location.pathname).toBe("/"));
    expect(exchanged).toMatchObject({ code: CODE });
    expect((exchanged as unknown as { code_verifier: string }).code_verifier).toMatch(
      /^[A-Za-z0-9_-]{43,128}$/,
    );
    expect(calls.find((c) => c.cmd === "auth_set_token")?.args).toMatchObject({
      token: "token-bearer",
    });
    expect(events.unlisten).toHaveBeenCalled();
  });

  it("código expirado ou já usado mostra o erro e deixa tentar de novo", async () => {
    fakeIpc();
    server.use(
      http.post("*/api/auth/desktop/exchange", () =>
        HttpResponse.json(
          { title: "422", status: 422, detail: "código inválido" },
          { status: 422 },
        ),
      ),
    );
    const view = await renderApp("/login");
    await userEvent.click(await screen.findByRole("button", { name: "Entrar pelo navegador" }));
    await screen.findByText(/Aguardando/);
    emitCode(CODE);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O código expirou ou já foi usado. Tente de novo.",
    );
    expect(view.router.state.location.pathname).toBe("/login");
    expect(screen.getByRole("button", { name: "Entrar pelo navegador" })).toBeInTheDocument();
  });

  it("cancelar volta ao botão, sem erro, e para de escutar", async () => {
    fakeIpc();
    await renderApp("/login");
    await userEvent.click(await screen.findByRole("button", { name: "Entrar pelo navegador" }));
    await screen.findByText(/Aguardando/);
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(
      await screen.findByRole("button", { name: "Entrar pelo navegador" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(events.unlisten).toHaveBeenCalled();
  });

  it("falha ao abrir o navegador mostra erro genérico", async () => {
    vi.spyOn(ipc, "invoke").mockRejectedValue(new Error("boom"));
    await renderApp("/login");
    await userEvent.click(await screen.findByRole("button", { name: "Entrar pelo navegador" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível entrar pelo navegador. Tente de novo.",
    );
  });

  it("não aparece com a capability desligada nem fora do Tauri", async () => {
    vi.stubEnv("VITE_DESKTOP_BROWSER_LOGIN", "false");
    const view = await renderApp("/login");
    await screen.findByRole("button", { name: "Entrar" });
    expect(screen.queryByRole("button", { name: "Entrar pelo navegador" })).not.toBeInTheDocument();
    view.unmount();
    vi.stubEnv("VITE_DESKTOP_BROWSER_LOGIN", "true");
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    await renderApp("/login");
    await screen.findByRole("button", { name: "Entrar" });
    expect(screen.queryByRole("button", { name: "Entrar pelo navegador" })).not.toBeInTheDocument();
  });
});
