import { type ApiError, isApiError } from "@spook/shared";
import type { FieldValues, Path, UseFormSetError } from "react-hook-form";

const fieldLabels: Record<string, string> = {
  email: "e-mail",
  username: "nome de usuário",
  password: "senha",
  display_name: "nome de exibição",
};

/** Campo do formulário a que um erro de validação do servidor se refere ("body.username" => "username"). */
export function fieldOf(location?: string): string | undefined {
  const name = location?.split(".").pop();
  return name && name in fieldLabels ? name : undefined;
}

/** Mensagem geral em pt-br para um erro de API, para toasts e erros sem campo. */
export function messageFor(err: unknown): string {
  if (!isApiError(err)) return "Não foi possível conectar ao servidor. Verifique sua conexão.";
  switch (err.status) {
    case 401:
      return "E-mail ou senha incorretos.";
    case 409:
      return err.detail;
    case 413:
      return "Arquivo grande demais.";
    case 429:
      return "Muitas tentativas. Aguarde um instante e tente novamente.";
    case 422:
      return "Alguns campos são inválidos. Confira e tente de novo.";
    default:
      return err.status >= 500 ? "Erro no servidor. Tente novamente em instantes." : err.detail;
  }
}

/** 409 do cadastro: o servidor diz se foi o e-mail ou o usuário. */
export function conflictField(err: ApiError): "email" | "username" | undefined {
  if (err.status !== 409) return undefined;
  if (/e-?mail/i.test(err.detail)) return "email";
  if (/usu[aá]rio/i.test(err.detail)) return "username";
  return undefined;
}

/** Aplica o erro do servidor ao formulário; devolve true se foi atribuído a um campo. */
export function applyServerError<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
): boolean {
  if (!isApiError(err)) return false;
  const conflict = conflictField(err);
  if (conflict) {
    setError(conflict as Path<T>, {
      message: err.detail.charAt(0).toUpperCase() + err.detail.slice(1),
    });
    return true;
  }
  if (err.status === 422) {
    let any = false;
    for (const e of err.errors) {
      const f = fieldOf(e.location);
      if (f) {
        setError(f as Path<T>, { message: `Valor inválido para ${fieldLabels[f]}.` });
        any = true;
      }
    }
    return any;
  }
  return false;
}
