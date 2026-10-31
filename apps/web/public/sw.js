/* Service worker do Spook: só Web Push (sem cache offline).
 * Estático e sem bundler: o servidor o serve de /sw.js com Cache-Control: no-cache.
 * Payload do servidor (JSON): { title, body, url, tag }. */

const ICON = "/icon-192.png";
const FALLBACK_TITLE = "Spook";
// Mesmo formato dos links que o servidor monta: /channels/<servidor>/<canal> ou /channels/@me/<canal>.
const CHANNEL_URL = /^\/channels\/(@me|[0-9]+)\/[0-9]+$/;

/** Lê o payload sem confiar nele: JSON inválido ou campos de outro tipo viram um aviso genérico. */
function parsePayload(event) {
  let raw = null;
  if (event.data) {
    try {
      raw = event.data.json();
    } catch (_) {
      try {
        raw = { body: event.data.text() };
      } catch (_) {
        raw = null;
      }
    }
  }
  const o = raw && typeof raw === "object" ? raw : {};
  const str = (v) => (typeof v === "string" ? v : "");
  return {
    title: str(o.title) || FALLBACK_TITLE,
    body: str(o.body),
    tag: str(o.tag) || undefined,
    // Só caminhos do próprio app; qualquer outra coisa abre a raiz.
    url: CHANNEL_URL.test(str(o.url)) ? o.url : "/",
  };
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Chrome exige uma notificação visível para todo push (userVisibleOnly): sempre mostra uma.
self.addEventListener("push", (event) => {
  const p = parsePayload(event);
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: p.body,
      tag: p.tag, // uma por canal: a nova substitui a anterior
      renotify: !!p.tag,
      icon: ICON,
      badge: ICON,
      data: { url: p.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = data && CHANNEL_URL.test(data.url || "") ? data.url : "/";
  event.waitUntil(openOrFocus(url));
});

async function openOrFocus(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const mine = windows.find((c) => new URL(c.url).origin === self.location.origin);
  if (mine) {
    // A SPA escuta esta mensagem e navega sem recarregar (src/features/push/sw-client.ts).
    if ("focus" in mine) await mine.focus();
    mine.postMessage({ type: "spook:navigate", url });
    return;
  }
  if (self.clients.openWindow) await self.clients.openWindow(url);
}
