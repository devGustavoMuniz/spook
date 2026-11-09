import { create } from "zustand";

/** Chamado a abrir quando a seção "Ajuda e feedback" montar (o aviso de resposta aponta para ele). */
type FocusState = {
  ticketId: string | null;
  focus(id: string): void;
  clear(): void;
};

export const useFeedbackFocus = create<FocusState>((set) => ({
  ticketId: null,
  focus: (id) => set({ ticketId: id }),
  clear: () => set({ ticketId: null }),
}));
