/** O servidor aceita 1 evento a cada 3 s por canal; o cliente nem tenta antes disso. */
export const TYPING_THROTTLE_MS = 3_000;

/** Decide quando vale avisar "estou digitando": texto não vazio e ≥ 3 s desde o último aviso. */
export function createTypingThrottle(
  now: () => number = Date.now,
  intervalMs = TYPING_THROTTLE_MS,
) {
  let last = Number.NEGATIVE_INFINITY;
  return {
    /** Chamar a cada mudança do texto; `true` = mande o POST agora. */
    shouldSend(text: string): boolean {
      if (text.trim().length === 0) return false;
      const t = now();
      if (t - last < intervalMs) return false;
      last = t;
      return true;
    },
    /** Mensagem enviada ou canal trocado: o próximo texto avisa de novo. */
    reset() {
      last = Number.NEGATIVE_INFINITY;
    },
  };
}
