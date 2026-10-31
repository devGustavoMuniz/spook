import { toast } from "sonner";
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
};

export const browserNotifyDeps: NotifyDeps = {
  hidden: () => document.visibilityState === "hidden",
  permission: () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
  createNotification: (title, opts) => new Notification(title, opts),
  focusWindow: () => window.focus(),
  toast: (n, open) =>
    toast(n.title, {
      // Um toast por canal: a próxima mensagem atualiza o mesmo em vez de empilhar.
      id: `msg-${n.channelId}`,
      description: n.body || undefined,
      duration: 8000,
      action: { label: "Abrir", onClick: open },
    }),
};

/**
 * Aviso de DM ou menção em canal que não está à vista. Aba oculta com permissão concedida usa a
 * notificação do navegador (o push não chega enquanto há sessão ativa, então não duplica); nos demais
 * casos, toast. `open` leva ao canal.
 */
export function showInAppNotification(
  n: InAppNotification,
  open: (url: string) => void,
  deps: NotifyDeps = browserNotifyDeps,
) {
  const go = () => open(n.url);
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
