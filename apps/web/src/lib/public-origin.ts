import { getApiBaseUrl } from "@spook/shared";

/**
 * Origem pública do Spook, a que vai em links compartilhados (convites). No navegador é a da própria página; no app
 * desktop a página roda em `tauri.localhost`/`tauri://localhost`, que ninguém mais alcança: vale a base da API
 * (`VITE_API_BASE_URL`, o domínio de produção).
 */
export function publicOrigin(): string {
  const base = getApiBaseUrl();
  if (base) {
    try {
      return new URL(base).origin;
    } catch {
      // base inválida: cai para a origem da página
    }
  }
  return window.location.origin;
}
