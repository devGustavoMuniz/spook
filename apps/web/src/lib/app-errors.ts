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
