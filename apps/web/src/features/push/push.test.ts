import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSubscription, stubPush } from "@/test/push";
import { type Backend, makeBackend, server } from "@/test/server";
import {
  currentEnv,
  detachPushFromAccount,
  detectPushStatus,
  disablePush,
  enablePush,
  type PushEnv,
  supportOf,
  syncPushSubscription,
  urlBase64ToUint8Array,
} from "./push";

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120",
  platform: "Linux x86_64",
  maxTouchPoints: 0,
  standalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  ...over,
});

describe("supportOf", () => {
  it("navegador com tudo: ok", () => {
    expect(supportOf(env())).toBe("ok");
  });
  it("falta service worker, PushManager ou Notification: sem suporte", () => {
    expect(supportOf(env({ hasServiceWorker: false }))).toBe("unsupported");
    expect(supportOf(env({ hasPushManager: false }))).toBe("unsupported");
    expect(supportOf(env({ hasNotification: false }))).toBe("unsupported");
  });
  it("iPhone/iPad fora do app instalado: precisa instalar (mesmo sem PushManager)", () => {
    const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" };
    expect(supportOf(env({ ...iphone, hasPushManager: false }))).toBe("needs-install");
    const ipadOs = { platform: "MacIntel", maxTouchPoints: 5 };
    expect(supportOf(env({ ...ipadOs, hasPushManager: false }))).toBe("needs-install");
  });
  it("iPhone com o app instalado: ok", () => {
    expect(
      supportOf(env({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", standalone: true })),
    ).toBe("ok");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("converte base64url (sem padding) em bytes", () => {
    expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array("-_8")]).toEqual([251, 255]);
  });
});

describe("fluxo de inscrição (navegador simulado + backend falso)", () => {
  let backend: Backend;
  let browser: ReturnType<typeof stubPush>;
  beforeEach(() => {
    const fake = makeBackend({ signedIn: true });
    backend = fake;
    server.use(...fake.handlers);
  });
  afterEach(() => browser?.restore());

  it("estado: sem service worker no navegador = não suportado", async () => {
    browser = stubPush({ serviceWorker: false });
    expect(await detectPushStatus(currentEnv())).toBe("unsupported");
  });

  it("estado: permissão negada = bloqueado", async () => {
    browser = stubPush({ permission: "denied" });
    expect(await detectPushStatus()).toBe("blocked");
  });

  it("estado: servidor sem VAPID (503) = desligado pelo servidor", async () => {
    browser = stubPush();
    backend.state.push.publicKey = null;
    expect(await detectPushStatus()).toBe("server-off");
  });

  it("estado: pode ativar, e já inscrito = ativo", async () => {
    browser = stubPush();
    expect(await detectPushStatus()).toBe("inactive");
    browser.restore();
    browser = stubPush({ permission: "granted", subscription: fakeSubscription() });
    expect(await detectPushStatus()).toBe("active");
  });

  it("ativar: pede a permissão, pega a chave, inscreve com userVisibleOnly e avisa o servidor", async () => {
    browser = stubPush();
    expect(await enablePush()).toBe("active");
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    const call = browser.pushManager.subscribe.mock.calls[0]?.[0];
    expect(call?.userVisibleOnly).toBe(true);
    expect(call?.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect(call?.applicationServerKey.length).toBe(65); // chave pública P-256 não comprimida
    expect(backend.state.push.subscribed).toEqual([
      { endpoint: "https://push.test/abc", keys: { p256dh: "chave-p256dh", auth: "chave-auth" } },
    ]);
  });

  it("permissão negada no diálogo: nada é inscrito nem enviado", async () => {
    browser = stubPush({ grant: "denied" });
    expect(await enablePush()).toBe("blocked");
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(backend.state.push.subscribed).toHaveLength(0);
  });

  it("já bloqueado: não pergunta de novo", async () => {
    browser = stubPush({ permission: "denied" });
    expect(await enablePush()).toBe("blocked");
    expect(browser.requestPermission).not.toHaveBeenCalled();
  });

  it("servidor sem VAPID (503 na chave): server-off sem inscrever", async () => {
    browser = stubPush();
    backend.state.push.publicKey = null;
    expect(await enablePush()).toBe("server-off");
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("servidor recusa a inscrição (409, limite de 10): desfaz a inscrição do navegador e falha", async () => {
    browser = stubPush();
    backend.state.push.subscribeStatus = 409;
    await expect(enablePush()).rejects.toMatchObject({ status: 409 });
    const created = await browser.pushManager.subscribe.mock.results[0]?.value;
    expect(created.unsubscribe).toHaveBeenCalled();
  });

  it("reaproveita a inscrição que o navegador já tem", async () => {
    const existing = fakeSubscription("https://push.test/ja-tinha");
    browser = stubPush({ permission: "granted", subscription: existing });
    expect(await enablePush()).toBe("active");
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(backend.state.push.subscribed[0]?.endpoint).toBe("https://push.test/ja-tinha");
  });

  it("desativar: DELETE no servidor e cancela no navegador", async () => {
    const sub = fakeSubscription();
    browser = stubPush({ permission: "granted", subscription: sub });
    await disablePush();
    expect(backend.state.push.unsubscribed).toEqual(["https://push.test/abc"]);
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it("sincronizar reenvia a inscrição existente só com a permissão concedida", async () => {
    browser = stubPush({ permission: "granted", subscription: fakeSubscription() });
    await syncPushSubscription();
    expect(backend.state.push.subscribed).toHaveLength(1);
    browser.restore();
    browser = stubPush({ permission: "default", subscription: fakeSubscription() });
    await syncPushSubscription();
    expect(backend.state.push.subscribed).toHaveLength(1);
  });

  it("ao sair da conta tira a inscrição do servidor, mantendo a do navegador", async () => {
    const sub = fakeSubscription();
    browser = stubPush({ permission: "granted", subscription: sub });
    await detachPushFromAccount();
    expect(backend.state.push.unsubscribed).toEqual(["https://push.test/abc"]);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });
});
