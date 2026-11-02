import { isApiError, useGetMe } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/** Rail de servidores + área de conteúdo; observa a sessão (401 em outra aba volta ao login). */
export function useSessionGuard() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useGetMe();
  useEffect(() => {
    if (isApiError(me.error) && me.error.status === 401) {
      qc.clear();
      void navigate({ to: "/login" });
    }
  }, [me.error, qc, navigate]);
}
