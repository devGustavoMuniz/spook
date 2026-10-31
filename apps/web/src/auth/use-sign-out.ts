import { getGetMeQueryKey, isApiError, useLogout } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

export function useSignOut() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useLogout();

  async function signOut() {
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
