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

func (s *PGStore) CreateSession(ctx context.Context, id, userID int64, tokenHash []byte, userAgent *string, remember bool, now, expires time.Time) error {
	err := s.q.CreateSession(ctx, dbgen.CreateSessionParams{
		ID: id, UserID: userID, TokenHash: tokenHash, UserAgent: userAgent, Remember: remember,
		LastSeenAt: pgtype.Timestamptz{Time: now, Valid: true},
		ExpiresAt:  pgtype.Timestamptz{Time: expires, Valid: true},
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
	info := SessionInfo{ID: row.ID, UserID: row.UserID, Expires: row.ExpiresAt.Time, Remember: row.Remember, LastSeen: row.LastSeenAt.Time, CreatedAt: row.CreatedAt.Time}
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
	_, _ = s.q.DeleteExpiredDesktopLoginCodes(ctx)
	n, err := s.q.DeleteExpiredSessions(ctx)
	if err != nil {
		return 0, fmt.Errorf("limpar sessões expiradas: %w", err)
	}
	return n, nil
}

func (s *PGStore) DeleteAllSessions(ctx context.Context, userID int64) error {
	if err := s.q.DeleteSessionsByUser(ctx, userID); err != nil {
		return fmt.Errorf("encerrar sessões: %w", err)
	}
	return nil
}

func (s *PGStore) InsertDesktopCode(ctx context.Context, codeHash []byte, userID int64, challenge string, expires time.Time) error {
	err := s.q.InsertDesktopLoginCode(ctx, dbgen.InsertDesktopLoginCodeParams{
		CodeHash: codeHash, UserID: userID, CodeChallenge: challenge, ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("criar código do desktop: %w", err)
	}
	return nil
}

// ConsumeDesktopCode marca o código como usado de forma atômica; ErrInvalidCode se não existir, já foi usado ou expirou.
func (s *PGStore) ConsumeDesktopCode(ctx context.Context, codeHash []byte) (int64, string, error) {
	row, err := s.q.ConsumeDesktopLoginCode(ctx, codeHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", ErrInvalidCode
	}
	if err != nil {
		return 0, "", fmt.Errorf("consumir código do desktop: %w", err)
	}
	return row.UserID, row.CodeChallenge, nil
}

func (s *PGStore) SlideSession(ctx context.Context, tokenHash []byte, seen, expires, staleBefore time.Time) (bool, error) {
	n, err := s.q.SlideSession(ctx, dbgen.SlideSessionParams{
		TokenHash: tokenHash, LastSeenAt: pgtype.Timestamptz{Time: seen, Valid: true},
		ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true}, StaleBefore: pgtype.Timestamptz{Time: staleBefore, Valid: true},
	})
	if err != nil {
		return false, fmt.Errorf("renovar sessão: %w", err)
	}
	return n > 0, nil
}

func (s *PGStore) ListSessions(ctx context.Context, userID int64) ([]SessionRow, error) {
	rows, err := s.q.ListActiveSessions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("listar sessões: %w", err)
	}
	out := make([]SessionRow, len(rows))
	for i, r := range rows {
		out[i] = SessionRow{ID: r.ID, TokenHash: r.TokenHash, UserAgent: r.UserAgent, Remember: r.Remember,
			CreatedAt: r.CreatedAt.Time, LastSeen: r.LastSeenAt.Time, Expires: r.ExpiresAt.Time}
	}
	return out, nil
}

func (s *PGStore) DeleteSessionByID(ctx context.Context, userID, id int64) ([]byte, error) {
	h, err := s.q.DeleteSessionByID(ctx, dbgen.DeleteSessionByIDParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrSessionNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("encerrar sessão: %w", err)
	}
	return h, nil
}
