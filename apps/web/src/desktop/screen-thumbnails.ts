// Miniaturas do seletor de fonte. O Rust captura um quadro pequeno por tela/janela (em sequência) e envia cada
// uma pelo canal conforme fica pronta. Só local: nada disso vai ao servidor nem para o disco.
import { createChannel, invoke } from "./ipc";

export type ThumbFailure = "permission" | "timeout" | "unsupported" | "failed";

export type ScreenThumbnail = {
  id: string;
  /** JPEG em base64 (sem prefixo `data:`). Ausente quando `error` vem preenchido. */
  jpeg?: string;
  width: number;
  height: number;
  error?: ThumbFailure;
};

/** Intervalo de atualização das prévias enquanto o diálogo está aberto. */
export const THUMBNAIL_REFRESH_MS = 3000;

/**
 * No Windows cada captura acende a borda amarela do sistema na tela/janela capturada; atualizar a cada 3 s
 * faria todas piscarem sem parar. Lá a prévia é capturada uma vez só (SPEC 5.5).
 */
export function refreshIntervalMs(
  userAgent = globalThis.navigator?.userAgent ?? "",
): number | null {
  return /windows/i.test(userAgent) ? null : THUMBNAIL_REFRESH_MS;
}

type Deps = {
  invoke: typeof invoke;
  createChannel: typeof createChannel;
};

const defaultDeps: Deps = { invoke, createChannel };

/**
 * Pede as miniaturas de `ids` e, se `refreshMs` não for nulo, repete até `stop()`. Falhas do comando são
 * ignoradas (cada cartão mostra o ícone no lugar). Devolve a função que para e cancela o trabalho no Rust.
 */
export function startScreenThumbnails(
  ids: string[],
  onThumbnail: (t: ScreenThumbnail) => void,
  refreshMs: number | null = refreshIntervalMs(),
  deps: Deps = defaultDeps,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let permissionDenied = false;

  const round = async () => {
    try {
      const channel = await deps.createChannel<ScreenThumbnail>((t) => {
        if (stopped) return;
        if (t.error === "permission") permissionDenied = true;
        onThumbnail(t);
      });
      await deps.invoke("voice_screen_source_thumbnails", { ids, thumbnails: channel });
    } catch {
      // sem prévia: o cartão fica com o ícone
    }
    // Sem permissão não adianta insistir a cada rodada.
    if (!stopped && refreshMs !== null && !permissionDenied) {
      timer = setTimeout(() => void round(), refreshMs);
    }
  };

  if (ids.length > 0) void round();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    deps.invoke("voice_cancel_screen_thumbnails").catch(() => {});
  };
}

/** macOS: abre Ajustes > Privacidade > Gravação de Tela. */
export function openScreenRecordingSettings(): Promise<void> {
  return invoke<void>("app_open_screen_recording_settings").catch(() => {});
}
