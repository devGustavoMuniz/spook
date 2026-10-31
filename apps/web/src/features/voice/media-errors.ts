import { VoiceMediaError } from "./engine";

/** Mensagem amigável (pt-br) para falhas de microfone, câmera e tela. */
export function mediaMessage(err: unknown): string {
  if (!(err instanceof VoiceMediaError)) return "Não foi possível acessar o dispositivo.";
  if (err.userMessage) return err.userMessage;
  const what = { microphone: "o microfone", camera: "a câmera", screen: "a tela" }[err.device];
  switch (err.code) {
    case "permission-denied":
      return `O navegador bloqueou ${what}. Permita o acesso nas configurações do site e tente de novo.`;
    case "cancelled":
      return "Compartilhamento de tela cancelado.";
    case "not-found":
      return `Nenhum dispositivo encontrado para usar ${what}.`;
    case "in-use":
      return `Não foi possível abrir ${what}: outro programa pode estar usando.`;
    case "unsupported":
      return "Este navegador não permite essa função.";
    default:
      return `Não foi possível usar ${what}.`;
  }
}
