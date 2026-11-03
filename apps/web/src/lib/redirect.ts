/** Destino pós-login vindo da URL: só caminhos internos (evita redirecionar para outro site). */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return undefined;
  if (value === "/login" || value === "/register") return undefined;
  return value;
}

/** Códigos de `?social_error=` que o backend pode devolver depois do login social. */
const SOCIAL_ERROR = /^[a-z_]{1,32}$/;

export const authSearch = (
  s: Record<string, unknown>,
): { redirect?: string; social_error?: string } => {
  const redirect = safeRedirect(s.redirect);
  const social_error =
    typeof s.social_error === "string" && SOCIAL_ERROR.test(s.social_error)
      ? s.social_error
      : undefined;
  return { ...(redirect ? { redirect } : {}), ...(social_error ? { social_error } : {}) };
};
