import { toast } from "sonner";
import { sendNativeNotification } from "@/desktop/notifier";
import { isTauri } from "@/desktop/runtime";
import { t } from "@/i18n";
import type { InAppNotification } from "./in-app";

export type NotifyDeps = {
  hidden: () => boolean;
  permission: () => NotificationPermission | "unsupported";
  /** Cria a notificação do navegador; devolve algo com `onclick`/`close` ou lança se não puder. */
  createNotification: (
    title: string,
    opts: NotificationOptions,
  ) => {
    onclick: ((ev: Event) => unknown) | null;
    close: () => void;
  };
  focusWindow: () => void;
  toast: (n: InAppNotification, open: () => void) => void;
  /**
   * Só no desktop (Tauri): sem Web Push nem `Notification` do navegador, os avisos com a janela sem foco
   * usam o plugin de notificações nativas do SO. Ausente na web.
   */
  desktop?: {
    focused: () => boolean;
    send: (n: InAppNotification) => Promise<boolean>;
  };
};

const desktopNotifier = {
  focused: () => document.hasFocus(),
  send: sendNativeNotification,
};

export const browserNotifyDeps: NotifyDeps = {
  hidden: () => document.visibilityState === "hidden",
  permission: () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
  createNotification: (title, opts) => new Notification(title, opts),
  focusWindow: () => window.focus(),
  get desktop() {
    return isTauri() ? desktopNotifier : undefined;
  },
  toast: (n, open) =>
    toast(n.title, {
      // Um toast por canal: a próxima mensagem atualiza o mesmo em vez de empilhar.
      id: `msg-${n.channelId}`,
      description: n.body || undefined,
      duration: 8000,
      action: { label: t("settings.notify.open"), onClick: open },
    }),
};

/**
 * Aviso de DM ou menção em canal que não está à vista. No desktop: notificação nativa se a janela está
 * sem foco, senão toast. Na web, aba oculta com permissão concedida usa a
 * notificação do navegador (o push não chega enquanto há sessão ativa, então não duplica); nos demais
 * casos, toast. `open` leva ao canal.
 */
export function showInAppNotification(
  n: InAppNotification,
  open: (url: string) => void,
  deps: NotifyDeps = browserNotifyDeps,
) {
  const go = () => open(n.url);
  if (deps.desktop) {
    // Janela sem foco: notificação nativa (no desktop o clique só traz o app à frente; não há callback).
    // Com foco, o aviso é o toast de sempre. Se o SO recusar a notificação, o toast cobre.
    if (!deps.desktop.focused()) {
      void deps.desktop.send(n).then((ok) => {
        if (!ok) deps.toast(n, go);
      });
      return;
    }
    deps.toast(n, go);
    return;
  }
  if (deps.hidden() && deps.permission() === "granted") {
    try {
      const note = deps.createNotification(n.title, {
        body: n.body,
        tag: n.channelId,
        icon: "/icon-192.png",
      });
      note.onclick = () => {
        deps.focusWindow();
        go();
        note.close();
      };
      return;
    } catch {
      // Alguns navegadores (Android) só aceitam via service worker: cai para o toast.
    }
  }
  deps.toast(n, go);
}
