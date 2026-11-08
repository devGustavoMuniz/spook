// Saúde de uma transmissão no tile: espera o PRIMEIRO QUADRO real antes de mostrar o vídeo. Anexar a faixa a um
// `<video>` não significa que há imagem: depois de "Assistir" (assinatura sob demanda) o primeiro keyframe leva de
// centenas de ms a alguns segundos (o `dynacast` do publicador retoma o codificador quando alguém assina), e nesse
// intervalo o `<video>` é um retângulo preto. Aqui isso vira um estado explícito (`waiting`), com prazo (`stalled`).
import { useCallback, useEffect, useState } from "react";
import type { FlowState, VideoTrackInfo } from "../engine";

export type FrameState = "waiting" | "ready" | "stalled";

/** Sem nenhum quadro depois disto o tile oferece "Tentar de novo". */
export const FIRST_FRAME_TIMEOUT_MS = 8_000;
/** Intervalo da checagem (barata: só lê atributos do elemento). */
export const FRAME_POLL_MS = 100;

/** O host já mostra pelo menos um quadro? `<video>` com dimensões e dados; `<canvas>` do desktop marcado pelo desenho. */
export function hasFrame(host: ParentNode): boolean {
  const media = host.querySelector<HTMLVideoElement | HTMLCanvasElement>("video, canvas");
  if (!media) return false;
  if (media instanceof HTMLCanvasElement) return media.dataset.frame === "1";
  return media.videoWidth > 0 && media.videoHeight > 0 && media.readyState >= 2;
}

export type FrameWatch = { state: FrameState; firstFrameMs: number | null };

/**
 * Observa `host` até aparecer o primeiro quadro. `onChange` recebe `waiting` (já ao começar), depois `ready` (com o
 * tempo até o primeiro quadro) ou `stalled` se passar de `timeoutMs` (e `ready` ainda pode chegar depois).
 * Devolve a função que para. `now` e os timers são injetáveis nos testes.
 */
export function watchFirstFrame(
  host: ParentNode,
  onChange: (w: FrameWatch) => void,
  opts: { timeoutMs?: number; pollMs?: number; now?: () => number } = {},
): () => void {
  const { timeoutMs = FIRST_FRAME_TIMEOUT_MS, pollMs = FRAME_POLL_MS, now = Date.now } = opts;
  const start = now();
  let state: FrameState = "waiting";
  onChange({ state, firstFrameMs: null });
  const tick = () => {
    if (state === "ready") return;
    if (hasFrame(host)) {
      state = "ready";
      onChange({ state, firstFrameMs: Math.max(0, now() - start) });
      clearInterval(timer);
    } else if (state === "waiting" && now() - start >= timeoutMs) {
      state = "stalled";
      onChange({ state, firstFrameMs: null });
    }
  };
  const timer = setInterval(tick, pollMs);
  tick();
  return () => clearInterval(timer);
}

/**
 * Estado do primeiro quadro da faixa montada em `host`, e `restart()` para recomeçar a espera (nova tentativa).
 * Faixas locais não esperam: a própria prévia aparece quando aparece e não precisa de aviso.
 */
export function useFirstFrame(host: HTMLElement | null, track: VideoTrackInfo | undefined) {
  const [watch, setWatch] = useState<FrameWatch>({ state: "waiting", firstFrameMs: null });
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` só serve para reiniciar a espera
  useEffect(() => {
    if (!host || !track || track.local) {
      setWatch({ state: "ready", firstFrameMs: null });
      return;
    }
    return watchFirstFrame(host, setWatch);
  }, [host, track, round]);
  const restart = useCallback(() => setRound((n) => n + 1), []);
  return { ...watch, restart };
}

/** Fluxo da faixa avisado pela engine (pausa do SFU, tela silenciada). */
export function useFlowState(track: VideoTrackInfo | undefined): FlowState {
  const [flow, setFlow] = useState<FlowState>("flowing");
  useEffect(() => {
    setFlow("flowing");
    if (!track?.source.onFlow) return;
    return track.source.onFlow(setFlow);
  }, [track]);
  return flow;
}
