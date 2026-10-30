package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

type PGStore struct{ q *dbgen.Queries }

func NewStore(db dbgen.DBTX) *PGStore { return &PGStore{q: dbgen.New(db)} }

func (s *PGStore) CreateSession(ctx context.Context, id, userID int64, tokenHash []byte, userAgent *string, expires time.Time) error {
	err := s.q.CreateSession(ctx, dbgen.CreateSessionParams{
		ID: id, UserID: userID, TokenHash: tokenHash, UserAgent: userAgent,
		ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("criar sessão: %w", err)
	}
	return nil
}

func (s *PGStore) Session(ctx context.Context, tokenHash []byte) (int64, time.Time, error) {
	row, err := s.q.GetSessionByTokenHash(ctx, tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, time.Time{}, ErrUnauthorized
	}
	if err != nil {
		return 0, time.Time{}, fmt.Errorf("buscar sessão: %w", err)
	}
	return row.UserID, row.ExpiresAt.Time, nil
}

func (s *PGStore) DeleteSession(ctx context.Context, tokenHash []byte) error {
	if err := s.q.DeleteSessionByTokenHash(ctx, tokenHash); err != nil {
		return fmt.Errorf("excluir sessão: %w", err)
	}
	return nil
}

func (s *PGStore) DeleteExpired(ctx context.Context) (int64, error) {
	n, err := s.q.DeleteExpiredSessions(ctx)
	if err != nil {
		return 0, fmt.Errorf("limpar sessões expiradas: %w", err)
	}
	return n, nil
}
