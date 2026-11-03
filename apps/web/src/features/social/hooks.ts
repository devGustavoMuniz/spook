import {
  acceptFriend,
  blockUser,
  getGetUserRelationshipQueryKey,
  getListRelationshipsQueryKey,
  isApiError,
  listRelationships,
  type Relationship,
  removeFriend,
  requestFriend,
  unblockUser,
} from "@spook/shared";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { appMessage } from "@/lib/app-errors";
import { useSocialStore } from "./store";

/** Prefixo que casa com a lista completa e com o estado de cada pessoa (cartão de perfil). */
const LIST_PREFIX = getListRelationshipsQueryKey();
const MAX_PAGES = 20; // 1000 amigos + 200 pedidos + 500 bloqueados cabem folgado em páginas de 200

export const relationshipsKey = () => LIST_PREFIX;

/** A lista completa (todas as páginas) de amigos, pedidos e bloqueados, para a tela de Amigos. */
export function useAllRelationships() {
  return useQuery({
    queryKey: relationshipsKey(),
    queryFn: async ({ signal }) => {
      const out: Relationship[] = [];
      let after: string | undefined;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await listRelationships(
          { limit: 200, ...(after ? { after } : {}) },
          { signal },
        );
        out.push(...(page.items ?? []));
        if (!page.next_after) break;
        after = page.next_after;
      }
      return out;
    },
    staleTime: 30_000,
  });
}

/** Eventos e ações mudaram algo: refaz a lista e o estado das pessoas já consultadas. */
export function invalidateRelationships(qc: QueryClient, userId?: string) {
  void qc.invalidateQueries({ queryKey: relationshipsKey() });
  if (userId) void qc.invalidateQueries({ queryKey: getGetUserRelationshipQueryKey(userId) });
  else
    void qc.invalidateQueries({
      predicate: (q) => /^\/api\/users\/[^/]+\/relationship$/.test(String(q.queryKey[0])),
    });
}

/** Mensagem em pt-br dos erros de amizade e bloqueio. */
export function socialMessage(err: unknown): string {
  if (!isApiError(err)) return appMessage(err);
  switch (err.status) {
    case 404:
      return "Não encontramos ninguém com esse nome de usuário.";
    case 409:
      return err.detail
        ? err.detail.charAt(0).toUpperCase() + err.detail.slice(1)
        : appMessage(err);
    case 422:
      return err.detail
        ? err.detail.charAt(0).toUpperCase() + err.detail.slice(1)
        : appMessage(err);
    case 429:
      return err.retryAfter
        ? `Muitas ações seguidas. Tente de novo em ${err.retryAfter} s.`
        : "Muitas ações seguidas. Aguarde um instante.";
    default:
      return appMessage(err);
  }
}

/** Ações de amizade e bloqueio com aviso de sucesso/erro; cada uma devolve `true` se deu certo. */
export function useSocialActions() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(
    async (key: string, userId: string | undefined, fn: () => Promise<void>) => {
      setPending(key);
      try {
        await fn();
        invalidateRelationships(qc, userId);
        return true;
      } catch (e) {
        toast.error(socialMessage(e));
        return false;
      } finally {
        setPending(null);
      }
    },
    [qc],
  );

  return {
    pending,
    request: (username: string) =>
      run("request", undefined, async () => {
        const rel = await requestFriend({ username });
        useSocialStore.getState().upsert(rel);
        toast.success(
          rel.type === "friend"
            ? `Você e @${rel.user.username} agora são amigos.`
            : `Pedido enviado para @${rel.user.username}.`,
        );
      }),
    accept: (userId: string) =>
      run(`accept:${userId}`, userId, async () => {
        const rel = await acceptFriend(userId);
        useSocialStore.getState().upsert(rel);
        toast.success(`Você e @${rel.user.username} agora são amigos.`);
      }),
    /** Desfazer, recusar ou cancelar o pedido: o mesmo DELETE. */
    remove: (userId: string, done?: string) =>
      run(`remove:${userId}`, userId, async () => {
        await removeFriend(userId);
        useSocialStore.getState().remove(userId);
        if (done) toast.success(done);
      }),
    block: (userId: string, done?: string) =>
      run(`block:${userId}`, userId, async () => {
        const rel = await blockUser(userId);
        useSocialStore.getState().upsert(rel);
        if (done) toast.success(done);
      }),
    unblock: (userId: string, done?: string) =>
      run(`unblock:${userId}`, userId, async () => {
        await unblockUser(userId);
        useSocialStore.getState().remove(userId);
        if (done) toast.success(done);
      }),
  };
}
