import { create } from "zustand";
import type { TileModel } from "./participant-tile";

/**
 * Layouts da chamada:
 * - `grid`: todos em grade (o padrão, comportamento de sempre);
 * - `focus`: um tile grande + faixa com os demais (escolhe sozinho: tela > câmera > quem fala > primeiro);
 * - `active`: oculta quem não fala e está sem vídeo (os ocultos viram um contador).
 */
export type CallLayout = "grid" | "focus" | "active";

export const LAYOUTS: { id: CallLayout; label: string; hint: string }[] = [
  { id: "grid", label: "Grade", hint: "Todos do mesmo tamanho" },
  { id: "focus", label: "Foco", hint: "Um grande e os demais numa faixa" },
  { id: "active", label: "Ocultar inativos", hint: "Esconde quem não fala nem tem vídeo" },
];

const KEY = "spook:call-layout";

export function loadCallLayout(): CallLayout {
  try {
    const v = localStorage.getItem(KEY);
    return v === "focus" || v === "active" || v === "grid" ? v : "grid";
  } catch {
    return "grid";
  }
}

function save(layout: CallLayout) {
  try {
    localStorage.setItem(KEY, layout);
  } catch {
    // vale só nesta sessão
  }
}

export const useCallLayoutStore = create<{
  layout: CallLayout;
  set: (l: CallLayout) => void;
  cycle: () => void;
}>()((set, get) => ({
  layout: loadCallLayout(),
  set: (layout) => {
    save(layout);
    set({ layout });
  },
  cycle: () => {
    const i = LAYOUTS.findIndex((l) => l.id === get().layout);
    get().set((LAYOUTS[(i + 1) % LAYOUTS.length] as (typeof LAYOUTS)[number]).id);
  },
}));

/** Quem o layout `focus` põe em destaque sozinho: tela assistida, câmera, quem fala, o primeiro. */
export function pickAutoFocus(
  tiles: TileModel[],
  speaking: ReadonlySet<string>,
): TileModel | undefined {
  return (
    tiles.find((t) => t.kind === "screen" && t.video) ??
    tiles.find((t) => t.video) ??
    tiles.find((t) => t.kind === "person" && !t.local && speaking.has(t.userId)) ??
    tiles.find((t) => t.kind === "person" && !t.local) ??
    tiles[0]
  );
}

/** No layout `active`: fica quem tem vídeo/tela, quem está falando e eu mesmo. */
export function visibleTiles(
  tiles: TileModel[],
  speaking: ReadonlySet<string>,
): { shown: TileModel[]; hidden: number } {
  const shown = tiles.filter(
    (t) => t.local || t.video || t.unwatched || (t.kind === "person" && speaking.has(t.userId)),
  );
  return { shown, hidden: tiles.length - shown.length };
}
