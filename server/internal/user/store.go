package user

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

type PGStore struct{ q *dbgen.Queries }

func NewStore(db dbgen.DBTX) *PGStore { return &PGStore{q: dbgen.New(db)} }

func toUser(u dbgen.User) User {
	return User{
		ID: u.ID, Email: u.Email, Username: u.Username,
		DisplayName: u.DisplayName, AvatarKey: u.AvatarKey, CreatedAt: u.CreatedAt.Time,
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

func (s *PGStore) UpdateProfile(ctx context.Context, id int64, displayName, avatarKey *string) (User, error) {
	u, err := s.q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{ID: id, DisplayName: displayName, AvatarKey: avatarKey})
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("atualizar perfil: %w", err)
	}
	return toUser(u), nil
}
