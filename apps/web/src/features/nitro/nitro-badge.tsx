import { Crown, Zap } from "lucide-react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { isPaidTier, type PlanTier } from "./plans";

const styles: Record<"nitro" | "nitro_plus", string> = {
  // Cores da identidade (packages/brand): Nitro no roxo da marca; Nitro+ no tom quente de destaque.
  nitro: "border-brand-500/40 bg-accent text-brand-text",
  nitro_plus: "border-warning-text/40 bg-warning-soft text-warning-text",
};

/**
 * Selo do plano: ícone + cor da identidade, discreto ao lado do nome. Só aparece para quem tem plano (grátis e
 * ausente não renderizam nada). O nome do plano vai no tooltip (`title`) e no rótulo para leitor de tela; com
 * `showLabel` o nome também fica visível (cartão de perfil, seção Nitro).
 */
export function NitroBadge({
  tier,
  showLabel = false,
  className,
}: {
  tier: PlanTier | undefined | null;
  showLabel?: boolean;
  className?: string;
}) {
  const { t } = useT();
  if (!isPaidTier(tier)) return null;
  const plan = t(`nitro.tier.${tier}`);
  const Icon = tier === "nitro_plus" ? Crown : Zap;
  return (
    <span
      role="img"
      data-nitro-badge={tier}
      title={t("nitro.badge.title", { plan })}
      aria-label={t("nitro.badge.aria", { plan })}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border align-middle leading-none font-semibold",
        showLabel ? "px-2 py-0.5 text-xs" : "size-4 justify-center",
        styles[tier],
        className,
      )}
    >
      <Icon className={showLabel ? "size-3" : "size-2.5"} aria-hidden />
      {showLabel ? <span aria-hidden>{plan}</span> : null}
    </span>
  );
}
