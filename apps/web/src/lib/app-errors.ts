import { isApiError } from "@spook/shared";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Mensagem em pt-br para erros das telas de servidor/canal/mensagem (403, 404, 409, 410, 422, 429). */
export function appMessage(err: unknown): string {
  if (!isApiError(err)) return "Não foi possível conectar ao servidor. Verifique sua conexão.";
  switch (err.status) {
    case 401:
      return "Sua sessão expirou. Entre novamente.";
    case 403:
      return "Você não tem permissão para fazer isso.";
    case 404:
      return "Não encontramos isso. Pode ter sido removido.";
    case 409:
      return capitalize(err.detail);
    case 410:
      return "Este convite expirou ou atingiu o limite de usos.";
    case 422:
      return "Alguns campos são inválidos. Confira e tente de novo.";
    case 429:
      return err.retryAfter
        ? `Calma lá! Tente de novo em ${err.retryAfter} s.`
        : "Muitas tentativas. Aguarde um instante.";
    default:
      return err.status >= 500
        ? "Erro no servidor. Tente novamente em instantes."
        : capitalize(err.detail);
  }
}

export type DmAction = "open" | "create" | "add" | "remove" | "leave" | "rename";

/** Erros das DMs (SPEC 7.4) em pt-br; o mesmo status quer dizer coisas diferentes por ação. */
export function dmMessage(err: unknown, action: DmAction): string {
  if (!isApiError(err)) return appMessage(err);
  switch (err.status) {
    case 403:
      return action === "open" || action === "create" || action === "add"
        ? "Você só pode conversar com quem compartilha um servidor com você."
        : "Só o dono da conversa pode fazer isso.";
    case 404:
      return "Você não participa mais desta conversa.";
    case 409:
      return action === "add"
        ? "A conversa já tem 10 participantes."
        : "O dono da conversa não pode sair nem ser removido.";
    case 422:
      return action === "rename"
        ? "O nome da conversa precisa ter de 1 a 100 caracteres."
        : "Escolha de 1 a 9 pessoas, sem incluir você.";
    case 429:
      return err.retryAfter
        ? `Você está criando conversas rápido demais. Tente de novo em ${err.retryAfter} s.`
        : "Você está criando conversas rápido demais. Aguarde um instante.";
    default:
      return appMessage(err);
  }
}

/** Erros de `POST /channels/{id}/voice/token` e do restante da voz (SPEC 7.7) em pt-br. */
export function voiceMessage(err: unknown): string {
  if (!isApiError(err)) return appMessage(err);
  switch (err.status) {
    case 403:
      return "Você não tem permissão para entrar neste canal de voz.";
    case 404:
      return "Este canal de voz não está disponível para você.";
    case 422:
      return "Só é possível entrar em canais de voz e em conversas privadas.";
    case 503:
      return "A voz está indisponível no momento. Tente novamente mais tarde.";
    default:
      return appMessage(err);
  }
}
