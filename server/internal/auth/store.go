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

func (s *PGStore) Session(ctx context.Context, tokenHash []byte) (SessionInfo, error) {
	row, err := s.q.GetSessionByTokenHash(ctx, tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionInfo{}, ErrUnauthorized
	}
	if err != nil {
		return SessionInfo{}, fmt.Errorf("buscar sessão: %w", err)
	}
	info := SessionInfo{ID: row.ID, UserID: row.UserID, Expires: row.ExpiresAt.Time}
	if row.PasswordConfirmedAt.Valid {
		t := row.PasswordConfirmedAt.Time
		info.ConfirmedAt = &t
	}
	return info, nil
}

func (s *PGStore) ConfirmSession(ctx context.Context, tokenHash []byte, at time.Time) error {
	if err := s.q.ConfirmSessionPassword(ctx, dbgen.ConfirmSessionPasswordParams{
		TokenHash: tokenHash, PasswordConfirmedAt: pgtype.Timestamptz{Time: at, Valid: true},
	}); err != nil {
		return fmt.Errorf("confirmar senha da sessão: %w", err)
	}
	return nil
}

func (s *PGStore) DeleteOtherSessions(ctx context.Context, userID int64, keepHash []byte) (int64, error) {
	n, err := s.q.DeleteOtherSessions(ctx, dbgen.DeleteOtherSessionsParams{UserID: userID, TokenHash: keepHash})
	if err != nil {
		return 0, fmt.Errorf("encerrar outras sessões: %w", err)
	}
	return n, nil
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
