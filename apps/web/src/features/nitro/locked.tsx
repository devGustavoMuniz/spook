import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import type { PlanTier } from "./plans";
import { useOpenNitro } from "./use-open-nitro";
import { usePlan } from "./use-plan";

/** Texto curto "Requer Nitro" / "Requer Nitro+" com cadeado (nunca só cor ou só ícone). */
export function RequiresLabel({ requires, className }: { requires: PlanTier; className?: string }) {
  const { t } = useT();
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", className)}>
      <Lock className="size-3" aria-hidden />
      {t("nitro.locked.requires", { plan: t(`nitro.tier.${requires}`) })}
    </span>
  );
}

/**
 * Recurso que exige um plano: com o plano, mostra o conteúdo; sem ele, mostra o conteúdo esmaecido com cadeado e
 * "Requer Nitro", e o clique abre Configurações > Nitro. O servidor recusa de qualquer forma; isto só orienta.
 */
export function Locked({
  requires,
  label,
  children,
  className,
}: {
  requires: "nitro" | "nitro_plus";
  /** Nome do recurso, para o leitor de tela ("<recurso>: requer Nitro. Ver planos."). */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useT();
  const plan = usePlan();
  const open = useOpenNitro();
  if (plan.isAtLeast(requires)) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={open}
      aria-label={t("nitro.locked.open", { label, plan: t(`nitro.tier.${requires}`) })}
      className={cn(
        "inline-flex items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span aria-hidden className="opacity-60">
        {children}
      </span>
      <RequiresLabel requires={requires} className="text-muted-foreground" />
    </button>
  );
}
