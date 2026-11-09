import {
  type EntitlementUpdateData,
  getGetMeQueryKey,
  getGetMyPlanQueryKey,
  type PlanPayload,
  type View,
} from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { t } from "@/i18n";
import { publishPlan } from "./use-plan";

/**
 * ENTITLEMENT_UPDATE (só para a própria pessoa, todas as sessões): o plano mudou (concedido, resgatado, revogado
 * ou vencido). Atualiza o cache do plano e o `plan` do meu perfil, publica os limites para a voz e avisa.
 */
export function applyEntitlementUpdate(qc: QueryClient, d: EntitlementUpdateData) {
  const next: PlanPayload = {
    tier: d.tier,
    expires_at: d.expires_at,
    source: d.source,
    limits: d.limits,
  };
  qc.setQueryData<PlanPayload>(getGetMyPlanQueryKey(), next);
  qc.setQueryData<View>(getGetMeQueryKey(), (old) => (old ? { ...old, plan: d.tier } : old));
  publishPlan(next);
  const plan = t(`nitro.tier.${d.tier}`);
  switch (d.reason) {
    case "expired":
      toast.info(t("nitro.toast.expired"));
      return;
    case "granted":
    case "redeemed":
      toast.success(t("nitro.toast.activated", { plan }));
      return;
    case "revoked":
      toast.info(t("nitro.toast.changed", { plan }));
      return;
  }
}
