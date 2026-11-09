import { useGetBillingConfig } from "@spook/shared";

/** Retorno do Checkout Pro (`?payment=` das `back_urls`). */
export type PaymentReturn = "success" | "failure" | "pending";

/** Lê `?payment=` da URL atual (o retorno do Mercado Pago cai em `/settings/nitro?payment=...`). */
export function readPaymentReturn(search = window.location.search): PaymentReturn | null {
  const v = new URLSearchParams(search).get("payment");
  return v === "success" || v === "failure" || v === "pending" ? v : null;
}

/** Tira `?payment=` da barra de endereço (sem recarregar) para um F5 não repetir o aviso. */
export function clearPaymentReturn() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("payment")) return;
  url.searchParams.delete("payment");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export function formatPrice(cents: number, currency = "BRL"): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(cents / 100);
}

/**
 * O pagamento (Mercado Pago) está ligado neste servidor? `GET /api/billing/config`: desligado (ou erro) esconde
 * tudo, sem aviso. Preços e dias vêm do servidor.
 */
export function useBilling() {
  const q = useGetBillingConfig({ query: { staleTime: 5 * 60_000, retry: false } });
  const enabled = q.data?.enabled === true;
  return {
    enabled,
    currency: q.data?.currency ?? "BRL",
    plans: enabled ? (q.data?.plans ?? []) : [],
  };
}
