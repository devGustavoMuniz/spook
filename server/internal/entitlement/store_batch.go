package entitlement

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// BatchStore é a parte do Store que cuida dos lotes de concessão em massa.
type BatchStore interface {
	// BeginBatch cria o lote, a menos que já exista um igual (mesmo plano e prazo, não revogado) criado depois de
	// since: nesse caso devolve o existente e existed = true. Serializado por trava, então dois pedidos
	// simultâneos não criam dois lotes.
	BeginBatch(ctx context.Context, b Batch, since time.Time) (Batch, bool, error)
	// TargetUsers devolve até limit IDs de contas ativas com ID maior que after, em ordem.
	TargetUsers(ctx context.Context, after int64, limit int) ([]int64, error)
	CountTargetUsers(ctx context.Context) (int64, error)
	// GrantPage concede o lote às pessoas userIDs (grantIDs[i] é o ID da concessão de userIDs[i]) numa transação e
	// devolve os IDs de quem recebeu (os demais foram pulados).
	GrantPage(ctx context.Context, b Batch, now time.Time, userIDs, grantIDs []int64) ([]int64, error)
	FinishBatch(ctx context.Context, id int64, granted, skipped int) error
	// AbortBatch apaga as concessões e o lote (lote que falhou no meio).
	AbortBatch(ctx context.Context, id int64) error
	ListBatches(ctx context.Context, limit int) ([]BatchRow, error)
	// RevokeBatch revoga as concessões ativas do lote e marca o lote como revogado; devolve quem perdeu.
	// ErrBatchNotFound e ErrBatchRevoked.
	RevokeBatch(ctx context.Context, id int64, now time.Time) ([]Grant, error)
}

var _ BatchStore = (*PGStore)(nil)

func toBatch(r dbgen.EntitlementBatch) Batch {
	return Batch{
		ID: r.ID, Tier: plan.Tier(r.Tier), Days: int(r.Days), CreatedBy: r.CreatedBy, CreatedAt: r.CreatedAt.Time,
		Granted: int(r.GrantedCount), Skipped: int(r.SkippedCount), RevokedAt: ptr(r.RevokedAt),
	}
}

func (s *PGStore) BeginBatch(ctx context.Context, b Batch, since time.Time) (Batch, bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Batch{}, false, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := q.LockEntitlementBatches(ctx); err != nil {
		return Batch{}, false, wrap("travar lotes", err)
	}
	cur, err := q.FindRecentEntitlementBatch(ctx, dbgen.FindRecentEntitlementBatchParams{Tier: string(b.Tier), Days: int32(b.Days), Since: tsv(since)})
	switch {
	case err == nil:
		return toBatch(cur), true, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return Batch{}, false, wrap("buscar lote recente", err)
	}
	row, err := q.InsertEntitlementBatch(ctx, dbgen.InsertEntitlementBatchParams{
		ID: b.ID, Tier: string(b.Tier), Days: int32(b.Days), CreatedBy: b.CreatedBy, CreatedAt: tsv(b.CreatedAt),
	})
	if err != nil {
		return Batch{}, false, wrap("gravar lote", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Batch{}, false, wrap("confirmar", err)
	}
	return toBatch(row), false, nil
}

func (s *PGStore) TargetUsers(ctx context.Context, after int64, limit int) ([]int64, error) {
	ids, err := s.q.ListEntitlementTargetUsers(ctx, dbgen.ListEntitlementTargetUsersParams{AfterID: after, PageSize: int32(limit)})
	if err != nil {
		return nil, wrap("listar contas ativas", err)
	}
	return ids, nil
}

func (s *PGStore) CountTargetUsers(ctx context.Context) (int64, error) {
	n, err := s.q.CountEntitlementTargetUsers(ctx)
	if err != nil {
		return 0, wrap("contar contas ativas", err)
	}
	return n, nil
}

func (s *PGStore) GrantPage(ctx context.Context, b Batch, now time.Time, userIDs, grantIDs []int64) ([]int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	bid := b.ID
	got, err := s.q.WithTx(tx).BulkGrantEntitlements(ctx, dbgen.BulkGrantEntitlementsParams{
		Tier: string(b.Tier), Now: tsv(now), Days: int32(b.Days), GrantedBy: b.CreatedBy, BatchID: &bid,
		UserIds: userIDs, GrantIds: grantIDs, MinRank: int32(b.Tier.Rank()),
	})
	if err != nil {
		return nil, wrap("conceder lote", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, wrap("confirmar", err)
	}
	return got, nil
}

func (s *PGStore) FinishBatch(ctx context.Context, id int64, granted, skipped int) error {
	if err := s.q.FinishEntitlementBatch(ctx, dbgen.FinishEntitlementBatchParams{ID: id, GrantedCount: int32(granted), SkippedCount: int32(skipped)}); err != nil {
		return wrap("fechar lote", err)
	}
	return nil
}

func (s *PGStore) AbortBatch(ctx context.Context, id int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := q.DeleteEntitlementsByBatch(ctx, &id); err != nil {
		return wrap("apagar concessões do lote", err)
	}
	if err := q.DeleteEntitlementBatch(ctx, id); err != nil {
		return wrap("apagar lote", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return wrap("confirmar", err)
	}
	return nil
}

func (s *PGStore) ListBatches(ctx context.Context, limit int) ([]BatchRow, error) {
	rs, err := s.q.AdminListEntitlementBatches(ctx, int32(limit))
	if err != nil {
		return nil, wrap("listar lotes", err)
	}
	out := make([]BatchRow, len(rs))
	for i, r := range rs {
		out[i] = BatchRow{
			Batch: Batch{
				ID: r.ID, Tier: plan.Tier(r.Tier), Days: int(r.Days), CreatedAt: r.CreatedAt.Time,
				Granted: int(r.GrantedCount), Skipped: int(r.SkippedCount), RevokedAt: ptr(r.RevokedAt),
			},
			CreatedByUsername: str(r.CreatedByUsername),
		}
	}
	return out, nil
}

func (s *PGStore) RevokeBatch(ctx context.Context, id int64, now time.Time) ([]Grant, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := q.LockEntitlementBatches(ctx); err != nil {
		return nil, wrap("travar lotes", err)
	}
	b, err := q.GetEntitlementBatch(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrBatchNotFound
	}
	if err != nil {
		return nil, wrap("buscar lote", err)
	}
	if b.RevokedAt.Valid {
		return nil, ErrBatchRevoked
	}
	rs, err := q.RevokeEntitlementsByBatch(ctx, dbgen.RevokeEntitlementsByBatchParams{Now: tsv(now), BatchID: &id})
	if err != nil {
		return nil, wrap("revogar concessões do lote", err)
	}
	if err := q.MarkEntitlementBatchRevoked(ctx, dbgen.MarkEntitlementBatchRevokedParams{ID: id, RevokedAt: tsv(now)}); err != nil {
		return nil, wrap("marcar lote revogado", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, wrap("confirmar", err)
	}
	out := make([]Grant, len(rs))
	for i, r := range rs {
		out[i] = Grant{UserID: r.UserID, Tier: plan.Tier(r.Tier), Source: SourceAdmin}
	}
	return out, nil
}
