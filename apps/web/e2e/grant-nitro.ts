import { execSync } from "node:child_process";

// Concede Nitro a uma conta do teste direto no banco (como E2E_PROMOTE_CMD faz com o admin). GIF e imagens
// animadas em avatar e banner exigem Nitro (SPEC 5.5, "Adicional: Nitro e Nitro+"). O comando vem de E2E_GRANT_CMD,
// com `{username}` no lugar do username; sem ele os testes que precisam de Nitro são pulados.
export const grantCmd = process.env.E2E_GRANT_CMD;

export function grantNitro(username: string) {
  execSync((grantCmd as string).replaceAll("{username}", username), { stdio: "pipe" });
}
