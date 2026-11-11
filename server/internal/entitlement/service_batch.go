package entitlement

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// NotifyGap é o intervalo entre os avisos de uma concessão ou revogação em massa (200 pessoas por segundo).
const NotifyGap = 5 * time.Millisecond

// GrantAll concede days dias de tier a todas as contas ativas, em páginas de 500 por transação, e avisa cada
// pessoa em segundo plano depois de gravar. Idempotente por lote (ver batch.go). Se uma página falha, o lote
// parcial é desfeito e o erro volta (repetir é seguro).
func (s *Service) GrantAll(ctx context.Context, adminID int64, tier plan.Tier, days int, confirm bool) (GrantAllResult, error) {
	if !confirm {
		return GrantAllResult{}, ErrConfirmRequired
	}
	if !validTier(tier) {
		return GrantAllResult{}, ErrInvalidTier
	}
	if !validDays(&days) {
		return GrantAllResult{}, ErrInvalidDays
	}
	now := s.now()
	by := adminID
	b, existed, err := s.store.BeginBatch(ctx, Batch{ID: s.ids.Next(), Tier: tier, Days: days, CreatedBy: &by, CreatedAt: now}, now.Add(-BatchWindow))
	if err != nil {
		return GrantAllResult{}, err
	}
	if existed {
		slog.InfoContext(ctx, "concessão em massa repetida: lote já aplicado", "admin_id", adminID, "batch_id", b.ID, "tier", string(tier), "days", days)
		return GrantAllResult{BatchID: httpx.ID(b.ID), Granted: b.Granted, Skipped: b.Skipped, AlreadyApplied: true}, nil
	}

	var affected []int64
	skipped, after := 0, int64(0)
	for {
		users, err := s.store.TargetUsers(ctx, after, batchPage)
		if err != nil {
			return GrantAllResult{}, s.abort(ctx, b.ID, err)
		}
		if len(users) == 0 {
			break
		}
		after = users[len(users)-1]
		grantIDs := make([]int64, len(users))
		for i := range grantIDs {
			grantIDs[i] = s.ids.Next()
		}
		got, err := s.store.GrantPage(ctx, b, now, users, grantIDs)
		if err != nil {
			return GrantAllResult{}, s.abort(ctx, b.ID, err)
		}
		affected = append(affected, got...)
		skipped += len(users) - len(got)
		if len(users) < batchPage {
			break
		}
	}
	if err := s.store.FinishBatch(ctx, b.ID, len(affected), skipped); err != nil {
		return GrantAllResult{}, s.abort(ctx, b.ID, err)
	}
	s.changes.Add(ctx, int64(len(affected)), metric.WithAttributes(
		attribute.String("action", "grant_all"), attribute.String("tier", string(tier)), attribute.String("source", string(SourceAdmin))))
	slog.InfoContext(ctx, "plano concedido em massa pela equipe", "admin_id", adminID, "batch_id", b.ID, "tier", string(tier),
		"days", days, "granted", len(affected), "skipped", skipped)
	s.notifyAll(ctx, affected, "granted")
	return GrantAllResult{BatchID: httpx.ID(b.ID), Granted: len(affected), Skipped: skipped}, nil
}

// abort desfaz um lote que falhou no meio e devolve o erro original (ou os dois, se desfazer também falhar).
func (s *Service) abort(ctx context.Context, batchID int64, cause error) error {
	if err := s.store.AbortBatch(context.WithoutCancel(ctx), batchID); err != nil {
		slog.ErrorContext(ctx, "não foi possível desfazer o lote parcial", "batch_id", batchID, "err", err)
		return errors.Join(cause, fmt.Errorf("desfazer o lote: %w", err))
	}
	return cause
}

// RevokeBatch revoga as concessões ativas de um lote (concessões já vencidas ou revogadas não mudam) e avisa quem perdeu.
func (s *Service) RevokeBatch(ctx context.Context, adminID, batchID int64) (RevokeBatchResult, error) {
	rs, err := s.store.RevokeBatch(ctx, batchID, s.now())
	if err != nil {
		return RevokeBatchResult{}, err
	}
	users := make([]int64, len(rs))
	for i, g := range rs {
		users[i] = g.UserID
	}
	if len(rs) > 0 {
		s.changes.Add(ctx, int64(len(rs)), metric.WithAttributes(
			attribute.String("action", "revoke_batch"), attribute.String("tier", string(rs[0].Tier)), attribute.String("source", string(SourceAdmin))))
	}
	slog.InfoContext(ctx, "lote de plano revogado pela equipe", "admin_id", adminID, "batch_id", batchID, "revoked", len(rs))
	s.notifyAll(ctx, users, "revoked")
	return RevokeBatchResult{BatchID: httpx.ID(batchID), Revoked: len(rs)}, nil
}

// ListBatches lista os lotes mais recentes e quantas contas um novo lote atingiria.
func (s *Service) ListBatches(ctx context.Context) (BatchList, error) {
	rows, err := s.store.ListBatches(ctx, batchListLimit)
	if err != nil {
		return BatchList{}, err
	}
	n, err := s.store.CountTargetUsers(ctx)
	if err != nil {
		return BatchList{}, err
	}
	items := make([]BatchPayload, len(rows))
	for i, r := range rows {
		items[i] = batchPayload(r)
	}
	return BatchList{Items: items, EligibleUsers: n}, nil
}

// notifyAll avisa as pessoas em segundo plano, uma a cada notifyGap (a requisição não espera). Falhar nunca desfaz
// a mudança: o plano novo vale na próxima leitura. WaitNotifications espera o fim (testes e desligamento).
func (s *Service) notifyAll(ctx context.Context, userIDs []int64, reason string) {
	if len(userIDs) == 0 {
		return
	}
	ctx = context.WithoutCancel(ctx)
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		for i, uid := range userIDs {
			if i > 0 && s.notifyGap > 0 {
				select {
				case <-time.After(s.notifyGap):
				case <-s.stop:
					return
				}
			}
			select {
			case <-s.stop:
				return
			default:
			}
			s.notify(ctx, uid, reason)
		}
	}()
}

// WaitNotifications espera terminarem os avisos em segundo plano.
func (s *Service) WaitNotifications() { s.bg.Wait() }

// Close interrompe os avisos em segundo plano que ainda não saíram e espera a rotina terminar (desligamento). O
// plano em si já está gravado: quem não foi avisado vê o plano novo na próxima leitura.
func (s *Service) Close() {
	s.stopOnce.Do(func() { close(s.stop) })
	s.bg.Wait()
}
