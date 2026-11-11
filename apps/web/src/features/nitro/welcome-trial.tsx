import { useGetMe } from "@spook/shared";
import { Gift, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useOpenNitro } from "./use-open-nitro";
import { usePlan } from "./use-plan";

const DAY_MS = 86_400_000;
const keyFor = (userId: string) => `spook:nitro-welcome-seen:${userId}`;

function seenBefore(userId: string): boolean {
  try {
    return localStorage.getItem(keyFor(userId)) === "1";
  } catch {
    return false;
  }
}

function markSeen(userId: string) {
  try {
    localStorage.setItem(keyFor(userId), "1");
  } catch {
    // sem localStorage: o aviso some só até recarregar
  }
}

/**
 * Faixa dispensável de boas-vindas do período de cortesia (`source === "trial"` em `GET /api/me/plan`): aparece
 * uma vez por pessoa e navegador (guardado em `localStorage`), com os dias reais que faltam. Dispensar ou abrir
 * "Ver o que inclui" marca como vista.
 */
export function WelcomeTrialBanner() {
  const { t } = useT();
  const { data: me } = useGetMe();
  const plan = usePlan();
  const openNitro = useOpenNitro();
  const [dismissed, setDismissed] = useState(false);
  if (!me || dismissed || plan.source !== "trial" || plan.tier === "free" || !plan.expiresAt)
    return null;
  if (seenBefore(me.id)) return null;
  const days = Math.max(1, Math.ceil((new Date(plan.expiresAt).getTime() - Date.now()) / DAY_MS));
  const close = () => {
    markSeen(me.id);
    setDismissed(true);
  };
  return (
    <output
      data-testid="nitro-welcome"
      className="flex items-center gap-3 border-b border-border bg-accent px-4 py-2 text-sm"
    >
      <Gift className="size-4 shrink-0 text-brand-text" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-pretty">
        <strong className="font-semibold">
          {t("nitro.welcome.title", { count: days, plan: t(`nitro.tier.${plan.tier}`) })}
        </strong>{" "}
        <span className="text-muted-foreground">{t("nitro.welcome.body")}</span>
      </p>
      <Button
        size="sm"
        variant="soft"
        onClick={() => {
          close();
          openNitro();
        }}
      >
        {t("nitro.welcome.cta")}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("nitro.welcome.dismiss")}
        onClick={close}
      >
        <X aria-hidden="true" />
      </Button>
    </output>
  );
}
