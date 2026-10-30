import { getGetMeQueryKey, getMe, isApiError, type View } from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";

/** Usuário autenticado, ou null se não houver sessão (401). Outros erros propagam. */
export async function fetchSession(qc: QueryClient): Promise<View | null> {
  try {
    return await qc.fetchQuery({
      queryKey: getGetMeQueryKey(),
      queryFn: ({ signal }) => getMe({ signal }),
      staleTime: 30_000,
    });
  } catch (e) {
    if (isApiError(e) && e.status === 401) {
      qc.removeQueries({ queryKey: getGetMeQueryKey() });
      return null;
    }
    throw e;
  }
}
