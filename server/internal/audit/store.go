package audit

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

type PGStore struct {
	db db.DB
	q  *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{db: d, q: dbgen.New(d)} }

func wrap(op string, err error) error { return fmt.Errorf("%s: %w", op, err) }

func (s *PGStore) Insert(ctx context.Context, id int64, e Entry, changes []byte) error {
	var actor, target *int64
	if e.ActorID != 0 {
		actor = &e.ActorID
	}
	if e.TargetID != 0 {
		target = &e.TargetID
	}
	var tt, reason *string
	if e.TargetType != "" {
		tt = &e.TargetType
	}
	if e.Reason != "" {
		r := truncateRunes(e.Reason, MaxReasonRunes)
		reason = &r
	}
	if err := s.q.InsertAuditLog(ctx, dbgen.InsertAuditLogParams{
		ID: id, GuildID: e.GuildID, ActorID: actor, Action: string(e.Action), TargetType: tt, TargetID: target,
		Reason: reason, Changes: changes,
	}); err != nil {
		return wrap("gravar auditoria", err)
	}
	return nil
}

func (s *PGStore) List(ctx context.Context, guildID int64, action *string, actor, before *int64, limit int) ([]Row, error) {
	rows, err := s.q.ListAuditLogs(ctx, dbgen.ListAuditLogsParams{
		GuildID: guildID, Action: action, Actor: actor, Before: before, Limit: int32(limit),
	})
	if err != nil {
		return nil, wrap("listar auditoria", err)
	}
	out := make([]Row, len(rows))
	for i, r := range rows {
		out[i] = Row{
			ID: r.ID, GuildID: r.GuildID, ActorID: r.ActorID, Action: r.Action, TargetType: r.TargetType, TargetID: r.TargetID,
			Reason: r.Reason, Changes: r.Changes, CreatedAt: r.CreatedAt.Time,
			ActorUsername: r.ActorUsername, ActorDisplayName: r.ActorDisplayName, ActorAvatarKey: r.ActorAvatarKey,
		}
	}
	return out, nil
}

func (s *PGStore) PurgeBefore(ctx context.Context, cutoff time.Time, batch int) (int64, error) {
	n, err := s.q.DeleteAuditLogsBefore(ctx, dbgen.DeleteAuditLogsBeforeParams{
		CreatedAt: pgtype.Timestamptz{Time: cutoff, Valid: true}, Limit: int32(batch),
	})
	if err != nil {
		return 0, wrap("apagar auditoria antiga", err)
	}
	return n, nil
}
