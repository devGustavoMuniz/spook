package billing

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// PGStore implementa Store sobre o Postgres.
type PGStore struct {
	db  db.DB
	q   *dbgen.Queries
	ids IDGenerator
}

func NewStore(d db.DB, ids IDGenerator) *PGStore { return &PGStore{db: d, q: dbgen.New(d), ids: ids} }

var _ Store = (*PGStore)(nil)

func wrap(op string, err error) error { return fmt.Errorf("%s: %w", op, err) }

func toOrder(r dbgen.Order) Order {
	return Order{ID: r.ID, UserID: r.UserID, Tier: plan.Tier(r.Tier), AmountCents: int(r.AmountCents), Currency: r.Currency, Days: int(r.Days), Status: r.Status}
}

func (s *PGStore) CreateOrder(ctx context.Context, o Order) error {
	_, err := s.q.InsertBillingOrder(ctx, dbgen.InsertBillingOrderParams{
		ID: o.ID, UserID: o.UserID, Tier: string(o.Tier), AmountCents: int32(o.AmountCents), Currency: o.Currency, Days: int32(o.Days),
	})
	if err != nil {
		return wrap("gravar pedido", err)
	}
	return nil
}

func (s *PGStore) SetPreference(ctx context.Context, orderID int64, preferenceID string) error {
	if err := s.q.SetBillingOrderPreference(ctx, dbgen.SetBillingOrderPreferenceParams{ID: orderID, MpPreferenceID: &preferenceID}); err != nil {
		return wrap("gravar preferência", err)
	}
	return nil
}

func (s *PGStore) Order(ctx context.Context, id int64) (Order, error) {
	r, err := s.q.GetBillingOrder(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, ErrOrderNotFound
	}
	if err != nil {
		return Order{}, wrap("buscar pedido", err)
	}
	return toOrder(r), nil
}

func (s *PGStore) Approve(ctx context.Context, orderID, mpPaymentID int64, rawStatus string, _ time.Time, grant func(Order) (int64, error)) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	row, err := q.LockBillingOrder(ctx, orderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrOrderNotFound
	}
	if err != nil {
		return false, wrap("travar pedido", err)
	}
	o := toOrder(row)
	if o.Status != "pending" {
		return false, nil
	}
	pay, err := q.InsertBillingPayment(ctx, dbgen.InsertBillingPaymentParams{
		ID: s.ids.Next(), OrderID: o.ID, MpPaymentID: mpPaymentID, RawStatus: rawStatus, AmountCents: int32(o.AmountCents), Currency: o.Currency,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // reentrega: o pagamento já foi processado
	}
	if err != nil {
		return false, wrap("gravar pagamento", err)
	}
	entID, err := grant(o)
	if err != nil {
		return false, err // desfaz o registro do pagamento: a próxima entrega do Mercado Pago tenta de novo
	}
	if err := q.AttachBillingPayment(ctx, dbgen.AttachBillingPaymentParams{ID: pay.ID, EntitlementID: &entID}); err != nil {
		return false, wrap("ligar concessão ao pagamento", err)
	}
	if err := q.MarkBillingOrderPaid(ctx, o.ID); err != nil {
		return false, wrap("marcar pedido pago", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, wrap("confirmar", err)
	}
	return true, nil
}

func (s *PGStore) Refund(ctx context.Context, mpPaymentID int64, rawStatus string, revoke func(entitlementID int64) error) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	pay, err := q.GetBillingPaymentByMP(ctx, mpPaymentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, wrap("buscar pagamento", err)
	}
	if pay.Status == "refunded" {
		return false, nil
	}
	if pay.EntitlementID != nil {
		if err := revoke(*pay.EntitlementID); err != nil {
			return false, err
		}
	}
	if err := q.MarkBillingPaymentRefunded(ctx, dbgen.MarkBillingPaymentRefundedParams{ID: pay.ID, RawStatus: rawStatus}); err != nil {
		return false, wrap("marcar estorno", err)
	}
	if err := q.MarkBillingOrderRefunded(ctx, pay.OrderID); err != nil {
		return false, wrap("marcar pedido estornado", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, wrap("confirmar", err)
	}
	return true, nil
}
