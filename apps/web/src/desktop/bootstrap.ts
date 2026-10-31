// Inicialização do modo desktop, antes de montar a interface. Na web é um no-op.
import { setApiBaseUrl, setRequestHeaders } from "@spook/shared";
import { setVoiceEngineFactory } from "@/features/voice/engine-provider";
import { isTauri } from "./runtime";
import { desktopHeaders, loadSessionToken } from "./token";
import { desktopVoiceEngineFactory } from "./voice";

/** Devolve `true` quando está rodando dentro do Tauri. */
export async function bootstrapDesktop(): Promise<boolean> {
  if (!isTauri()) return false;
  // Produção: https://spook.dottadigital.com (VITE_API_BASE_URL no build). Dev: vazio = proxy do Vite.
  setApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
  setRequestHeaders(desktopHeaders);
  // RF12.2: voz nunca cai no WebRTC do WebView. A Parte 7b registra a engine nativa em ./voice.
  setVoiceEngineFactory(desktopVoiceEngineFactory);
  await loadSessionToken();
  return true;
}
