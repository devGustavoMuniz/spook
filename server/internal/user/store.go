package user

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

type PGStore struct{ q *dbgen.Queries }

func NewStore(db dbgen.DBTX) *PGStore { return &PGStore{q: dbgen.New(db)} }

func toUser(u dbgen.User) User {
	var deleted *time.Time
	if u.DeletedAt.Valid {
		t := u.DeletedAt.Time
		deleted = &t
	}
	var verified *time.Time
	if u.EmailVerifiedAt.Valid {
		t := u.EmailVerifiedAt.Time
		verified = &t
	}
	return User{
		DeletedAt: deleted, EmailVerifiedAt: verified, PendingEmail: u.PendingEmail, HasPassword: u.PasswordHash != NoPassword,
		ID: u.ID, Email: u.Email, Username: u.Username,
		DisplayName: u.DisplayName, AvatarKey: u.AvatarKey, Bio: u.Bio, Pronouns: u.Pronouns,
		BannerKey: u.BannerKey, BannerColor: u.BannerColor, CreatedAt: u.CreatedAt.Time, IsAdmin: u.IsAdmin,
	}
}

func (s *PGStore) Create(ctx context.Context, id int64, email, username, passwordHash string) (User, error) {
	u, err := s.q.CreateUser(ctx, dbgen.CreateUserParams{ID: id, Email: email, Username: username, PasswordHash: passwordHash})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			switch pgErr.ConstraintName {
			case "users_email_key":
				return User{}, ErrEmailTaken
			case "users_username_key":
				return User{}, ErrUsernameTaken
			}
		}
		return User{}, fmt.Errorf("criar usuário: %w", err)
	}
	return toUser(u), nil
}

func (s *PGStore) ByID(ctx context.Context, id int64) (User, error) {
	u, err := s.q.GetUserByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("buscar usuário: %w", err)
	}
	return toUser(u), nil
}

func (s *PGStore) ByEmail(ctx context.Context, email string) (User, string, error) {
	u, err := s.q.GetUserByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, "", ErrNotFound
	}
	if err != nil {
		return User{}, "", fmt.Errorf("buscar usuário por e-mail: %w", err)
	}
	return toUser(u), u.PasswordHash, nil
}

func (s *PGStore) UpdateProfile(ctx context.Context, id int64, p ProfileFields) (User, error) {
	u, err := s.q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID: id, DisplayName: p.DisplayName, AvatarKey: p.AvatarKey, Bio: p.Bio, Pronouns: p.Pronouns,
		BannerKey: p.BannerKey, BannerColor: p.BannerColor,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("atualizar perfil: %w", err)
	}
	return toUser(u), nil
}

func (s *PGStore) UpdateEmail(ctx context.Context, id int64, email string) (User, error) {
	u, err := s.q.UpdateUserEmail(ctx, dbgen.UpdateUserEmailParams{ID: id, Email: email})
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_email_key" {
			return User{}, ErrEmailTaken
		}
		return User{}, fmt.Errorf("atualizar e-mail: %w", err)
	}
	return toUser(u), nil
}

func (s *PGStore) PasswordHash(ctx context.Context, id int64) (string, error) {
	u, err := s.q.GetUserByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("buscar senha: %w", err)
	}
	return u.PasswordHash, nil
}

func (s *PGStore) SetPasswordHash(ctx context.Context, id int64, hash string) error {
	if err := s.q.UpdateUserPassword(ctx, dbgen.UpdateUserPasswordParams{ID: id, PasswordHash: hash}); err != nil {
		return fmt.Errorf("trocar senha: %w", err)
	}
	return nil
}
