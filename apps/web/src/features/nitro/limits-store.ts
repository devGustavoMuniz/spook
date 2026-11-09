import type { PlanLimits } from "@spook/shared";
import { create } from "zustand";
import { limitsOf } from "./plans";

/**
 * Limites conhecidos pelo código que não é React (controlador de voz, engine nativa):
 * - `plan`: o plano da pessoa (GET /api/me/plan e ENTITLEMENT_UPDATE);
 * - `voice`: o que o token de voz da sala atual trouxe (vale enquanto a chamada dura).
 */
type State = {
  plan: PlanLimits | null;
  voice: PlanLimits | null;
  setPlan: (limits: PlanLimits | null) => void;
  setVoice: (limits: PlanLimits | null) => void;
};

export const useLimitsStore = create<State>()((set) => ({
  plan: null,
  voice: null,
  // O plano mudou: o limite do token antigo deixa de valer (o servidor volta a conferir pelo plano novo).
  setPlan: (plan) => set({ plan, voice: null }),
  setVoice: (voice) => set({ voice }),
}));

/** Limites em vigor agora: o do token da sala, senão o do plano, senão o grátis. */
export function effectiveLimits(): PlanLimits {
  const s = useLimitsStore.getState();
  return s.voice ?? s.plan ?? limitsOf("free");
}

/** Só para testes. */
export function resetLimits() {
  useLimitsStore.setState({ plan: null, voice: null });
}
