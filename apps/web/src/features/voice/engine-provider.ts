// Escolha da engine por ambiente. Na web é `livekit-client`; no desktop (Fase 7) o app registra a
// engine nativa em Rust antes de montar a interface, com `setVoiceEngineFactory(...)`.
import type { VoiceEngine } from "./engine";
import { createWebVoiceEngine } from "./web-engine";

let factory: (() => VoiceEngine) | null = null;

/** Injeta a engine (desktop nativo ou dublê de teste). `null` volta ao padrão por ambiente. */
export function setVoiceEngineFactory(f: (() => VoiceEngine) | null) {
  factory = f;
}

/** Dentro do Tauri a engine web não deve ser usada (RF12.2): exige uma injetada. */
export const isDesktopRuntime = () =>
  typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window);

export function createVoiceEngine(): VoiceEngine {
  if (factory) return factory();
  if (isDesktopRuntime())
    throw new Error("Engine de voz nativa não registrada (setVoiceEngineFactory).");
  return createWebVoiceEngine();
}
