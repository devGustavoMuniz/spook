import { getGetMeQueryKey, isApiError, useLogout } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { detachPushFromAccount } from "@/features/push/push";

export function useSignOut() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useLogout();

  async function signOut() {
    // Este navegador deixa de receber push desta conta (a sessão ainda vale para o DELETE); nunca trava a saída.
    await Promise.race([
      detachPushFromAccount().catch(() => {}),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    try {
      await logout.mutateAsync();
    } catch (e) {
      // 401 = a sessão já tinha caído; o resultado desejado (deslogado) é o mesmo.
      if (!isApiError(e) || e.status !== 401) {
        toast.error("Não foi possível sair. Tente novamente.");
        return;
      }
    }
    qc.removeQueries({ queryKey: getGetMeQueryKey() });
    qc.clear();
    await navigate({ to: "/login" });
  }
  return { signOut, pending: logout.isPending };
}
