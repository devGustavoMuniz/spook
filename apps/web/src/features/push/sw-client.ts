import { safeAppPath } from "../notifications/in-app";

/**
 * Registra o service worker (só para o Web Push) e escuta o clique na notificação: o `sw.js` foca a
 * janela aberta e manda `{type: "spook:navigate", url}`, que a SPA navega sem recarregar.
 */
export function setupServiceWorker(navigate: (url: string) => void) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    if (e.data?.type !== "spook:navigate") return;
    const url = safeAppPath(e.data.url);
    if (url) navigate(url);
  });
  // Sem await: o registro não pode atrasar a pintura; falha (contexto inseguro) não quebra o app.
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}
