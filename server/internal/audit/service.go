package audit

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

var tracer = otel.Tracer("spook/audit")

// Store é o que o service precisa do banco.
type Store interface {
	Insert(ctx context.Context, id int64, e Entry, changes []byte) error
	List(ctx context.Context, guildID int64, action *string, actor, before *int64, limit int) ([]Row, error)
	PurgeBefore(ctx context.Context, cutoff time.Time, batch int) (int64, error)
}

// Access é o que audit precisa do servidor (implementada pelo guild.Service).
type Access interface {
	Member(ctx context.Context, guildID, userID int64) (perm.Member, error)
}

// Avatars resolve a chave de avatar em URL de leitura.
type Avatars interface {
	AvatarURLForKey(ctx context.Context, key *string) string
}

type IDGenerator interface{ Next() int64 }

type Service struct {
	store   Store
	access  Access
	avatars Avatars
	ids     IDGenerator
}

func NewService(store Store, access Access, avatars Avatars, ids IDGenerator) *Service {
	return &Service{store: store, access: access, avatars: avatars, ids: ids}
}

// Record grava uma entrada. Nunca devolve erro: falha é registrada no log e a ação principal segue.
func (s *Service) Record(ctx context.Context, e Entry) {
	if s == nil || e.GuildID == 0 || e.Action == "" {
		return
	}
	// A gravação não pode ser cancelada junto com a requisição que já fez o trabalho principal.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	ctx, span := tracer.Start(ctx, "audit.Record")
	defer span.End()
	if err := s.store.Insert(ctx, s.ids.Next(), e, encodeChanges(e.Changes)); err != nil {
		slog.Error("auditoria: não foi possível gravar", "guild", e.GuildID, "action", e.Action, "err", err)
	}
}

// ListParams filtra e pagina o registro (cursor `Before` = ID da última linha recebida).
type ListParams struct {
	Action Action
	Actor  int64
	Before int64
	Limit  int
}

// List devolve até Limit linhas (as mais novas primeiro) e se há mais. Exige VIEW_AUDIT_LOG.
func (s *Service) List(ctx context.Context, userID, guildID int64, p ListParams) ([]Row, bool, error) {
	ctx, span := tracer.Start(ctx, "audit.List")
	defer span.End()
	m, err := s.access.Member(ctx, guildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	if !m.Has(perm.ViewAuditLog) {
		return nil, false, ErrForbidden
	}
	if p.Action != "" && !p.Action.Valid() {
		return nil, false, apperr.Invalid("ação inválida")
	}
	if p.Limit <= 0 {
		p.Limit = DefaultLimit
	}
	if p.Limit > MaxLimit {
		p.Limit = MaxLimit
	}
	var action *string
	if p.Action != "" {
		a := string(p.Action)
		action = &a
	}
	var actor, before *int64
	if p.Actor != 0 {
		actor = &p.Actor
	}
	if p.Before != 0 {
		before = &p.Before
	}
	rows, err := s.store.List(ctx, guildID, action, actor, before, p.Limit+1)
	if err != nil {
		return nil, false, err
	}
	more := len(rows) > p.Limit
	if more {
		rows = rows[:p.Limit]
	}
	for i := range rows {
		rows[i].ActorAvatarURL = s.avatars.AvatarURLForKey(ctx, rows[i].ActorAvatarKey)
	}
	return rows, more, nil
}

// Purge apaga, em lotes, o que passou da retenção. Devolve o total apagado.
func (s *Service) Purge(ctx context.Context, retention time.Duration) (int64, error) {
	cutoff := time.Now().Add(-retention)
	var total int64
	for {
		n, err := s.store.PurgeBefore(ctx, cutoff, purgeBatch)
		total += n
		if err != nil {
			return total, err
		}
		if n < purgeBatch {
			return total, nil
		}
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		default:
		}
	}
}

const purgeBatch = 1000
