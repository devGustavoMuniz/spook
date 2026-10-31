import type { GatewayError, GatewayStatus } from "@spook/shared";
import { create } from "zustand";

type GatewayState = {
  status: GatewayStatus;
  sessionId: string | null;
  /** Id do usuário autenticado, como o READY informou. */
  userId: string | null;
  lastError: GatewayError | null;
  /** Reabre a conexão à mão (usado quando ela foi encerrada, p. ex. sessão aberta em outro lugar). */
  retry: (() => void) | null;
};

type GatewayActions = {
  setStatus: (status: GatewayStatus) => void;
  setSession: (sessionId: string | null, userId?: string | null) => void;
  setError: (error: GatewayError | null) => void;
  setRetry: (retry: (() => void) | null) => void;
  reset: () => void;
};

const initial: GatewayState = {
  status: "closed",
  sessionId: null,
  userId: null,
  lastError: null,
  retry: null,
};

/** Estado observável do gateway para a interface (o cache do TanStack Query fica em `cache-bindings`). */
export const useGatewayStore = create<GatewayState & GatewayActions>()((set) => ({
  ...initial,
  // Conectou: o erro anterior (já resolvido) deixa de valer.
  setStatus: (status) =>
    set((s) => ({ status, lastError: status === "connected" ? null : s.lastError })),
  setSession: (sessionId, userId) =>
    set((s) => ({ sessionId, userId: userId === undefined ? s.userId : userId })),
  setError: (lastError) => set({ lastError }),
  setRetry: (retry) => set({ retry }),
  reset: () => set(initial),
}));
