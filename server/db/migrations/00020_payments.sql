-- +goose Up
-- Pagamento do Nitro e Nitro+ pelo Mercado Pago (adicional fora do SPEC). Aditiva: tabelas novas, nada existente muda.
-- orders: pedido de uma assinatura de 30 dias criado no checkout (valor e moeda congelados no momento do pedido; o
-- webhook só concede se o pagamento tiver exatamente este valor e esta moeda). status: pending (aguardando),
-- paid (pagamento aprovado e plano concedido) ou refunded (estornado, concessão revogada).
CREATE TABLE orders (
    id                bigint      PRIMARY KEY,
    user_id           bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tier              text        NOT NULL CHECK (tier IN ('nitro', 'nitro_plus')),
    amount_cents      int         NOT NULL CHECK (amount_cents > 0),
    currency          text        NOT NULL,
    days              int         NOT NULL CHECK (days BETWEEN 1 AND 3650),
    status            text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'refunded')),
    mp_preference_id  text        NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    paid_at           timestamptz NULL
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);

-- payments: pagamentos do Mercado Pago já processados. mp_payment_id UNIQUE garante a idempotência da reentrega do
-- webhook; order_id UNIQUE garante um pagamento por pedido. entitlement_id liga ao plano concedido (nulo se a
-- concessão foi apagada). raw_status é o status do Mercado Pago na última leitura.
CREATE TABLE payments (
    id             bigint      PRIMARY KEY,
    order_id       bigint      NOT NULL UNIQUE REFERENCES orders (id) ON DELETE CASCADE,
    mp_payment_id  bigint      NOT NULL UNIQUE,
    status         text        NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'refunded')),
    raw_status     text        NOT NULL,
    amount_cents   int         NOT NULL,
    currency       text        NOT NULL,
    entitlement_id bigint      NULL REFERENCES entitlements (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    refunded_at    timestamptz NULL
);

-- +goose Down
DROP TABLE payments;
DROP TABLE orders;
