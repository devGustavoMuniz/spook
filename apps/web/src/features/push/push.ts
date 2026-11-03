import {
  getVapidPublicKey,
  isApiError,
  type SubscribeBody,
  subscribePush,
  unsubscribePush,
} from "@spook/shared";

/**
 * Estado da inscrição de push deste navegador, como a tela de configurações mostra:
 * - `unsupported`: sem service worker/Push/Notification;
 * - `needs-install`: iPhone/iPad fora do app instalado na Tela de Início (o Safari só libera push no PWA);
 * - `server-off`: o servidor está sem VAPID (503);
 * - `blocked`: permissão negada no navegador;
 * - `inactive`: pode ativar; `active`: inscrito.
 */
export type PushStatus =
  | "checking"
  | "unsupported"
  | "needs-install"
  | "server-off"
  | "blocked"
  | "inactive"
  | "active";

export type PushEnv = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
};

export function currentEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    standalone:
      nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
  };
}

const isIos = (e: PushEnv) =>
  /iPhone|iPad|iPod/.test(e.userAgent) || (e.platform === "MacIntel" && e.maxTouchPoints > 1);

/** O navegador consegue (ou poderia, instalando o app) receber push? */
export function supportOf(env: PushEnv): "ok" | "unsupported" | "needs-install" {
  // No iOS o PushManager só existe no app instalado: sem ele o motivo é "instalar", não "sem suporte".
  if (isIos(env) && !env.standalone) return "needs-install";
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return "unsupported";
  return "ok";
}

/** Chave VAPID (base64url) no formato que `pushManager.subscribe` pede. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** `ready` nunca resolve se o service worker não registrou: sem resposta em 5 s, desiste. */
export async function serviceWorkerRegistration(timeoutMs = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("service worker unavailable")), timeoutMs);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Corpo do `POST /push/subscriptions` a partir da inscrição do navegador. */
export function toSubscribeBody(sub: PushSubscription): SubscribeBody {
  const j = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" },
  };
}

export type EnableResult = "active" | "blocked" | "server-off";

/**
 * Ativa o push. Precisa rodar direto de um clique: a permissão é pedida ANTES de qualquer espera
 * por rede (o Safari descarta o gesto do usuário depois de um `await` demorado).
 */
export async function enablePush(): Promise<EnableResult> {
  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission !== "granted") return "blocked";

  let publicKey: string;
  try {
    publicKey = (await getVapidPublicKey()).public_key;
  } catch (e) {
    if (isApiError(e) && e.status === 503) return "server-off";
    throw e;
  }

  const reg = await serviceWorkerRegistration();
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  try {
    await subscribePush(toSubscribeBody(sub));
  } catch (e) {
    // O servidor não aceitou (limite de 10, endpoint recusado): não deixa uma inscrição órfã no navegador.
    if (!existing) await sub.unsubscribe().catch(() => {});
    if (isApiError(e) && e.status === 503) return "server-off";
    throw e;
  }
  return "active";
}

/** Desativa: avisa o servidor (se falhar, o 410 do serviço de push limpa depois) e cancela no navegador. */
export async function disablePush(): Promise<void> {
  const reg = await serviceWorkerRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await unsubscribePush({ endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

/** Estado atual (permissão + inscrição + servidor), sem pedir nada ao usuário. */
export async function detectPushStatus(env: PushEnv = currentEnv()): Promise<PushStatus> {
  const support = supportOf(env);
  if (support !== "ok") return support;
  if (Notification.permission === "denied") return "blocked";
  try {
    const reg = await serviceWorkerRegistration();
    if (await reg.pushManager.getSubscription()) return "active";
  } catch {
    return "unsupported"; // service worker não registrou (contexto inseguro, bloqueado)
  }
  try {
    await getVapidPublicKey();
  } catch (e) {
    if (isApiError(e) && e.status === 503) return "server-off";
    // Outro erro (rede, 429): deixa tentar ativar; o clique mostra o erro de verdade.
  }
  return "inactive";
}

/** Reenvia a inscrição existente ao servidor (upsert): repara conta trocada no mesmo navegador. */
export async function syncPushSubscription(env: PushEnv = currentEnv()): Promise<void> {
  if (supportOf(env) !== "ok" || Notification.permission !== "granted") return;
  const reg = await serviceWorkerRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (sub) await subscribePush(toSubscribeBody(sub));
}

/** Antes de sair da conta: tira esta inscrição do servidor (o navegador continua inscrito). */
export async function detachPushFromAccount(env: PushEnv = currentEnv()): Promise<void> {
  if (supportOf(env) !== "ok") return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await unsubscribePush({ endpoint: sub.endpoint });
}
