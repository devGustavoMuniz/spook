// Notificações nativas do SO (plugin `notification` do Tauri). No desktop não há Web Push nem service worker.
import { type InAppNotification, safeAppPath } from "@/features/notifications/in-app";

let granted: boolean | null = null;

/**
 * Janela em que ganhar foco depois de uma notificação nativa conta como "cliquei nela" (o plugin do desktop não
 * entrega o clique). Mais curta evita navegar sem querer; mais longa perde cliques tardios.
 */
export const NOTIFICATION_CLICK_WINDOW_MS = 10_000;

let lastNotification: { url: string; at: number } | null = null;

/** Guarda a última notificação nativa disparada (só a mais recente importa). */
export function rememberNotification(url: string, at: number = Date.now()) {
  lastNotification = { url, at };
}

/**
 * Devolve (e esquece) o canal da última notificação se ela ainda estiver dentro da janela. Uma só vez: a segunda
 * chamada devolve `null`. Só caminhos do próprio app passam.
 */
export function takeRecentNotification(
  now: number = Date.now(),
  windowMs: number = NOTIFICATION_CLICK_WINDOW_MS,
): string | null {
  const last = lastNotification;
  lastNotification = null;
  if (!last || now - last.at > windowMs || now < last.at) return null;
  return safeAppPath(last.url);
}

/** Envia a notificação nativa. Devolve `false` se não foi possível (o chamador cai para o toast). */
export async function sendNativeNotification(n: InAppNotification): Promise<boolean> {
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    if (granted === null) {
      granted =
        (await plugin.isPermissionGranted()) || (await plugin.requestPermission()) === "granted";
    }
    if (!granted) return false;
    plugin.sendNotification({ title: n.title, body: n.body || undefined });
    rememberNotification(n.url);
    return true;
  } catch {
    return false;
  }
}

/** Só para testes. */
export function resetNativeNotifier() {
  granted = null;
  lastNotification = null;
}
