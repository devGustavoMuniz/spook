// Picture-in-Picture do vídeo remoto (API nativa `requestPictureInPicture`). O PiP usa um `<video>` PRÓPRIO,
// montado fora da tela com a mesma fonte do tile: assim a janela flutuante sobrevive a rearranjos do painel de
// vídeo (clicar para destacar outro tile remonta o tile, mas não fecha a janela). Fecha sozinho quando a faixa
// some do estado ou a chamada termina.
import { useSyncExternalStore } from "react";
import type { VideoTrackInfo } from "./engine";
import { useVoiceStore } from "./store";

type Active = { id: string; video: HTMLVideoElement; host: HTMLElement; detach: () => void };

let active: Active | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

export function isPictureInPictureActive(trackId: string) {
  return active?.id === trackId;
}

/** Hook: id da faixa que está em janela flutuante (ou `null`). */
export function usePictureInPictureId(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => active?.id ?? null,
    () => null,
  );
}

function release() {
  const a = active;
  if (!a) return;
  active = null;
  a.video.removeEventListener("leavepictureinpicture", onLeave);
  a.detach();
  a.host.remove();
  notify();
}

function onLeave() {
  release();
}

/** Fecha a janela flutuante (idempotente). */
export async function closePictureInPicture() {
  const a = active;
  if (!a) return;
  try {
    if (document.pictureInPictureElement === a.video) await document.exitPictureInPicture();
  } catch {
    // a janela já foi fechada pelo usuário
  }
  release();
}

function whenReady(video: HTMLVideoElement, ms = 4000): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      video.removeEventListener("loadedmetadata", ok);
      reject(new Error("o vídeo ainda não carregou"));
    }, ms);
    const ok = () => {
      clearTimeout(t);
      resolve();
    };
    video.addEventListener("loadedmetadata", ok, { once: true });
  });
}

/** Abre (ou, se já está aberta para esta faixa, fecha) a janela flutuante. Rejeita se o navegador recusar. */
export async function togglePictureInPicture(track: VideoTrackInfo): Promise<void> {
  if (active?.id === track.id) return closePictureInPicture();
  await closePictureInPicture();
  const host = document.createElement("div");
  host.setAttribute("data-pip-host", "");
  host.style.cssText =
    "position:fixed;left:-9999px;top:0;width:320px;height:180px;overflow:hidden;pointer-events:none;opacity:0";
  document.body.appendChild(host);
  const detach = track.source.attach(host);
  const video = host.querySelector("video");
  if (!video) {
    detach();
    host.remove();
    throw new Error("esta fonte de vídeo não é um <video>");
  }
  try {
    try {
      await video.play();
    } catch {
      // autoplay recusado: o PiP ainda pode abrir com o quadro atual
    }
    await whenReady(video);
    await video.requestPictureInPicture();
  } catch (err) {
    detach();
    host.remove();
    throw err;
  }
  active = { id: track.id, video, host, detach };
  video.addEventListener("leavepictureinpicture", onLeave);
  notify();
}

// A faixa sumiu (a pessoa parou a câmera/tela) ou a chamada acabou: a janela não pode ficar congelada.
useVoiceStore.subscribe((s) => {
  if (!active) return;
  if (s.status === "idle" || !s.videoTracks.some((t) => t.id === active?.id))
    void closePictureInPicture();
});
