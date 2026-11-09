/**
 * Gancho do pagamento (Task 4: Mercado Pago, atrás de flag). Enquanto não existir `GET /api/billing/config`, o
 * botão "Assinar" fica escondido e nenhum pedido é feito. Quando a config chegar, troque por um hook que consulta
 * o servidor e devolve `enabled` (e os planos/preços vendidos).
 */
export const billingEnabled = false;
