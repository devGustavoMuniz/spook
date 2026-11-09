import {
  getGetMyPlanQueryKey,
  getMyPlan,
  type PlanPayload,
  type PlanTier,
  useGetMyPlan,
} from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useLimitsStore } from "./limits-store";
import { limitsOf, type PlanLimits, tierAtLeast } from "./plans";

export type PlanSource = "admin" | "code" | "payment" | null;

export type PlanState = {
  tier: PlanTier;
  limits: PlanLimits;
  /** ISO; `null` = permanente (ou plano grátis). */
  expiresAt: string | null;
  source: PlanSource;
  isAtLeast: (tier: PlanTier) => boolean;
  /** Ainda não sabemos (primeira carga): vale como grátis. */
  loading: boolean;
};

/** Publica os limites do plano para o código fora do React (voz). */
export function publishPlan(p: PlanPayload | undefined | null) {
  useLimitsStore.getState().setPlan(p ? p.limits : null);
}

/** Busca o plano agora (na conexão do gateway e depois de um buraco de eventos) e guarda no cache. */
export async function refreshPlan(qc: QueryClient): Promise<void> {
  try {
    const p = await qc.fetchQuery({
      queryKey: getGetMyPlanQueryKey(),
      queryFn: () => getMyPlan(),
      staleTime: 0,
    });
    publishPlan(p);
  } catch {
    // sem rede: vale o que já estava no cache (ou grátis)
  }
}

/** O plano da própria pessoa: `GET /api/me/plan`, mantido por `ENTITLEMENT_UPDATE` (ver cache-bindings). */
export function usePlan(): PlanState {
  const q = useGetMyPlan({ query: { staleTime: 5 * 60_000 } });
  const data = q.data;
  useEffect(() => {
    if (data) publishPlan(data);
  }, [data]);
  const tier: PlanTier = data?.tier ?? "free";
  return {
    tier,
    limits: data?.limits ?? limitsOf(tier),
    expiresAt: data?.expires_at ?? null,
    source: (data?.source as PlanSource | undefined) ?? null,
    isAtLeast: (min) => tierAtLeast(tier, min),
    loading: q.isPending,
  };
}
