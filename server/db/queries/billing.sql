-- Pagamento do Nitro pelo Mercado Pago (feature billing).

-- name: InsertBillingOrder :one
INSERT INTO orders (id, user_id, tier, amount_cents, currency, days)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: SetBillingOrderPreference :exec
UPDATE orders SET mp_preference_id = $2 WHERE id = $1;

-- name: GetBillingOrder :one
SELECT * FROM orders WHERE id = $1;

-- Trava o pedido até o fim da transação: duas entregas do webhook do mesmo pedido viram uma fila.
-- name: LockBillingOrder :one
SELECT * FROM orders WHERE id = $1 FOR UPDATE;

-- Devolve a linha só quando o pagamento é novo (a reentrega cai no conflito e não devolve nada).
-- name: InsertBillingPayment :one
INSERT INTO payments (id, order_id, mp_payment_id, raw_status, amount_cents, currency)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT DO NOTHING
RETURNING *;

-- name: AttachBillingPayment :exec
UPDATE payments SET entitlement_id = $2 WHERE id = $1;

-- name: MarkBillingOrderPaid :exec
UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1;

-- name: GetBillingPaymentByMP :one
SELECT * FROM payments WHERE mp_payment_id = $1 FOR UPDATE;

-- name: MarkBillingPaymentRefunded :exec
UPDATE payments SET status = 'refunded', raw_status = $2, refunded_at = now() WHERE id = $1;

-- name: MarkBillingOrderRefunded :exec
UPDATE orders SET status = 'refunded' WHERE id = $1;
