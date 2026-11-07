// Medição das fases da entrada no canal de voz (performance.mark/measure). Barato o bastante para ficar sempre
// ligado: a cada entrada grava marcas `voice:<fase>` na linha do tempo do navegador (visíveis no painel
// Performance) e mantém a última entrada em `window.__voiceJoinPerf` para o E2E/benchmark ler.
//
// Fases (todas relativas ao clique, `click`):
//   click -> token:start -> token:end -> connect:start -> signal (WebSocket de sinalização aberto) -> connect:end (ICE/mídia prontos)
//   mic:start -> mic:end (captura + publicação; `proc:*` é o carregamento do RNNoise/porta dentro dela)
//   -> ready (conectou e o microfone publicou) -> confirmed (primeiro VOICE_STATE_UPDATE meu, via gateway)

export type JoinPhase =
  | "click"
  | "token:start"
  | "token:end"
  | "connect:start"
  | "signal"
  | "connect:end"
  | "mic:start"
  | "mic:end"
  | "proc:start"
  | "proc:end"
  | "prep:start"
  | "prep:end"
  | "ready"
  | "confirmed";

export type JoinPerfReport = Partial<Record<JoinPhase, number>>;

declare global {
  interface Window {
    __voiceJoinPerf?: JoinPerfReport;
  }
}

let current: JoinPerfReport = {};
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Marca uma fase. `click` zera a medição anterior. */
export function markJoin(phase: JoinPhase): void {
  const t = now();
  if (phase === "click") current = {};
  // A primeira marca de cada fase vale (reconexões não sobrescrevem a entrada original).
  if (current[phase] === undefined) current[phase] = t;
  try {
    performance.mark(`voice:${phase}`);
    if (typeof window !== "undefined") window.__voiceJoinPerf = { ...current };
  } catch {
    // ambiente sem performance.mark
  }
}

/** Durações (ms) entre marcas relativas ao clique; só as fases já marcadas. */
export function joinDurations(r: JoinPerfReport = current): Record<string, number> {
  const c = r.click;
  if (c === undefined) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r))
    if (v !== undefined) out[k] = Math.round((v - c) * 10) / 10;
  return out;
}

/** Só para testes. */
export function resetJoinPerf(): void {
  current = {};
}
