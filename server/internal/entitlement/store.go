package entitlement

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// Store é o que o service precisa do banco.
type Store interface {
	BatchStore
	// Live devolve as concessões da pessoa que não foram revogadas (vencidas ou não).
	Live(ctx context.Context, userID int64) ([]Grant, error)
	Account(ctx context.Context, userID int64) (Account, error) // ErrUserNotFound
	// Grant grava, sob trava da pessoa, a concessão que build monta a partir das concessões vivas dela.
	Grant(ctx context.Context, userID int64, build func(live []Grant) (Grant, error)) (Grant, error)
	// GrantTrial grava o período de cortesia (no máximo um por pessoa, mesmo revogado): ErrTrialExists se já houve.
	GrantTrial(ctx context.Context, userID int64, build func(live []Grant) (Grant, error)) (Grant, error)
	// Redeem consome o código (atômico: um só vence a corrida) e grava a concessão que build monta. Erros:
	// ErrCodeInvalid, ErrCodeUsed e ErrCodeExpired.
	Redeem(ctx context.Context, hash string, userID int64, now time.Time, build func(live []Grant, c Code) (Grant, error)) (Grant, Code, error)
	// Revoke revoga as concessões ativas da pessoa em now e devolve as revogadas.
	Revoke(ctx context.Context, userID int64, now time.Time) ([]Grant, error)
	RevokeOne(ctx context.Context, id int64, now time.Time) (Grant, error) // ErrGrantNotFound
	ListGrants(ctx context.Context, f GrantFilter, now time.Time) ([]GrantRow, int64, error)
	// ClaimExpired marca como avisadas as concessões vencidas e devolve (no máximo max) quais eram.
	ClaimExpired(ctx context.Context, now time.Time, max int) ([]Grant, error)
	InsertCodes(ctx context.Context, codes []Code) error
	ListCodes(ctx context.Context, f CodeFilter, now time.Time) ([]CodeRow, int64, error)
}

// PGStore implementa Store sobre o Postgres.
type PGStore struct {
	db db.DB
	q  *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{db: d, q: dbgen.New(d)} }

var _ Store = (*PGStore)(nil)

func wrap(op string, err error) error { return fmt.Errorf("%s: %w", op, err) }

func tsv(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func tsp(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{}
	}
	return tsv(*t)
}

func ptr(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time
	return &v
}

func toGrant(r dbgen.Entitlement) Grant {
	return Grant{
		ID: r.ID, UserID: r.UserID, Tier: plan.Tier(r.Tier), Source: Source(r.Source), ExpiresAt: ptr(r.ExpiresAt),
		GrantedBy: r.GrantedBy, RedeemCodeID: r.RedeemCodeID, BatchID: r.BatchID, RevokedAt: ptr(r.RevokedAt), CreatedAt: r.CreatedAt.Time,
	}
}

func toGrants(rs []dbgen.Entitlement) []Grant {
	out := make([]Grant, len(rs))
	for i, r := range rs {
		out[i] = toGrant(r)
	}
	return out
}

func toCode(r dbgen.RedeemCode) Code {
	c := Code{
		ID: r.ID, Hash: r.CodeHash, Hint: r.CodeHint, Tier: plan.Tier(r.Tier), CreatedBy: r.CreatedBy, RedeemedBy: r.RedeemedBy,
		RedeemedAt: ptr(r.RedeemedAt), ExpiresAt: ptr(r.ExpiresAt), CreatedAt: r.CreatedAt.Time,
	}
	if r.Days != nil {
		d := int(*r.Days)
		c.Days = &d
	}
	return c
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *PGStore) Live(ctx context.Context, userID int64) ([]Grant, error) {
	rs, err := s.q.ListLiveEntitlementsByUser(ctx, userID)
	if err != nil {
		return nil, wrap("listar concessões", err)
	}
	return toGrants(rs), nil
}

func (s *PGStore) Account(ctx context.Context, userID int64) (Account, error) {
	r, err := s.q.EntitlementUserExists(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, ErrUserNotFound
	}
	if err != nil {
		return Account{}, wrap("buscar usuário", err)
	}
	return Account{ID: r.ID, Username: r.Username, DisplayName: str(r.DisplayName)}, nil
}

func insertParams(g Grant) dbgen.InsertEntitlementParams {
	return dbgen.InsertEntitlementParams{
		ID: g.ID, UserID: g.UserID, Tier: string(g.Tier), Source: string(g.Source), ExpiresAt: tsp(g.ExpiresAt),
		GrantedBy: g.GrantedBy, RedeemCodeID: g.RedeemCodeID,
	}
}

// lock trava a linha da pessoa até o fim da transação: concessões e resgates dela viram uma fila.
func lock(ctx context.Context, q *dbgen.Queries, userID int64) error {
	if _, err := q.LockUserForEntitlement(ctx, userID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrUserNotFound
		}
		return wrap("travar usuário", err)
	}
	return nil
}

func (s *PGStore) Grant(ctx context.Context, userID int64, build func(live []Grant) (Grant, error)) (Grant, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Grant{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := lock(ctx, q, userID); err != nil {
		return Grant{}, err
	}
	live, err := q.ListLiveEntitlementsByUser(ctx, userID)
	if err != nil {
		return Grant{}, wrap("listar concessões", err)
	}
	g, err := build(toGrants(live))
	if err != nil {
		return Grant{}, err
	}
	row, err := q.InsertEntitlement(ctx, insertParams(g))
	if err != nil {
		return Grant{}, wrap("gravar concessão", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Grant{}, wrap("confirmar", err)
	}
	return toGrant(row), nil
}

func (s *PGStore) GrantTrial(ctx context.Context, userID int64, build func(live []Grant) (Grant, error)) (Grant, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Grant{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := lock(ctx, q, userID); err != nil {
		return Grant{}, err
	}
	had, err := q.HasTrialEntitlement(ctx, userID)
	if err != nil {
		return Grant{}, wrap("conferir período de cortesia", err)
	}
	if had {
		return Grant{}, ErrTrialExists
	}
	live, err := q.ListLiveEntitlementsByUser(ctx, userID)
	if err != nil {
		return Grant{}, wrap("listar concessões", err)
	}
	g, err := build(toGrants(live))
	if err != nil {
		return Grant{}, err
	}
	row, err := q.InsertEntitlement(ctx, insertParams(g))
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" { // índice único parcial: outra gravação chegou antes
		return Grant{}, ErrTrialExists
	}
	if err != nil {
		return Grant{}, wrap("gravar concessão", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Grant{}, wrap("confirmar", err)
	}
	return toGrant(row), nil
}

func (s *PGStore) Redeem(ctx context.Context, hash string, userID int64, now time.Time, build func(live []Grant, c Code) (Grant, error)) (Grant, Code, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Grant{}, Code{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := lock(ctx, q, userID); err != nil {
		return Grant{}, Code{}, err
	}
	uid := userID
	row, err := q.ClaimRedeemCode(ctx, dbgen.ClaimRedeemCodeParams{UserID: &uid, Now: tsv(now), CodeHash: hash})
	if errors.Is(err, pgx.ErrNoRows) {
		// Não consumiu: descobre por quê (a transação não grava nada).
		cur, gerr := q.GetRedeemCodeByHash(ctx, hash)
		switch {
		case errors.Is(gerr, pgx.ErrNoRows):
			return Grant{}, Code{}, ErrCodeInvalid
		case gerr != nil:
			return Grant{}, Code{}, wrap("buscar código", gerr)
		case cur.RedeemedBy != nil || cur.RedeemedAt.Valid:
			return Grant{}, Code{}, ErrCodeUsed
		default:
			return Grant{}, Code{}, ErrCodeExpired
		}
	}
	if err != nil {
		return Grant{}, Code{}, wrap("consumir código", err)
	}
	code := toCode(row)
	live, err := q.ListLiveEntitlementsByUser(ctx, userID)
	if err != nil {
		return Grant{}, Code{}, wrap("listar concessões", err)
	}
	g, err := build(toGrants(live), code)
	if err != nil {
		return Grant{}, Code{}, err
	}
	granted, err := q.InsertEntitlement(ctx, insertParams(g))
	if err != nil {
		return Grant{}, Code{}, wrap("gravar concessão", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Grant{}, Code{}, wrap("confirmar", err)
	}
	return toGrant(granted), code, nil
}

func (s *PGStore) Revoke(ctx context.Context, userID int64, now time.Time) ([]Grant, error) {
	rs, err := s.q.RevokeActiveEntitlementsByUser(ctx, dbgen.RevokeActiveEntitlementsByUserParams{Now: tsv(now), UserID: userID})
	if err != nil {
		return nil, wrap("revogar concessões", err)
	}
	return toGrants(rs), nil
}

func (s *PGStore) RevokeOne(ctx context.Context, id int64, now time.Time) (Grant, error) {
	r, err := s.q.RevokeEntitlementByID(ctx, dbgen.RevokeEntitlementByIDParams{Now: tsv(now), ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return Grant{}, ErrGrantNotFound
	}
	if err != nil {
		return Grant{}, wrap("revogar concessão", err)
	}
	return toGrant(r), nil
}

func offset(page int) int32 {
	if page < 1 {
		page = 1
	}
	return int32((page - 1) * AdminPageSize)
}

func (s *PGStore) ListGrants(ctx context.Context, f GrantFilter, now time.Time) ([]GrantRow, int64, error) {
	rs, err := s.q.AdminListEntitlements(ctx, dbgen.AdminListEntitlementsParams{
		Now: tsv(now), State: f.State, Tier: f.Tier, Q: f.Q, PageOffset: offset(f.Page), PageSize: AdminPageSize,
	})
	if err != nil {
		return nil, 0, wrap("listar concessões", err)
	}
	var total int64
	out := make([]GrantRow, len(rs))
	for i, r := range rs {
		total = r.Total
		out[i] = GrantRow{
			Grant: Grant{
				ID: r.ID, UserID: r.UserID, Tier: plan.Tier(r.Tier), Source: Source(r.Source), ExpiresAt: ptr(r.ExpiresAt),
				RevokedAt: ptr(r.RevokedAt), CreatedAt: r.CreatedAt.Time,
			},
			Username: r.Username, DisplayName: str(r.DisplayName), GrantedByUsername: str(r.GrantedByUsername), Active: r.Active,
		}
	}
	return out, total, nil
}

func (s *PGStore) ClaimExpired(ctx context.Context, now time.Time, max int) ([]Grant, error) {
	rs, err := s.q.ClaimExpiredEntitlements(ctx, dbgen.ClaimExpiredEntitlementsParams{Now: tsv(now), MaxRows: int32(max)})
	if err != nil {
		return nil, wrap("marcar concessões vencidas", err)
	}
	out := make([]Grant, len(rs))
	for i, r := range rs {
		out[i] = Grant{ID: r.ID, UserID: r.UserID, Tier: plan.Tier(r.Tier), Source: Source(r.Source)}
	}
	return out, nil
}

func (s *PGStore) InsertCodes(ctx context.Context, codes []Code) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	for _, c := range codes {
		var days *int32
		if c.Days != nil {
			d := int32(*c.Days)
			days = &d
		}
		if _, err := q.InsertRedeemCode(ctx, dbgen.InsertRedeemCodeParams{
			ID: c.ID, CodeHash: c.Hash, CodeHint: c.Hint, Tier: string(c.Tier), Days: days, CreatedBy: c.CreatedBy, ExpiresAt: tsp(c.ExpiresAt),
		}); err != nil {
			return wrap("gravar código", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return wrap("confirmar", err)
	}
	return nil
}

func (s *PGStore) ListCodes(ctx context.Context, f CodeFilter, now time.Time) ([]CodeRow, int64, error) {
	rs, err := s.q.AdminListRedeemCodes(ctx, dbgen.AdminListRedeemCodesParams{
		State: f.State, Now: tsv(now), Tier: f.Tier, PageOffset: offset(f.Page), PageSize: AdminPageSize,
	})
	if err != nil {
		return nil, 0, wrap("listar códigos", err)
	}
	var total int64
	out := make([]CodeRow, len(rs))
	for i, r := range rs {
		total = r.Total
		c := Code{ID: r.ID, Hint: r.CodeHint, Tier: plan.Tier(r.Tier), RedeemedAt: ptr(r.RedeemedAt), ExpiresAt: ptr(r.ExpiresAt), CreatedAt: r.CreatedAt.Time}
		if r.Days != nil {
			d := int(*r.Days)
			c.Days = &d
		}
		out[i] = CodeRow{Code: c, CreatedByUsername: str(r.CreatedByUsername), RedeemedByUsername: str(r.RedeemedByUsername)}
	}
	return out, total, nil
}
