// Prévia da transmissão (adicional ao SPEC, 5.5): enquanto compartilho a tela com "Mostrar prévia para o canal"
// ligado, captura um quadro do vídeo local (320x180, JPEG ~q0,6, até 40 KB) e o envia ao backend ao entrar e a cada
// ~15 s; ao parar, apaga. Quem vê o canal de voz enxerga a miniatura antes de entrar na transmissão. O backend a
// guarda só em memória por 45 s. Nada aqui conhece livekit-client: o quadro sai do `VideoSource` da engine.
import { apiFetch, deleteScreenPreview, putScreenPreview } from "@spook/shared";
import { useEffect, useState } from "react";
import type { VideoSource } from "./engine";

export const PREVIEW_WIDTH = 320;
export const PREVIEW_HEIGHT = 180;
export const PREVIEW_MAX_BYTES = 40 * 1024;
/** Intervalo entre envios (o servidor aceita no máximo um a cada 5 s e a prévia vale 45 s). */
export const PREVIEW_INTERVAL_MS = 15_000;
/** Espera antes de tentar de novo quando ainda não há quadro ou o envio falhou (rede, "ainda não estou na sala"). */
const RETRY_MS = 3_000;
/** Depois disto de falhas seguidas, volta ao intervalo normal (não insiste). */
const MAX_QUICK_RETRIES = 5;
const FIRST_DELAY_MS = 500;
const READY_TIMEOUT_MS = 3_000;

type Drawable = HTMLVideoElement | HTMLCanvasElement;

function sizeOf(el: Drawable): { w: number; h: number } {
  return el instanceof HTMLVideoElement
    ? { w: el.videoWidth, h: el.videoHeight }
    : { w: el.width, h: el.height };
}

/** Espera o `<video>` ter o primeiro quadro (readyState >= 2). Canvas já está pronto. */
function whenReady(el: Drawable): Promise<boolean> {
  if (!(el instanceof HTMLVideoElement)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (el.readyState >= 2 && el.videoWidth > 0) return resolve(true);
      if (Date.now() - started > READY_TIMEOUT_MS) return resolve(false);
      setTimeout(check, 100);
    };
    check();
  });
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/**
 * Captura um quadro da fonte de vídeo como JPEG 320x180 (com barras pretas se a proporção não for 16:9), baixando
 * a qualidade até caber em 40 KB. `null` se ainda não há imagem ou o navegador não desenha em canvas.
 */
export async function captureScreenFrame(source: VideoSource): Promise<Blob | null> {
  // O vídeo precisa estar na página (e "visível" para o navegador decodificar): um host minúsculo fora da tela.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-9999px;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none";
  document.body.appendChild(host);
  const detach = source.attach(host);
  try {
    const el = host.querySelector<Drawable>("video, canvas");
    if (!el || !(await whenReady(el))) return null;
    const { w, h } = sizeOf(el);
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = PREVIEW_WIDTH;
    canvas.height = PREVIEW_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    const scale = Math.min(PREVIEW_WIDTH / w, PREVIEW_HEIGHT / h);
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    ctx.drawImage(
      el,
      Math.round((PREVIEW_WIDTH - dw) / 2),
      Math.round((PREVIEW_HEIGHT - dh) / 2),
      dw,
      dh,
    );
    for (const quality of [0.6, 0.45, 0.3]) {
      const blob = await toJpeg(canvas, quality);
      if (blob && blob.size <= PREVIEW_MAX_BYTES) return blob;
    }
    return null;
  } catch {
    return null;
  } finally {
    detach();
    host.remove();
  }
}

/**
 * Começa a enviar a prévia da tela do canal (um envio logo ao entrar, depois a cada 15 s) e devolve a função que
 * PARA e, por padrão, apaga a prévia no servidor (best effort; `remote: false` só para). `getSource` devolve a fonte
 * do vídeo local da tela, se já existir.
 */
export function startScreenPreview(
  channelId: string,
  getSource: () => VideoSource | undefined,
): (remote?: boolean) => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const tick = async () => {
    let ok = false;
    try {
      const source = getSource();
      const blob = source ? await captureScreenFrame(source) : null;
      if (blob && !stopped) {
        await putScreenPreview(channelId, blob);
        ok = true;
      }
    } catch {
      // 403 (ainda não estou na sala), 429, rede...: tenta de novo daqui a pouco
    }
    if (stopped) return;
    failures = ok ? 0 : failures + 1;
    const quick = !ok && failures <= MAX_QUICK_RETRIES;
    timer = setTimeout(() => void tick(), quick ? RETRY_MS : PREVIEW_INTERVAL_MS);
  };
  timer = setTimeout(() => void tick(), FIRST_DELAY_MS);

  return (remote = true) => {
    stopped = true;
    clearTimeout(timer);
    if (remote) void deleteScreenPreview(channelId).catch(() => {});
  };
}

// ---- Quem assiste: baixar a miniatura de outra pessoa ----

export type StreamPreviewState =
  | { status: "off" } // a opção local está desligada (ou não há prévia para buscar)
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "none" }; // 404: ocultou, venceu ou ainda não chegou

/**
 * Miniatura da transmissão de `userId` no canal: busca ao ativar e de novo a cada 15 s enquanto `enabled`. Usa
 * `fetch` autenticado (cookie ou Bearer do desktop) e `URL.createObjectURL`, que é revogada a cada troca.
 */
export function useStreamPreview(
  channelId: string,
  userId: string,
  enabled: boolean,
): StreamPreviewState {
  const [state, setState] = useState<StreamPreviewState>({ status: "off" });

  useEffect(() => {
    if (!enabled) {
      setState({ status: "off" });
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: string | null = null;
    const revoke = () => {
      if (current) URL.revokeObjectURL(current);
      current = null;
    };
    setState({ status: "loading" });

    const load = async () => {
      try {
        const res = await apiFetch(`/api/channels/${channelId}/voice/screen-preview/${userId}`, {
          headers: { Accept: "image/jpeg" },
          cache: "no-store",
        });
        if (!alive) return;
        if (!res.ok) {
          revoke();
          setState({ status: "none" });
        } else {
          const blob = await res.blob();
          if (!alive) return;
          const next = URL.createObjectURL(blob);
          revoke();
          current = next;
          setState({ status: "ready", url: next });
        }
      } catch {
        if (alive) setState((s) => (s.status === "ready" ? s : { status: "none" }));
      }
      if (alive) timer = setTimeout(() => void load(), PREVIEW_INTERVAL_MS);
    };
    void load();

    return () => {
      alive = false;
      clearTimeout(timer);
      revoke();
    };
  }, [channelId, userId, enabled]);

  return state;
}
