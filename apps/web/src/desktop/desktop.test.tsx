import {
  createGatewayTicket,
  getApiBaseUrl,
  getMe,
  setApiBaseUrl,
  setRequestHeaders,
} from "@spook/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showInAppNotification } from "@/features/notifications/notify";
import { joinVoice, resetVoiceController } from "@/features/voice/controller";
import { createVoiceEngine, setVoiceEngineFactory } from "@/features/voice/engine-provider";
import { renderApp } from "@/test/render";
import { server } from "@/test/server";
import { bootstrapDesktop } from "./bootstrap";
import { gatewayConnection } from "./connection";
import * as ipc from "./ipc";
import { resetNativeNotifier, sendNativeNotification } from "./notifier";
import {
  clearSessionToken,
  desktopHeaders,
  loadSessionToken,
  persistSessionToken,
  sessionToken,
  VOLATILE_TOKEN_WARNING,
} from "./token";
import {
  desktopVoiceEngineFactory,
  registerNativeVoiceEngine,
  VOICE_UNAVAILABLE_MESSAGE,
} from "./voice";

const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", async (orig) => {
  const real = await orig<typeof import("sonner")>();
  return { ...real, toast: Object.assign(real.toast, toasts) };
});

const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => plugin);

/** Chaveiro simulado: o que o Rust faria atrás de `invoke`. */
function fakeKeyring(opts: { persistent?: boolean; stored?: string | null } = {}) {
  const k = {
    stored: opts.stored ?? null,
    persistent: opts.persistent ?? true,
    calls: [] as string[],
  };
  vi.spyOn(ipc, "invoke").mockImplementation(
    async (cmd: string, args?: Record<string, unknown>) => {
      k.calls.push(cmd);
      if (cmd === "auth_get_token") return { token: k.stored, persistent: k.persistent };
      if (cmd === "auth_set_token") {
        k.stored = args?.token as string;
        return { token: k.stored, persistent: k.persistent };
      }
      if (cmd === "auth_clear_token") {
        k.stored = null;
        return undefined;
      }
      throw new Error(`comando inesperado ${cmd}`);
    },
  );
  return k;
}

beforeEach(() => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
});

afterEach(async () => {
  await clearSessionToken();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  setApiBaseUrl("");
  setRequestHeaders(null);
  setVoiceEngineFactory(null);
  registerNativeVoiceEngine(null);
  resetNativeNotifier();
  resetVoiceController();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const f of Object.values(toasts)) f.mockClear();
  for (const f of Object.values(plugin)) f.mockClear();
});

describe("token no chaveiro", () => {
  it("lê o token guardado na inicialização", async () => {
    fakeKeyring({ stored: "guardado" });
    await loadSessionToken();
    expect(sessionToken()).toBe("guardado");
    expect(desktopHeaders()).toEqual({
      "X-Spook-Client": "desktop",
      Authorization: "Bearer guardado",
    });
  });

  it("guarda no chaveiro e limpa no logout", async () => {
    const k = fakeKeyring();
    await persistSessionToken("novo");
    expect(k.stored).toBe("novo");
    expect(sessionToken()).toBe("novo");
    expect(toasts.warning).not.toHaveBeenCalled();
    await clearSessionToken();
    expect(k.stored).toBeNull();
    expect(sessionToken()).toBeNull();
    expect(desktopHeaders()).toEqual({ "X-Spook-Client": "desktop" });
  });

  it("sem chaveiro (memória): mantém o token e avisa que será preciso entrar de novo", async () => {
    fakeKeyring({ persistent: false });
    await persistSessionToken("so-memoria");
    expect(sessionToken()).toBe("so-memoria");
    expect(toasts.warning).toHaveBeenCalledWith(VOLATILE_TOKEN_WARNING, expect.anything());
  });

  it("falha do comando Rust também cai para memória com aviso; leitura que falha = sem sessão", async () => {
    vi.spyOn(ipc, "invoke").mockRejectedValue(new Error("boom"));
    await persistSessionToken("t");
    expect(sessionToken()).toBe("t");
    expect(toasts.warning).toHaveBeenCalled();
    await loadSessionToken();
    expect(sessionToken()).toBeNull();
  });

  it("na web (fora do Tauri) não faz nada", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const spy = vi.spyOn(ipc, "invoke");
    await persistSessionToken("x");
    await clearSessionToken();
    expect(spy).not.toHaveBeenCalled();
    expect(sessionToken()).toBeNull();
  });
});

describe("bootstrap e requisições", () => {
  it("URL base absoluta e Authorization: Bearer em toda requisição, sem cookies", async () => {
    fakeKeyring({ stored: "tok123" });
    vi.stubEnv("VITE_API_BASE_URL", "https://api.exemplo.com");
    expect(await bootstrapDesktop()).toBe(true);
    expect(getApiBaseUrl()).toBe("https://api.exemplo.com");

    let seen: Request | undefined;
    server.use(
      http.get("https://api.exemplo.com/api/users/me", ({ request }) => {
        seen = request;
        return HttpResponse.json({ id: "1", username: "ana" });
      }),
    );
    await getMe();
    expect(seen?.headers.get("Authorization")).toBe("Bearer tok123");
    expect(seen?.headers.get("X-Spook-Client")).toBe("desktop");
    expect(seen?.credentials).toBe("omit");
  });

  it("na web o bootstrap não mexe em nada", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(await bootstrapDesktop()).toBe(false);
    expect(getApiBaseUrl()).toBe("");
  });

  it("login no desktop envia X-Spook-Client, guarda o token do corpo e usa o Bearer depois", async () => {
    const k = fakeKeyring();
    await bootstrapDesktop();
    const user = userEvent.setup();
    const { router, state } = await renderApp("/login");
    let loginHeader: string | null = null;
    server.use(
      http.post("*/api/auth/login", ({ request }) => {
        loginHeader = request.headers.get("X-Spook-Client");
        state.signedIn = true;
        return HttpResponse.json({
          token: "tk-desktop",
          user: {
            id: "1",
            email: "ana@spook.dev",
            username: "ana",
            created_at: "2026-10-30T12:00:00Z",
          },
        });
      }),
    );
    await user.type(await screen.findByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Senha"), "senha-correta-1");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(k.stored).toBe("tk-desktop"));
    expect(loginHeader).toBe("desktop");
    expect(sessionToken()).toBe("tk-desktop");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("logout limpa o chaveiro", async () => {
    const k = fakeKeyring({ stored: "tk" });
    await bootstrapDesktop();
    const user = userEvent.setup();
    const { state } = await renderApp("/", { signedIn: true });
    await user.click(await screen.findByRole("button", { name: /Sair/ }));
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(state.logouts).toBe(1);
    expect(k.stored).toBeNull();
    expect(sessionToken()).toBeNull();
  });

  it("401 na verificação de sessão descarta o token guardado", async () => {
    const k = fakeKeyring({ stored: "vencido" });
    await bootstrapDesktop();
    await renderApp("/", { signedIn: false });
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(k.stored).toBeNull();
  });
});

describe("gateway", () => {
  it("web: mesma origem, cliente web, sem ticket", () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const c = gatewayConnection();
    expect(c.client).toBe("web");
    expect(c).not.toHaveProperty("getTicket");
    expect(c.url).toMatch(/^ws:\/\/.+\/api\/gateway$/);
  });

  it("desktop: URL absoluta wss e ticket pedido com Bearer", async () => {
    fakeKeyring({ stored: "tok" });
    vi.stubEnv("VITE_API_BASE_URL", "https://spook.dottadigital.com");
    await bootstrapDesktop();
    const c = gatewayConnection();
    expect(c.url).toBe("wss://spook.dottadigital.com/api/gateway");
    expect(c.client).toBe("desktop");
    let auth: string | null = null;
    server.use(
      http.post("https://spook.dottadigital.com/api/gateway/ticket", ({ request }) => {
        auth = request.headers.get("Authorization");
        return HttpResponse.json({ ticket: "tk-1", expires_in: 30 });
      }),
    );
    expect(await (c as { getTicket: () => Promise<string> }).getTicket()).toBe("tk-1");
    expect(auth).toBe("Bearer tok");
    expect((await createGatewayTicket()).ticket).toBe("tk-1");
  });
});

describe("notify() no desktop", () => {
  const n = { title: "ana", body: "oi", channelId: "c1", url: "/channels/g/c1" } as never;
  const deps = (focused: boolean, send = vi.fn(async () => true)) => ({
    hidden: () => false,
    permission: () => "unsupported" as const,
    createNotification: vi.fn(),
    focusWindow: vi.fn(),
    toast: vi.fn(),
    desktop: { focused: () => focused, send },
  });

  it("janela sem foco: notificação nativa, sem toast", async () => {
    const d = deps(false);
    showInAppNotification(n, vi.fn(), d);
    await waitFor(() => expect(d.desktop.send).toHaveBeenCalledWith(n));
    expect(d.toast).not.toHaveBeenCalled();
    expect(d.createNotification).not.toHaveBeenCalled();
  });

  it("janela com foco: toast", () => {
    const d = deps(true);
    showInAppNotification(n, vi.fn(), d);
    expect(d.toast).toHaveBeenCalled();
    expect(d.desktop.send).not.toHaveBeenCalled();
  });

  it("se a notificação nativa falhar, cai para o toast", async () => {
    const d = deps(
      false,
      vi.fn(async () => false),
    );
    showInAppNotification(n, vi.fn(), d);
    await waitFor(() => expect(d.toast).toHaveBeenCalled());
  });

  it("plugin: pede permissão uma vez e envia título e corpo", async () => {
    plugin.isPermissionGranted.mockResolvedValueOnce(false);
    expect(await sendNativeNotification({ title: "ana", body: "oi" } as never)).toBe(true);
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "ana", body: "oi" });
    await sendNativeNotification({ title: "x", body: "" } as never);
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).toHaveBeenLastCalledWith({ title: "x", body: undefined });
  });

  it("permissão negada = false", async () => {
    plugin.isPermissionGranted.mockResolvedValueOnce(false);
    plugin.requestPermission.mockResolvedValueOnce("denied");
    expect(await sendNativeNotification({ title: "a", body: "b" } as never)).toBe(false);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});

describe("tela de notificações no desktop", () => {
  it("mostra que usa notificações nativas e não oferece Web Push", async () => {
    await renderApp("/settings/notifications", { signedIn: true });
    expect(
      await screen.findByText(/Este app usa notificações nativas do sistema/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ativar notificações" })).toBeNull();
    expect(screen.getByRole("switch", { name: /Silenciar notificações/ })).toBeInTheDocument();
  });
});

describe("voz no desktop (RF12.2)", () => {
  it("sem engine nativa recusa com mensagem clara e nunca cai no WebRTC do WebView", async () => {
    await bootstrapDesktop();
    expect(() => createVoiceEngine()).toThrow(VOICE_UNAVAILABLE_MESSAGE);
    expect(() => desktopVoiceEngineFactory()).toThrow(
      "Voz no desktop ainda não disponível nesta versão",
    );
  });

  it("entrar numa chamada mostra o aviso e não pede token ao servidor", async () => {
    await bootstrapDesktop();
    let tokenRequests = 0;
    server.use(
      http.post("*/api/channels/:id/voice/token", () => {
        tokenRequests++;
        return HttpResponse.json({});
      }),
    );
    const ok = await joinVoice({
      channelId: "c1",
      guildId: "g1",
      channelName: "Geral",
      canSpeak: true,
    });
    expect(ok).toBe(false);
    expect(toasts.error).toHaveBeenCalledWith(VOICE_UNAVAILABLE_MESSAGE);
    expect(tokenRequests).toBe(0);
  });

  it("a 7b registra a engine nativa pelo ponto de extensão", () => {
    const native = { state: "disconnected" } as never;
    registerNativeVoiceEngine(() => native);
    expect(desktopVoiceEngineFactory()).toBe(native);
  });
});
