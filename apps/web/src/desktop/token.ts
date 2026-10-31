// Token de sessão do desktop (SPEC 5.5, Fase 7a). Vive no chaveiro do SO, via comandos Rust; esta cópia em
// memória é o que as requisições leem (síncrono). Se o chaveiro não estiver disponível, o Rust guarda só em
// memória e avisa (`persistent: false`): o usuário precisa entrar de novo ao reabrir o app. Nunca em arquivo.
import { toast } from "sonner";
import { invoke } from "./ipc";
import { isTauri } from "./runtime";

type TokenState = { token: string | null; persistent: boolean };

let current: string | null = null;

/** Token em uso pelas requisições (nulo = sem sessão). */
export const sessionToken = (): string | null => current;

export const VOLATILE_TOKEN_WARNING =
  "Não foi possível usar o chaveiro do sistema. Você continua conectado enquanto o Spook estiver aberto, mas precisará entrar de novo ao reabri-lo.";

/** Lê o token guardado (chamado uma vez na inicialização, antes de montar a interface). */
export async function loadSessionToken(): Promise<void> {
  try {
    current = (await invoke<TokenState>("auth_get_token")).token;
  } catch {
    current = null;
  }
}

/** Guarda o token recebido no login/cadastro. Sem efeito na web (cookie) ou sem token no corpo. */
export async function persistSessionToken(token: string | undefined | null): Promise<void> {
  if (!isTauri() || !token) return;
  current = token;
  try {
    const state = await invoke<TokenState>("auth_set_token", { token });
    if (!state.persistent) toast.warning(VOLATILE_TOKEN_WARNING, { duration: 12_000 });
  } catch {
    toast.warning(VOLATILE_TOKEN_WARNING, { duration: 12_000 });
  }
}

/** Esquece o token (logout, sessão expirada). Sem efeito na web. */
export async function clearSessionToken(): Promise<void> {
  if (!isTauri()) return;
  current = null;
  try {
    await invoke("auth_clear_token");
  } catch {
    // O token em memória já foi descartado; o chaveiro será sobrescrito no próximo login.
  }
}

/** Cabeçalhos de toda requisição no desktop: identifica o cliente e leva o Bearer. */
export function desktopHeaders(): Record<string, string> {
  return current
    ? { "X-Spook-Client": "desktop", Authorization: `Bearer ${current}` }
    : { "X-Spook-Client": "desktop" };
}
