package mailflow

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// SendInfo é o estado de um token na hora de enviar o e-mail.
type SendInfo struct {
	Usable bool // não usado, não expirado e ainda não enviado
}

type PGStore struct {
	d db.DB
	q *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{d: d, q: dbgen.New(d)} }

// CreateToken invalida os tokens anteriores do mesmo tipo (um pedido novo substitui o antigo) e grava o novo.
func (s *PGStore) CreateToken(ctx context.Context, id, userID int64, kind, email string, hash []byte, exp time.Time) error {
	tx, err := s.d.Begin(ctx)
	if err != nil {
		return fmt.Errorf("iniciar token: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := dbgen.New(tx)
	if err := q.InvalidateEmailTokens(ctx, dbgen.InvalidateEmailTokensParams{UserID: userID, Kind: kind}); err != nil {
		return fmt.Errorf("invalidar tokens: %w", err)
	}
	if err := q.InsertEmailToken(ctx, dbgen.InsertEmailTokenParams{
		ID: id, UserID: userID, Kind: kind, Email: email, TokenHash: hash, ExpiresAt: pgtype.Timestamptz{Time: exp, Valid: true},
	}); err != nil {
		return fmt.Errorf("gravar token: %w", err)
	}
	return tx.Commit(ctx)
}

// Consume gasta o token (uso único, atômico). Distingue "não existe" de "expirado/já usado".
func (s *PGStore) Consume(ctx context.Context, hash []byte) (Token, error) {
	row, err := s.q.ConsumeEmailToken(ctx, hash)
	if err == nil {
		return Token{ID: row.ID, UserID: row.UserID, Kind: row.Kind, Email: row.Email}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Token{}, fmt.Errorf("consumir token: %w", err)
	}
	if _, err := s.q.GetEmailTokenByHash(ctx, hash); errors.Is(err, pgx.ErrNoRows) {
		return Token{}, ErrTokenInvalid
	} else if err != nil {
		return Token{}, fmt.Errorf("buscar token: %w", err)
	}
	return Token{}, ErrTokenExpired
}

func (s *PGStore) TokenIsSendable(ctx context.Context, id int64) (bool, error) {
	row, err := s.q.GetEmailTokenForSend(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("buscar token para envio: %w", err)
	}
	return !row.UsedAt.Valid && !row.SentAt.Valid && row.ExpiresAt.Time.After(time.Now()), nil
}

func (s *PGStore) MarkSent(ctx context.Context, id int64) error {
	if err := s.q.MarkEmailTokenSent(ctx, id); err != nil {
		return fmt.Errorf("marcar token enviado: %w", err)
	}
	return nil
}

func (s *PGStore) SetPendingEmail(ctx context.Context, userID int64, email *string) error {
	if err := s.q.SetUserPendingEmail(ctx, dbgen.SetUserPendingEmailParams{ID: userID, PendingEmail: email}); err != nil {
		return fmt.Errorf("gravar e-mail pendente: %w", err)
	}
	return nil
}

func (s *PGStore) MarkVerified(ctx context.Context, userID int64) error {
	if err := s.q.SetUserEmailVerified(ctx, userID); err != nil {
		return fmt.Errorf("marcar e-mail verificado: %w", err)
	}
	return nil
}

// ApplyEmailChange troca o e-mail (já verificado) e limpa o pendente.
func (s *PGStore) ApplyEmailChange(ctx context.Context, userID int64, email string) error {
	_, err := s.q.ApplyUserEmailChange(ctx, dbgen.ApplyUserEmailChangeParams{ID: userID, Email: email})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrEmailTaken
	}
	if err != nil {
		return fmt.Errorf("trocar e-mail: %w", err)
	}
	return nil
}

func (s *PGStore) EmailExists(ctx context.Context, email string) (bool, error) {
	_, err := s.q.GetUserByEmailForFlow(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("buscar e-mail: %w", err)
	}
	return true, nil
}

func (s *PGStore) Purge(ctx context.Context) (int64, error) {
	n, err := s.q.DeleteExpiredEmailTokens(ctx)
	if err != nil {
		return 0, fmt.Errorf("limpar tokens: %w", err)
	}
	return n, nil
}
