// Voz no desktop (RF12.2): NUNCA usa o WebRTC do WebView. Enquanto a engine nativa em Rust não existe
// (Parte 7b), recusa entrar com uma mensagem clara. A 7b chama `registerNativeVoiceEngine(...)` no seu
// próprio módulo (importado por `bootstrap.ts`) e nada mais precisa mudar.
import type { VoiceEngine } from "@/features/voice/engine";

export const VOICE_UNAVAILABLE_MESSAGE = "Voz no desktop ainda não disponível nesta versão";

let nativeFactory: (() => VoiceEngine) | null = null;

/** Ponto de extensão da 7b: registra a engine de voz nativa (Rust + LiveKit SDK). */
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
