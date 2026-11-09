import {
  type ApiError,
  getGetMyPlanQueryKey,
  isApiError,
  useCreateBillingCheckout,
  useRedeemPlanCode,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Crown, Gift, Minus, Zap } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup } from "@/features/settings/ui";
import { type MessageKey, useT } from "@/i18n";
import { messageFor } from "@/lib/errors";
import { formatDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  clearPaymentReturn,
  formatPrice,
  type PaymentReturn,
  readPaymentReturn,
  useBilling,
} from "./billing";
import { NitroBadge } from "./nitro-badge";
import { PLAN_LIMITS, PLAN_TIERS, type PlanTier } from "./plans";
import { publishPlan, refreshPlan, usePlan } from "./use-plan";

/** Quantos dias antes do vencimento a seção avisa. */
export const EXPIRING_SOON_DAYS = 7;

const DAY_MS = 86_400_000;

/** Mensagem clara para cada falha do resgate (404 inválido, 409 usado, 410 vencido, 429 limite). */
export function redeemErrorKey(err: unknown): MessageKey {
  if (!isApiError(err)) return "system.error.network";
  switch ((err as ApiError).status) {
    case 404:
      return "nitro.redeem.invalid";
    case 409:
      return "nitro.redeem.used";
    case 410:
      return "nitro.redeem.expired";
    case 429:
      return "nitro.redeem.rateLimited";
    default:
      return "nitro.redeem.failed";
  }
}

/** Mensagem clara para cada falha ao abrir o checkout. */
export function checkoutErrorKey(err: unknown): MessageKey {
  if (!isApiError(err)) return "system.error.network";
  if (err.status === 503) return "nitro.subscribe.unavailable";
  if (err.status === 429) return "nitro.subscribe.rateLimited";
  return "nitro.subscribe.failed";
}

/** Botões "Assinar" (só existem com o pagamento ligado): criam o checkout e levam ao Mercado Pago. */
function SubscribeButtons() {
  const { t } = useT();
  const { enabled, currency, plans } = useBilling();
  const checkout = useCreateBillingCheckout();
  const [error, setError] = useState<string | null>(null);
  if (!enabled || plans.length === 0) return null;

  async function subscribe(tier: "nitro" | "nitro_plus") {
    setError(null);
    try {
      const { init_point } = await checkout.mutateAsync({ data: { tier } });
      window.location.assign(init_point);
    } catch (err) {
      setError(t(checkoutErrorKey(err)));
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="nitro-subscribe">
      <p className="text-sm text-muted-foreground">{t("nitro.subscribe.description")}</p>
      <div className="flex flex-wrap gap-3">
        {plans.map((p) => (
          <div key={p.tier} className="flex flex-col gap-1">
            <Button
              variant="outline"
              loading={checkout.isPending && checkout.variables?.data.tier === p.tier}
              disabled={checkout.isPending}
              onClick={() => void subscribe(p.tier)}
            >
              {t("nitro.subscribe.cta", { plan: t(`nitro.tier.${p.tier}`) })}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t("nitro.subscribe.price", {
                price: formatPrice(p.price_cents, currency),
                days: p.days,
              })}
            </span>
          </div>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Aviso do retorno do Mercado Pago. No sucesso o plano chega pelo webhook (assíncrono): consulta o plano a cada
 * `pollMs` até ele mudar ou até `maxPolls` tentativas.
 */
function PaymentNotice({
  result,
  pollMs,
  maxPolls,
}: {
  result: PaymentReturn;
  pollMs: number;
  maxPolls: number;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const plan = usePlan();
  const [state, setState] = useState<"waiting" | "done" | "late">("waiting");
  const start = useRef<{ tier: string; expiresAt: string | null } | null>(null);
  if (plan.loading === false && start.current === null) {
    start.current = { tier: plan.tier, expiresAt: plan.expiresAt };
  }
  const changed =
    start.current !== null &&
    (plan.tier !== start.current.tier || plan.expiresAt !== start.current.expiresAt);

  useEffect(() => {
    clearPaymentReturn();
  }, []);

  useEffect(() => {
    if (result !== "success" || state !== "waiting") return;
    if (changed) {
      setState("done");
      toast.success(t("nitro.toast.activated", { plan: t(`nitro.tier.${plan.tier}`) }));
      return;
    }
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      void refreshPlan(qc);
      if (n >= maxPolls) {
        window.clearInterval(id);
        setState("late");
      }
    }, pollMs);
    return () => window.clearInterval(id);
  }, [result, state, changed, pollMs, maxPolls, qc, t, plan.tier]);

  if (result === "failure") {
    return (
      <output
        data-testid="nitro-payment"
        className="block rounded-md border border-border px-3 py-2 text-sm"
      >
        {t("nitro.payment.failure")}
      </output>
    );
  }
  if (result === "pending") {
    return (
      <output
        data-testid="nitro-payment"
        className="block rounded-md border border-border px-3 py-2 text-sm"
      >
        {t("nitro.payment.pending")}
      </output>
    );
  }
  return (
    <output
      data-testid="nitro-payment"
      className="block rounded-md border border-border px-3 py-2 text-sm"
    >
      <strong className="block font-semibold">{t("nitro.payment.success.title")}</strong>
      {state === "done"
        ? t("nitro.payment.success.done", { plan: t(`nitro.tier.${plan.tier}`) })
        : state === "late"
          ? t("nitro.payment.success.late")
          : t("nitro.payment.success.waiting")}
    </output>
  );
}

function Cell({ on }: { on: boolean }) {
  const { t } = useT();
  return on ? (
    <>
      <Check className="mx-auto size-4 text-success-text" aria-hidden />
      <span className="sr-only">{t("nitro.compare.yes")}</span>
    </>
  ) : (
    <>
      <Minus className="mx-auto size-4 text-muted-foreground" aria-hidden />
      <span className="sr-only">{t("nitro.compare.no")}</span>
    </>
  );
}

/** Tabela Grátis / Nitro / Nitro+ (valores da matriz espelhada em `plans.ts`). */
function CompareTable({ current }: { current: PlanTier }) {
  const { t } = useT();
  const rows: { key: MessageKey; cell: (tier: PlanTier) => React.ReactNode }[] = [
    {
      key: "nitro.compare.screen",
      cell: (tier) =>
        t("nitro.compare.screenValue", {
          height: PLAN_LIMITS[tier].screen_max_height,
          fps: PLAN_LIMITS[tier].screen_max_fps,
        }),
    },
    {
      key: "nitro.compare.animatedAvatar",
      cell: (tier) => <Cell on={PLAN_LIMITS[tier].animated_avatar} />,
    },
    {
      key: "nitro.compare.animatedBanner",
      cell: (tier) => <Cell on={PLAN_LIMITS[tier].animated_banner} />,
    },
    { key: "nitro.compare.badge", cell: (tier) => <Cell on={tier !== "free"} /> },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] border-collapse text-sm">
        <thead>
          <tr>
            <th
              scope="col"
              className="py-2 pr-3 text-left text-xs font-medium text-muted-foreground"
            >
              {t("nitro.compare.feature")}
            </th>
            {PLAN_TIERS.map((tier) => (
              <th
                key={tier}
                scope="col"
                aria-current={tier === current ? "true" : undefined}
                className={cn(
                  "px-3 py-2 text-center font-semibold",
                  tier === current && "rounded-t-lg bg-accent",
                )}
              >
                <span className="inline-flex flex-col items-center gap-1">
                  {t(`nitro.tier.${tier}`)}
                  {tier === current ? (
                    <span className="text-[0.6875rem] font-medium text-brand-text">
                      {t("nitro.compare.current")}
                    </span>
                  ) : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                {t(r.key)}
              </th>
              {PLAN_TIERS.map((tier) => (
                <td
                  key={tier}
                  className={cn("px-3 py-2.5 text-center", tier === current && "bg-accent")}
                >
                  {r.cell(tier)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RedeemForm() {
  const { t } = useT();
  const qc = useQueryClient();
  const redeem = useRedeemPlanCode();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (!value) {
      setError(t("nitro.redeem.empty"));
      return;
    }
    setError(null);
    try {
      const plan = await redeem.mutateAsync({ data: { code: value } });
      qc.setQueryData(getGetMyPlanQueryKey(), plan);
      publishPlan(plan);
      setCode("");
      toast.success(t("nitro.toast.activated", { plan: t(`nitro.tier.${plan.tier}`) }));
    } catch (err) {
      setError(
        isApiError(err) && ![404, 409, 410, 429].includes(err.status)
          ? messageFor(err)
          : t(redeemErrorKey(err)),
      );
    }
  }

  return (
    <SettingsGroup
      icon={Gift}
      title={t("nitro.redeem.title")}
      description={t("nitro.redeem.description")}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {t("nitro.redeem.label")}
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={id}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("nitro.redeem.placeholder")}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="submit" loading={redeem.isPending}>
            {t("nitro.redeem.submit")}
          </Button>
        </div>
        {error ? (
          <p id={`${id}-error`} role="alert" className="text-xs text-destructive-text">
            {error}
          </p>
        ) : null}
      </form>
    </SettingsGroup>
  );
}

/** Configurações > Nitro: plano atual, validade e origem, aviso de vencimento, comparação e resgate. */
export function NitroSection({
  paymentReturn,
  pollMs = 2000,
  maxPolls = 15,
}: {
  /** Retorno do Mercado Pago; omitido, vem de `?payment=` na URL (lido uma vez). */
  paymentReturn?: PaymentReturn | null;
  pollMs?: number;
  maxPolls?: number;
} = {}) {
  const { t } = useT();
  const [payment] = useState<PaymentReturn | null>(() =>
    paymentReturn === undefined ? readPaymentReturn() : paymentReturn,
  );
  const plan = usePlan();
  const paid = plan.tier !== "free";
  const planName = t(`nitro.tier.${plan.tier}`);
  const msLeft = plan.expiresAt ? new Date(plan.expiresAt).getTime() - Date.now() : null;
  const expiring = paid && msLeft !== null && msLeft <= EXPIRING_SOON_DAYS * DAY_MS;

  return (
    <div className="flex flex-col gap-6">
      {payment ? <PaymentNotice result={payment} pollMs={pollMs} maxPolls={maxPolls} /> : null}
      <SettingsGroup
        icon={plan.tier === "nitro_plus" ? Crown : Zap}
        title={t("nitro.current.title")}
        description={t("nitro.current.description")}
      >
        <div className="flex flex-col gap-2" data-testid="nitro-current">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {paid ? t("nitro.current.plan", { plan: planName }) : t("nitro.current.free")}
            <NitroBadge tier={plan.tier} showLabel />
          </p>
          {paid ? (
            <p className="text-sm text-muted-foreground">
              {plan.expiresAt
                ? t("nitro.current.expires", { date: formatDay(plan.expiresAt) })
                : t("nitro.current.permanent")}
            </p>
          ) : null}
          {paid && plan.source ? (
            <p className="text-sm text-muted-foreground">
              {t("nitro.source.label")}: {t(`nitro.source.${plan.source}`)}
            </p>
          ) : null}
        </div>
        {expiring && plan.expiresAt ? (
          <output
            data-testid="nitro-expiring"
            className="block rounded-md border border-warning-text/40 bg-warning-soft px-3 py-2 text-sm text-warning-text"
          >
            <strong className="block font-semibold">
              {t("nitro.expiring.title", { plan: planName })}
            </strong>
            {t("nitro.expiring.body", { date: formatDay(plan.expiresAt) })}
          </output>
        ) : null}
        <SubscribeButtons />
      </SettingsGroup>

      <SettingsGroup
        icon={Crown}
        title={t("nitro.compare.title")}
        description={t("nitro.compare.description")}
      >
        <CompareTable current={plan.tier} />
        <p className="text-xs text-pretty text-muted-foreground">{t("nitro.compare.note")}</p>
      </SettingsGroup>

      <RedeemForm />
    </div>
  );
}
