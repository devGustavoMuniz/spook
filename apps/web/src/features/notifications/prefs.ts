import { create } from "zustand";

const KEY = "spook.notifications.muted";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

type PrefsState = { muted: boolean; setMuted: (muted: boolean) => void };

/** Interruptor local "silenciar notificações" (toast e notificação do navegador; badges seguem). */
export const useNotificationPrefs = create<PrefsState>()((set) => ({
  muted: read(),
  setMuted: (muted) => {
    try {
      localStorage.setItem(KEY, muted ? "1" : "0");
    } catch {
      // armazenamento bloqueado: vale só nesta sessão
    }
    set({ muted });
  },
}));
