package social

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
	"github.com/devGustavoMuniz/spook/server/internal/user"
)

var (
	ErrNotFound        = errors.New("conta social não encontrada")
	ErrLinkedElsewhere = errors.New("essa conta do provedor já está vinculada a outro usuário")
	ErrAlreadyLinked   = errors.New("sua conta já tem esse provedor vinculado")
	ErrLastMethod      = errors.New("não é possível remover o último método de login")
	ErrSignupExpired   = errors.New("cadastro social expirado")
)

// Account é uma conta social vinculada.
type Account struct {
	ID         int64
	UserID     int64
	Provider   string
	ProviderID string
	Email      string
	CreatedAt  time.Time
}

// Pending é um cadastro social aguardando o username.
type Pending struct {
	Provider, ProviderID, Email, DisplayName, Suggested string
	Expires                                             time.Time
}

type PGStore struct {
	d db.DB
	q *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{d: d, q: dbgen.New(d)} }

func toAccount(a dbgen.SocialAccount) Account {
	acc := Account{ID: a.ID, UserID: a.UserID, Provider: a.Provider, ProviderID: a.ProviderUserID, CreatedAt: a.CreatedAt.Time}
	if a.Email != nil {
		acc.Email = *a.Email
	}
	return acc
}

func (s *PGStore) Find(ctx context.Context, provider, providerID string) (Account, error) {
	a, err := s.q.GetSocialAccount(ctx, dbgen.GetSocialAccountParams{Provider: provider, ProviderUserID: providerID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, ErrNotFound
	}
	if err != nil {
		return Account{}, fmt.Errorf("buscar conta social: %w", err)
	}
	return toAccount(a), nil
}

func (s *PGStore) List(ctx context.Context, userID int64) ([]Account, error) {
	rows, err := s.q.ListSocialAccountsByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("listar contas sociais: %w", err)
	}
	out := make([]Account, len(rows))
	for i, r := range rows {
		out[i] = toAccount(r)
	}
	return out, nil
}

func (s *PGStore) Link(ctx context.Context, id, userID int64, provider, providerID, email string) error {
	var e *string
	if email != "" {
		e = &email
	}
	err := s.q.InsertSocialAccount(ctx, dbgen.InsertSocialAccountParams{ID: id, UserID: userID, Provider: provider, ProviderUserID: providerID, Email: e})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		if pgErr.ConstraintName == "social_accounts_user_id_provider_key" {
			return ErrAlreadyLinked
		}
		return ErrLinkedElsewhere
	}
	if err != nil {
		return fmt.Errorf("vincular conta social: %w", err)
	}
	return nil
}

// Unlink remove o vínculo sem deixar a conta sem nenhum método de login: com o usuário travado, exige senha
// ou ao menos outro provedor vinculado.
func (s *PGStore) Unlink(ctx context.Context, userID int64, provider string) error {
	tx, err := s.d.Begin(ctx)
	if err != nil {
		return fmt.Errorf("iniciar desvinculo: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := dbgen.New(tx)
	if _, err := q.LockUserForDelete(ctx, userID); err != nil {
		return fmt.Errorf("travar usuário: %w", err)
	}
	has, err := q.UserHasPassword(ctx, userID)
	if err != nil {
		return fmt.Errorf("ler senha: %w", err)
	}
	accs, err := q.ListSocialAccountsByUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("listar contas sociais: %w", err)
	}
	found := false
	for _, a := range accs {
		found = found || a.Provider == provider
	}
	if !found {
		return ErrNotFound
	}
	if !has && len(accs) <= 1 {
		return ErrLastMethod
	}
	if _, err := q.DeleteSocialAccount(ctx, dbgen.DeleteSocialAccountParams{UserID: userID, Provider: provider}); err != nil {
		return fmt.Errorf("desvincular: %w", err)
	}
	return tx.Commit(ctx)
}

func (s *PGStore) HasPassword(ctx context.Context, userID int64) (bool, error) {
	has, err := s.q.UserHasPassword(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("ler senha: %w", err)
	}
	return has, nil
}

func (s *PGStore) EmailInUse(ctx context.Context, email string) (bool, error) {
	ok, err := s.q.UserExistsByEmail(ctx, email)
	if err != nil {
		return false, fmt.Errorf("buscar e-mail: %w", err)
	}
	return ok, nil
}

func (s *PGStore) CreatePending(ctx context.Context, hash []byte, p Pending) error {
	var dn *string
	if p.DisplayName != "" {
		dn = &p.DisplayName
	}
	err := s.q.InsertSocialSignup(ctx, dbgen.InsertSocialSignupParams{
		TokenHash: hash, Provider: p.Provider, ProviderUserID: p.ProviderID, Email: p.Email, DisplayName: dn,
		Suggested: p.Suggested, ExpiresAt: pgtype.Timestamptz{Time: p.Expires, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("gravar cadastro social: %w", err)
	}
	return nil
}

func (s *PGStore) GetPending(ctx context.Context, hash []byte) (Pending, error) {
	r, err := s.q.GetSocialSignup(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Pending{}, ErrSignupExpired
	}
	if err != nil {
		return Pending{}, fmt.Errorf("buscar cadastro social: %w", err)
	}
	return pendingOf(r), nil
}

func pendingOf(r dbgen.GetSocialSignupRow) Pending {
	p := Pending{Provider: r.Provider, ProviderID: r.ProviderUserID, Email: r.Email, Suggested: r.Suggested, Expires: r.ExpiresAt.Time}
	if r.DisplayName != nil {
		p.DisplayName = *r.DisplayName
	}
	return p
}

// Complete conclui o cadastro numa transação: gasta o cadastro pendente, cria o usuário (sem senha, e-mail
// verificado pelo provedor) e a conta social. Username ou e-mail em uso desfazem tudo (o pendente continua).
func (s *PGStore) Complete(ctx context.Context, hash []byte, userID, accountID int64, username string) (user.User, error) {
	tx, err := s.d.Begin(ctx)
	if err != nil {
		return user.User{}, fmt.Errorf("iniciar cadastro social: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := dbgen.New(tx)
	p, err := q.GetSocialSignup(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return user.User{}, ErrSignupExpired
	}
	if err != nil {
		return user.User{}, fmt.Errorf("buscar cadastro social: %w", err)
	}
	if n, err := q.DeleteSocialSignup(ctx, hash); err != nil || n != 1 {
		if err != nil {
			return user.User{}, fmt.Errorf("gastar cadastro social: %w", err)
		}
		return user.User{}, ErrSignupExpired // outra requisição o gastou antes
	}
	row, err := q.CreateSocialUser(ctx, dbgen.CreateSocialUserParams{ID: userID, Email: p.Email, Username: username, DisplayName: p.DisplayName})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		switch pgErr.ConstraintName {
		case "users_username_key":
			return user.User{}, user.ErrUsernameTaken
		case "users_email_key":
			return user.User{}, user.ErrEmailTaken
		}
	}
	if err != nil {
		return user.User{}, fmt.Errorf("criar usuário social: %w", err)
	}
	if err := dbgen.New(tx).InsertSocialAccount(ctx, dbgen.InsertSocialAccountParams{
		ID: accountID, UserID: userID, Provider: p.Provider, ProviderUserID: p.ProviderUserID, Email: ptr(p.Email),
	}); err != nil {
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return user.User{}, ErrLinkedElsewhere
		}
		return user.User{}, fmt.Errorf("vincular conta social: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return user.User{}, fmt.Errorf("confirmar cadastro social: %w", err)
	}
	now := time.Now()
	return user.User{ID: row.ID, Email: row.Email, Username: row.Username, DisplayName: row.DisplayName, CreatedAt: row.CreatedAt.Time,
		IsAdmin: row.IsAdmin, EmailVerifiedAt: &now, HasPassword: false}, nil
}

func ptr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Purge apaga cadastros pendentes vencidos.
func (s *PGStore) Purge(ctx context.Context) (int64, error) {
	n, err := s.q.DeleteExpiredSocialSignups(ctx)
	if err != nil {
		return 0, fmt.Errorf("limpar cadastros sociais: %w", err)
	}
	return n, nil
}
