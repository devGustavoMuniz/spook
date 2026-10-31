// Voz no desktop (RF12.2): NUNCA usa o WebRTC do WebView. `bootstrapDesktop()` registra a engine nativa
// (`native-engine.ts`: Rust + LiveKit SDK). Se por algum motivo nenhuma engine estiver registrada, a fábrica
// recusa com uma mensagem clara em vez de cair no WebRTC do navegador.
import type { VoiceEngine } from "@/features/voice/engine";

export const VOICE_UNAVAILABLE_MESSAGE = "Voz no desktop ainda não disponível nesta versão";

let nativeFactory: (() => VoiceEngine) | null = null;

/** Registra a engine de voz nativa (Rust + LiveKit SDK). */
export function registerNativeVoiceEngine(factory: (() => VoiceEngine) | null) {
  nativeFactory = factory;
}

/**
 * Fábrica instalada com `setVoiceEngineFactory`. Sem engine nativa, lança: o controlador de voz mostra
 * a mensagem e não chega a pedir token nem a entrar em sala no servidor.
 */
export function desktopVoiceEngineFactory(): VoiceEngine {
  if (nativeFactory) return nativeFactory();
  throw new Error(VOICE_UNAVAILABLE_MESSAGE);
}
