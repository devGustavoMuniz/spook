// Package auth cuida de cadastro, login, logout e sessões (cookie httpOnly ou token Bearer).
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/user"
)

var ErrUnauthorized = errors.New("não autenticado")

const SessionTTL = 30 * 24 * time.Hour

// Users é o que auth precisa do pacote user.
type Users interface {
	Create(ctx context.Context, email, username, passwordHash string) (user.User, error)
	Credentials(ctx context.Context, email string) (user.User, string, error)
	Get(ctx context.Context, id int64) (user.User, error)
}

type Store interface {
	CreateSession(ctx context.Context, id, userID int64, tokenHash []byte, userAgent *string, expires time.Time) error
	Session(ctx context.Context, tokenHash []byte) (userID int64, expires time.Time, err error)
	DeleteSession(ctx context.Context, tokenHash []byte) error
	DeleteExpired(ctx context.Context) (int64, error)
}

type IDGenerator interface{ Next() int64 }

type Service struct {
	users  Users
	store  Store
	hasher *Hasher
	ids    IDGenerator
	now    func() time.Time
	// dummyHash é verificado quando o e-mail não existe, para o tempo de resposta não revelar contas.
	dummyHash string
}

func NewService(ctx context.Context, users Users, store Store, hasher *Hasher, ids IDGenerator) (*Service, error) {
	dummy, err := hasher.Hash(ctx, "spook-dummy-password")
	if err != nil {
		return nil, err
	}
	return &Service{users: users, store: store, hasher: hasher, ids: ids, now: time.Now, dummyHash: dummy}, nil
}

func (s *Service) Register(ctx context.Context, email, username, password string, userAgent *string) (user.User, string, error) {
	hash, err := s.hasher.Hash(ctx, password)
	if err != nil {
		return user.User{}, "", err
	}
	u, err := s.users.Create(ctx, email, username, hash)
	if err != nil {
		return user.User{}, "", err
	}
	token, err := s.newSession(ctx, u.ID, userAgent)
	return u, token, err
}

func (s *Service) Login(ctx context.Context, email, password string, userAgent *string) (user.User, string, error) {
	u, hash, err := s.users.Credentials(ctx, email)
	if errors.Is(err, user.ErrNotFound) {
		_, _ = s.hasher.Verify(ctx, password, s.dummyHash)
		return user.User{}, "", ErrUnauthorized
	}
	if err != nil {
		return user.User{}, "", err
	}
	ok, err := s.hasher.Verify(ctx, password, hash)
	if err != nil {
		return user.User{}, "", err
	}
	if !ok {
		return user.User{}, "", ErrUnauthorized
	}
	token, err := s.newSession(ctx, u.ID, userAgent)
	return u, token, err
}

func (s *Service) Logout(ctx context.Context, token string) error {
	return s.store.DeleteSession(ctx, hashToken(token))
}

// Authenticate valida o token e devolve o ID do usuário.
func (s *Service) Authenticate(ctx context.Context, token string) (int64, error) {
	if token == "" {
		return 0, ErrUnauthorized
	}
	userID, expires, err := s.store.Session(ctx, hashToken(token))
	if err != nil {
		return 0, err
	}
	if !expires.After(s.now()) {
		return 0, ErrUnauthorized
	}
	return userID, nil
}

// StartJanitor remove sessões expiradas periodicamente até ctx ser cancelado.
func (s *Service) StartJanitor(ctx context.Context, every time.Duration) {
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if n, err := s.store.DeleteExpired(ctx); err != nil {
					slog.Error("limpeza de sessões", "err", err)
				} else if n > 0 {
					slog.Info("sessões expiradas removidas", "total", n)
				}
			}
		}
	}()
}

func (s *Service) newSession(ctx context.Context, userID int64, userAgent *string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("gerar token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	// Só o hash é salvo: um vazamento do banco não entrega sessões válidas.
	if err := s.store.CreateSession(ctx, s.ids.Next(), userID, hashToken(token), userAgent, s.now().Add(SessionTTL)); err != nil {
		return "", err
	}
	return token, nil
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
