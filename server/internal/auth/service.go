// Package auth cuida de cadastro, login, logout e sessões (cookie httpOnly ou token Bearer).
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"
	"unicode/utf8"

	"github.com/devGustavoMuniz/spook/server/internal/user"
)

var (
	ErrUnauthorized  = errors.New("não autenticado")
	ErrWrongPassword = errors.New("senha incorreta")
	ErrWeakPassword  = errors.New("senha fora das regras")
	ErrSamePassword  = errors.New("a nova senha deve ser diferente da atual")
)

// ConfirmTTL é quanto tempo vale a confirmação de senha ("modo sudo") de uma sessão.
const ConfirmTTL = 10 * time.Minute

// Limites de senha (iguais aos do cadastro no contrato da API).
const (
	MinPasswordLen = 8
	MaxPasswordLen = 128
)

// ValidatePassword aplica as regras de força de senha do cadastro.
func ValidatePassword(pw string) error {
	if n := utf8.RuneCountInString(pw); n < MinPasswordLen || n > MaxPasswordLen {
		return ErrWeakPassword
	}
	return nil
}

const SessionTTL = 30 * 24 * time.Hour

// Users é o que auth precisa do pacote user.
type Users interface {
	Create(ctx context.Context, email, username, passwordHash string) (user.User, error)
	Credentials(ctx context.Context, email string) (user.User, string, error)
	Get(ctx context.Context, id int64) (user.User, error)
	PasswordHash(ctx context.Context, id int64) (string, error)
	SetPasswordHash(ctx context.Context, id int64, hash string) error
}

// SessionInfo é o que o banco guarda de uma sessão.
type SessionInfo struct {
	ID          int64
	UserID      int64
	Expires     time.Time
	ConfirmedAt *time.Time // última confirmação de senha ("modo sudo")
}

type Store interface {
	CreateSession(ctx context.Context, id, userID int64, tokenHash []byte, userAgent *string, expires time.Time) error
	Session(ctx context.Context, tokenHash []byte) (SessionInfo, error)
	ConfirmSession(ctx context.Context, tokenHash []byte, at time.Time) error
	DeleteOtherSessions(ctx context.Context, userID int64, keepHash []byte) (int64, error)
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
	// onRevoke avisa o gateway para derrubar as conexões das sessões encerradas (nil = ninguém a avisar).
	onRevoke func(userID int64, keepKey string)
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
	if user.IsReservedUsername(username) {
		return user.User{}, "", user.ErrReservedUsername
	}
	if err := ValidatePassword(password); err != nil {
		return user.User{}, "", err
	}
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
	info, err := s.store.Session(ctx, hashToken(token))
	if err != nil {
		return 0, err
	}
	if !info.Expires.After(s.now()) {
		return 0, ErrUnauthorized
	}
	return info.UserID, nil
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

// TokenKey identifica a sessão de login (hash do token) sem expor o token; o gateway a guarda em cada
// conexão para derrubar só as sessões encerradas.
func TokenKey(token string) string { return hex.EncodeToString(hashToken(token)) }

// OnRevoke registra quem deve ser avisado quando sessões são encerradas por troca de senha ou exclusão.
func (s *Service) OnRevoke(fn func(userID int64, keepKey string)) { s.onRevoke = fn }

// NotifyRevoked avisa o gateway; keepKey vazio derruba todas as conexões do usuário.
func (s *Service) NotifyRevoked(userID int64, keepKey string) {
	if s.onRevoke != nil {
		s.onRevoke(userID, keepKey)
	}
}

// VerifyPassword confere a senha do usuário (ErrWrongPassword se não bater).
func (s *Service) VerifyPassword(ctx context.Context, userID int64, password string) error {
	hash, err := s.users.PasswordHash(ctx, userID)
	if err != nil {
		return err
	}
	ok, err := s.hasher.Verify(ctx, password, hash)
	if err != nil {
		return err
	}
	if !ok {
		return ErrWrongPassword
	}
	return nil
}

// ChangePassword troca a senha do usuário logado: confere a atual, aplica as regras de força, grava
// o hash novo e encerra as OUTRAS sessões (a atual continua e já fica confirmada).
func (s *Service) ChangePassword(ctx context.Context, userID int64, token, current, next string) error {
	if err := s.VerifyPassword(ctx, userID, current); err != nil {
		return err
	}
	if err := ValidatePassword(next); err != nil {
		return err
	}
	if next == current {
		return ErrSamePassword
	}
	hash, err := s.hasher.Hash(ctx, next)
	if err != nil {
		return err
	}
	if err := s.users.SetPasswordHash(ctx, userID, hash); err != nil {
		return err
	}
	if _, err := s.store.DeleteOtherSessions(ctx, userID, hashToken(token)); err != nil {
		return err
	}
	if err := s.store.ConfirmSession(ctx, hashToken(token), s.now()); err != nil {
		return err
	}
	s.NotifyRevoked(userID, TokenKey(token))
	return nil
}

// ConfirmPassword marca a sessão como confirmada por ConfirmTTL.
func (s *Service) ConfirmPassword(ctx context.Context, userID int64, token, password string) (until time.Time, err error) {
	if err := s.VerifyPassword(ctx, userID, password); err != nil {
		return time.Time{}, err
	}
	now := s.now()
	if err := s.store.ConfirmSession(ctx, hashToken(token), now); err != nil {
		return time.Time{}, err
	}
	return now.Add(ConfirmTTL), nil
}

// RecentlyConfirmed diz se a sessão confirmou a senha há menos de ConfirmTTL.
func (s *Service) RecentlyConfirmed(ctx context.Context, token string) (bool, error) {
	info, err := s.store.Session(ctx, hashToken(token))
	if err != nil {
		return false, err
	}
	return info.ConfirmedAt != nil && s.now().Sub(*info.ConfirmedAt) < ConfirmTTL, nil
}
