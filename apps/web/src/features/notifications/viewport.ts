import { useSyncExternalStore } from "react";
import { create } from "zustand";

/** Onde o usuário está olhando: o canal aberto e se a lista está rolada até o fim. */
type ViewportState = {
  channelId: string | null;
  atBottom: boolean;
  setChannel: (channelId: string | null) => void;
  setAtBottom: (atBottom: boolean) => void;
};

export const useViewportStore = create<ViewportState>()((set) => ({
  channelId: null,
  atBottom: false,
  setChannel: (channelId) => set({ channelId, atBottom: false }),
  setAtBottom: (atBottom) => set((s) => (s.atBottom === atBottom ? s : { atBottom })),
}));

/** Aba visível e janela com foco: a pessoa está de fato olhando para o app. */
export function pageActive(doc: Pick<Document, "visibilityState" | "hasFocus"> = document) {
  return doc.visibilityState === "visible" && doc.hasFocus();
}

/**
 * - `caught-up`: canal aberto, aba ativa e lista no fim: a mensagem nova é lida na hora.
 * - `focused`: canal aberto e aba ativa, mas rolada para cima: conta como não lida, sem aviso.
 * - `away`: outro canal, outra aba ou janela sem foco.
 */
export type Viewing = "caught-up" | "focused" | "away";

export function viewingOf(
  channelId: string,
  view: { channelId: string | null; atBottom: boolean },
  active: boolean,
): Viewing {
  if (!active || view.channelId !== channelId) return "away";
  return view.atBottom ? "caught-up" : "focused";
}

function subscribeActive(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

/** `pageActive()` reativo (aba visível e janela com foco). */
export function usePageActive() {
  return useSyncExternalStore(
    subscribeActive,
    () => pageActive(),
    () => false,
  );
}
