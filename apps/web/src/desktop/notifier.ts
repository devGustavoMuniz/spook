// Notificações nativas do SO (plugin `notification` do Tauri). No desktop não há Web Push nem service worker.
import type { InAppNotification } from "@/features/notifications/in-app";

let granted: boolean | null = null;

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
    return true;
  } catch {
    return false;
  }
}

/** Só para testes. */
export function resetNativeNotifier() {
  granted = null;
}
