import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserLoginError,
  type BrowserLoginPorts,
  browserLoginEnabled,
  createPkce,
  loginViaBrowser,
  parseDeepLink,
} from "./browser-login";

const CODE = "codigo-de-uso-unico-123456";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("PKCE", () => {
  it("o desafio é o SHA-256 (base64url) do verificador e tem 43 caracteres", async () => {
    const { verifier, challenge } = await createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // vetor da RFC 7636, Apêndice B
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    );
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(b64).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const second = await createPkce();
    expect(second.verifier).not.toBe(verifier);
  });
});

describe("parseDeepLink", () => {
  it("aceita só spook://auth?code= com um código bem formado", () => {
    expect(parseDeepLink(`spook://auth?code=${CODE}`)).toBe(CODE);
    expect(parseDeepLink(`https://spook.test/auth?code=${CODE}`)).toBeNull();
    expect(parseDeepLink(`spook://outra?code=${CODE}`)).toBeNull();
    expect(parseDeepLink("spook://auth?code=curto")).toBeNull();
    expect(parseDeepLink("spook://auth")).toBeNull();
    expect(parseDeepLink("lixo")).toBeNull();
  });
});

describe("capability browserLogin", () => {
  it("fica desligada por padrão", () => {
    expect(browserLoginEnabled()).toBe(false);
    vi.stubEnv("VITE_DESKTOP_BROWSER_LOGIN", "true");
    expect(browserLoginEnabled()).toBe(false); // fora do Tauri nunca liga
  });
});

function ports(over: Partial<BrowserLoginPorts> = {}) {
  let emit: (urls: string[]) => void = () => {};
  const calls = { opened: [] as string[], exchanged: [] as [string, string][], unlistened: 0 };
  const p: BrowserLoginPorts = {
    openUrl: async (u) => {
      calls.opened.push(u);
    },
    onDeepLink: async (cb) => {
      emit = cb;
      return () => {
        calls.unlistened++;
      };
    },
    exchange: async (code, verifier) => {
      calls.exchanged.push([code, verifier]);
      return { token: "tok", user: { id: "1" } };
    },
    ...over,
  };
  return { p, calls, emit: (u: string[]) => emit(u) };
}

describe("loginViaBrowser", () => {
  it("abre o navegador com o desafio, espera o deep link e troca o código com o verificador", async () => {
    const { p, calls, emit } = ports();
    const run = loginViaBrowser({ baseUrl: "https://spook.test/", ports: p });
    await vi.waitFor(() => expect(calls.opened).toHaveLength(1));
    const url = new URL(calls.opened[0] as string);
    expect(url.origin + url.pathname).toBe("https://spook.test/desktop-login");
    const challenge = url.searchParams.get("code_challenge") as string;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    emit(["spook://auth?code=curto", "https://x.test"]); // ignorados
    emit([`spook://auth?code=${CODE}`]);
    await expect(run).resolves.toEqual({ token: "tok", user: { id: "1" } });
    const [code, verifier] = calls.exchanged[0] as [string, string];
    expect(code).toBe(CODE);
    // o verificador enviado na troca é o que gerou o desafio aberto no navegador
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(b64).toBe(challenge);
    expect(calls.unlistened).toBe(1);
  });

  it("escuta o deep link antes de abrir o navegador", async () => {
    const order: string[] = [];
    const { p } = ports({
      openUrl: async () => {
        order.push("open");
      },
      onDeepLink: async () => {
        order.push("listen");
        return () => {};
      },
    });
    const run = loginViaBrowser({ baseUrl: "https://s.test", ports: p, timeoutMs: 20 });
    await expect(run).rejects.toMatchObject({ reason: "timeout" });
    expect(order).toEqual(["listen", "open"]);
  });

  it("cancelar rejeita e para de escutar", async () => {
    const { p, calls } = ports();
    const ctl = new AbortController();
    const run = loginViaBrowser({ baseUrl: "https://s.test", ports: p, signal: ctl.signal });
    await vi.waitFor(() => expect(calls.opened).toHaveLength(1));
    ctl.abort();
    await expect(run).rejects.toMatchObject({ reason: "cancelled" });
    expect(calls.unlistened).toBe(1);
  });

  it("falha na troca (código expirado ou já usado) vira erro amigável", async () => {
    const { p, emit, calls } = ports({
      exchange: async () => {
        throw new Error("422");
      },
    });
    const run = loginViaBrowser({ baseUrl: "https://s.test", ports: p });
    await vi.waitFor(() => expect(calls.opened).toHaveLength(1));
    emit([`spook://auth?code=${CODE}`]);
    const err = await run.catch((e) => e);
    expect(err).toBeInstanceOf(BrowserLoginError);
    expect(err.reason).toBe("exchange");
    expect(err.message).not.toContain("422");
  });
});
