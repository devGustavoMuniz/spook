import { type ApiError, isApiError } from "@spook/shared";
import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { type MessageKey, t } from "@/i18n";
import { translateDetail } from "./app-errors";

const fieldLabels: Record<string, MessageKey> = {
  email: "auth.field.email",
  username: "auth.field.username",
  password: "auth.field.password",
  display_name: "auth.field.displayName",
};

/** Campo do formulário a que um erro de validação do servidor se refere ("body.username" => "username"). */
export function fieldOf(location?: string): string | undefined {
  const name = location?.split(".").pop();
  return name && name in fieldLabels ? name : undefined;
}

/** Mensagem geral para um erro de API, para toasts e erros sem campo. */
export function messageFor(err: unknown): string {
  if (!isApiError(err)) return t("system.error.network");
  switch (err.status) {
    case 401:
      return t("system.error.badLogin");
    case 409:
      return translateDetail(err.detail);
    case 413:
      return t("system.error.fileTooLarge");
    case 429:
      return t("system.error.tooManyRetry");
    case 422:
      return t("system.error.invalidFields");
    default:
      return err.status >= 500 ? t("system.error.server") : translateDetail(err.detail);
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
    const text = translateDetail(err.detail);
    setError(conflict as Path<T>, { message: text.charAt(0).toUpperCase() + text.slice(1) });
    return true;
  }
  if (err.status === 422) {
    let any = false;
    for (const e of err.errors) {
      const f = fieldOf(e.location);
      if (f) {
        setError(f as Path<T>, {
          message: t("auth.validation.fieldInvalid", { field: t(fieldLabels[f] as MessageKey) }),
        });
        any = true;
      }
    }
    return any;
  }
  return false;
}
