import type { CallPayload } from "@spook/shared";
import { create } from "zustand";

/**
 * Chamadas de DM com toque. `incoming`: chamadas que estão tocando PARA MIM (CALL_RING); `outgoing`: a que eu iniciei
 * e ainda ninguém atendeu ("Chamando…"). A voz em si (quem está na sala) vem dos voice states.
 */
type CallState = {
  incoming: Readonly<Record<string, CallPayload>>;
  outgoing: Readonly<Record<string, CallPayload>>;
};

type CallActions = {
  replaceIncoming: (calls: readonly CallPayload[]) => void;
  ring: (call: CallPayload) => void;
  /** CALL_UPDATE: `myId` decide se é uma chamada minha (outgoing) ou recebida. */
  update: (myId: string | null, call: CallPayload) => void;
  /** CALL_END (ou o fim local): some dos dois mapas. */
  end: (channelId: string) => void;
  setOutgoing: (call: CallPayload) => void;
  reset: () => void;
};

export const useCallStore = create<CallState & CallActions>()((set) => ({
  incoming: {},
  outgoing: {},
  replaceIncoming: (calls) =>
    set({ incoming: Object.fromEntries(calls.map((c) => [c.channel_id, c] as const)) }),
  ring: (call) => set((s) => ({ incoming: { ...s.incoming, [call.channel_id]: call } })),
  update: (myId, call) =>
    set((s) => {
      const { [call.channel_id]: _in, ...incoming } = s.incoming;
      const { [call.channel_id]: _out, ...outgoing } = s.outgoing;
      const mine = call.started_by === myId;
      // Chamada que ainda toca continua nos mapas; atendida/recusada por mim ou por alguém para de tocar aqui.
      if (call.state === "ringing") {
        if (mine) return { incoming, outgoing: { ...outgoing, [call.channel_id]: call } };
        // CALL_UPDATE de uma recusa minha em outro dispositivo: a chamada recebida some.
        return { incoming: call.user_id === myId ? incoming : s.incoming, outgoing };
      }
      // Em andamento: parou o "Chamando…" de quem ligou; quem atendeu (ou entrou) para de tocar nas suas sessões.
      if (call.user_id === myId || mine) return { incoming, outgoing };
      return { incoming: s.incoming, outgoing };
    }),
  end: (channelId) =>
    set((s) => {
      const { [channelId]: _in, ...incoming } = s.incoming;
      const { [channelId]: _out, ...outgoing } = s.outgoing;
      return { incoming, outgoing };
    }),
  setOutgoing: (call) => set((s) => ({ outgoing: { ...s.outgoing, [call.channel_id]: call } })),
  reset: () => set({ incoming: {}, outgoing: {} }),
}));

/** A chamada recebida mais antiga ainda tocando (a que o diálogo mostra). */
export function firstIncoming(incoming: Readonly<Record<string, CallPayload>>) {
  return Object.values(incoming).sort((a, b) => a.started_at.localeCompare(b.started_at))[0];
}
