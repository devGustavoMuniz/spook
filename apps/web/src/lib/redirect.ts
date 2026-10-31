/** Destino pós-login vindo da URL: só caminhos internos (evita redirecionar para outro site). */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return undefined;
  if (value === "/login" || value === "/register") return undefined;
  return value;
}

export const authSearch = (s: Record<string, unknown>): { redirect?: string } => {
  const redirect = safeRedirect(s.redirect);
  return redirect ? { redirect } : {};
};
