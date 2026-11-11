// Package auth cuida de cadastro, login, logout e sessões (cookie httpOnly ou token Bearer).
package auth

import (
	"bytes"
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

// Validade das sessões (SPEC 7.1). A validade DESLIZA: cada uso renova o prazo ocioso, no máximo 1 vez por
// SlideEvery (o banco não é escrito a cada requisição), até o teto absoluto contado da criação.
//
//	"Manter conectado" marcado:   90 dias de ociosidade, teto de 365 dias; cookie persistente (Max-Age).
//	"Manter conectado" desmarcado: 24 horas de ociosidade, teto de 7 dias; cookie de sessão (some ao fechar).
const (
	RememberIdleTTL = 90 * 24 * time.Hour
	RememberMaxTTL  = 365 * 24 * time.Hour
	ShortIdleTTL    = 24 * time.Hour
	ShortMaxTTL     = 7 * 24 * time.Hour
	SlideEvery      = time.Hour
)

// SessionTTL é a validade ociosa da sessão lembrada (login social e desktop sempre usam esta).
const SessionTTL = RememberIdleTTL

// lifetimes devolve a ociosidade e o teto absoluto da sessão.
func lifetimes(remember bool) (idle, max time.Duration) {
	if remember {
		return RememberIdleTTL, RememberMaxTTL
	}
	return ShortIdleTTL, ShortMaxTTL
}

// expiryFor calcula o vencimento de uma sessão usada em now: ociosidade a partir de agora, limitada ao teto.
func expiryFor(remember bool, created, now time.Time) time.Time {
	idle, max := lifetimes(remember)
	exp, cap := now.Add(idle), created.Add(max)
	if exp.After(cap) {
		return cap
	}
	return exp
}

// ErrSessionNotFound: a sessão não existe ou é de outro usuário.
var ErrSessionNotFound = errors.New("sessão não encontrada")

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
	Remember    bool
	LastSeen    time.Time
	CreatedAt   time.Time
}

// SessionRow é uma sessão ativa na lista de Configurações → Segurança.
type SessionRow struct {
	ID        int64
	TokenHash []byte
	UserAgent *string
	Remember  bool
	CreatedAt time.Time
	LastSeen  time.Time
	Expires   time.Time
}

type Store interface {
	CreateSession(ctx context.Context, id, userID int64, tokenHash []byte, userAgent *string, remember bool, now, expires time.Time) error
	// SlideSession renova o vencimento se o último uso for anterior a staleBefore; devolve se gravou.
	SlideSession(ctx context.Context, tokenHash []byte, seen, expires, staleBefore time.Time) (bool, error)
	ListSessions(ctx context.Context, userID int64) ([]SessionRow, error)
	// DeleteSessionByID encerra uma sessão do usuário e devolve o hash do token (a chave do gateway).
	DeleteSessionByID(ctx context.Context, userID, id int64) ([]byte, error)
	Session(ctx context.Context, tokenHash []byte) (SessionInfo, error)
	ConfirmSession(ctx context.Context, tokenHash []byte, at time.Time) error
	DeleteOtherSessions(ctx context.Context, userID int64, keepHash []byte) (int64, error)
	DeleteSession(ctx context.Context, tokenHash []byte) error
	DeleteAllSessions(ctx context.Context, userID int64) error
	DeleteExpired(ctx context.Context) (int64, error)
	// Login do desktop pelo navegador (handoff PKCE).
	InsertDesktopCode(ctx context.Context, codeHash []byte, userID int64, challenge string, expires time.Time) error
	ConsumeDesktopCode(ctx context.Context, codeHash []byte) (userID int64, challenge string, err error)
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
	// onRevokeKey avisa o gateway para derrubar as conexões de uma única sessão encerrada.
	onRevokeKey func(userID int64, key string)
	// onRegistered roda depois de um cadastro com senha (ex.: enviar o e-mail de verificação); erros só viram log.
	onRegistered func(ctx context.Context, u user.User)
	// onAccountCreated roda logo depois da criação da conta, ANTES da sessão e da resposta (ex.: período de
	// cortesia do Nitro, para a pessoa já ver o plano ao abrir o app). Não pode falhar o cadastro.
	onAccountCreated func(ctx context.Context, userID int64)
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

func (s *Service) Register(ctx context.Context, email, username, password string, userAgent *string, remember bool) (user.User, string, error) {
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
	if s.onAccountCreated != nil {
		s.onAccountCreated(ctx, u.ID)
	}
	token, err := s.newSession(ctx, u.ID, userAgent, remember)
	if err == nil && s.onRegistered != nil {
		s.onRegistered(ctx, u)
	}
	return u, token, err
}

// OnAccountCreated registra o gancho de conta nova, rodado antes da sessão (nil desliga). Quem registra garante
// que o gancho não falha o cadastro (erro vira log).
func (s *Service) OnAccountCreated(fn func(ctx context.Context, userID int64)) {
	s.onAccountCreated = fn
}

// OnRegistered registra o gancho pós-cadastro (nil desliga).
func (s *Service) OnRegistered(fn func(ctx context.Context, u user.User)) { s.onRegistered = fn }

func (s *Service) Login(ctx context.Context, email, password string, userAgent *string, remember bool) (user.User, string, error) {
	u, hash, err := s.users.Credentials(ctx, email)
	if errors.Is(err, user.ErrNotFound) {
		_, _ = s.hasher.Verify(ctx, password, s.dummyHash)
		return user.User{}, "", ErrUnauthorized
	}
	if err != nil {
		return user.User{}, "", err
	}
	if hash == user.NoPassword { // conta sem senha (login social): só entra pelo provedor
		_, _ = s.hasher.Verify(ctx, password, s.dummyHash)
		return user.User{}, "", ErrUnauthorized
	}
	ok, err := s.hasher.Verify(ctx, password, hash)
	if err != nil {
		return user.User{}, "", err
	}
	if !ok {
		return user.User{}, "", ErrUnauthorized
	}
	token, err := s.newSession(ctx, u.ID, userAgent, remember)
	return u, token, err
}

func (s *Service) Logout(ctx context.Context, token string) error {
	return s.store.DeleteSession(ctx, hashToken(token))
}

// Authenticate valida o token e devolve o ID do usuário (renovando a validade, ver Resolve).
func (s *Service) Authenticate(ctx context.Context, token string) (int64, error) {
	a, err := s.Resolve(ctx, token)
	return a.UserID, err
}

// Authed é o resultado de Resolve.
type Authed struct {
	UserID   int64
	Remember bool
	// RefreshCookieMaxAge > 0 quando a validade foi renovada agora numa sessão lembrada: o cookie persistente
	// precisa ser reenviado com este Max-Age (segundos) para o navegador acompanhar o servidor.
	RefreshCookieMaxAge int
}

// Resolve valida o token e aplica a renovação deslizante: se o último uso passou de SlideEvery, o vencimento
// é recalculado (ociosidade a partir de agora, limitada ao teto). Falha ao gravar a renovação só vira log:
// a requisição continua válida.
func (s *Service) Resolve(ctx context.Context, token string) (Authed, error) {
	if token == "" {
		return Authed{}, ErrUnauthorized
	}
	h := hashToken(token)
	info, err := s.store.Session(ctx, h)
	if err != nil {
		return Authed{}, err
	}
	now := s.now()
	if !info.Expires.After(now) {
		return Authed{}, ErrUnauthorized
	}
	out := Authed{UserID: info.UserID, Remember: info.Remember}
	if now.Sub(info.LastSeen) >= SlideEvery {
		exp := expiryFor(info.Remember, info.CreatedAt, now)
		if exp.After(info.Expires) {
			ok, err := s.store.SlideSession(ctx, h, now, exp, now.Add(-SlideEvery))
			switch {
			case err != nil:
				slog.Warn("renovar sessão", "err", err)
			case ok && info.Remember:
				out.RefreshCookieMaxAge = int(exp.Sub(now).Seconds())
			}
		}
	}
	return out, nil
}

// CookieMaxAge é o Max-Age do cookie de uma sessão nova: persistente (segundos) se lembrada, 0 = cookie de
// sessão do navegador (sem Max-Age) se não.
func CookieMaxAge(remember bool) int {
	if remember {
		return int(RememberIdleTTL.Seconds())
	}
	return 0
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

// NewSession abre uma sessão LONGA ("lembrada") para o usuário (login social e handoff do desktop); devolve o
// token em claro.
func (s *Service) NewSession(ctx context.Context, userID int64, userAgent *string) (string, error) {
	return s.newSession(ctx, userID, userAgent, true)
}

func (s *Service) newSession(ctx context.Context, userID int64, userAgent *string, remember bool) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("gerar token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	// Só o hash é salvo: um vazamento do banco não entrega sessões válidas.
	now := s.now()
	if err := s.store.CreateSession(ctx, s.ids.Next(), userID, hashToken(token), userAgent, remember, now, expiryFor(remember, now, now)); err != nil {
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
	if hash == user.NoPassword {
		return ErrWrongPassword
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

// ValidateNewPassword aplica as regras de força de senha (para quem define senha fora do auth).
func (s *Service) ValidateNewPassword(pw string) error { return ValidatePassword(pw) }

// HasPassword diz se a conta tem senha (falso nas contas criadas por login social).
func (s *Service) HasPassword(ctx context.Context, userID int64) (bool, error) {
	hash, err := s.users.PasswordHash(ctx, userID)
	if err != nil {
		return false, err
	}
	return hash != user.NoPassword, nil
}

// ResetPassword define uma senha nova sem exigir a atual (recuperação por e-mail ou pelo admin) e encerra
// TODAS as sessões do usuário, inclusive as conexões do gateway.
func (s *Service) ResetPassword(ctx context.Context, userID int64, next string) error {
	if err := ValidatePassword(next); err != nil {
		return err
	}
	hash, err := s.hasher.Hash(ctx, next)
	if err != nil {
		return err
	}
	if err := s.users.SetPasswordHash(ctx, userID, hash); err != nil {
		return err
	}
	if err := s.store.DeleteAllSessions(ctx, userID); err != nil {
		return err
	}
	s.NotifyRevoked(userID, "")
	return nil
}

// ErrHasPassword: SetInitialPassword só vale para contas sem senha.
var ErrHasPassword = errors.New("a conta já tem senha")

// SetInitialPassword define a primeira senha de uma conta criada por login social. A confirmação recente
// (reautenticação social) é exigida pela camada HTTP. As outras sessões são encerradas; a atual continua.
func (s *Service) SetInitialPassword(ctx context.Context, userID int64, token, next string) error {
	has, err := s.HasPassword(ctx, userID)
	if err != nil {
		return err
	}
	if has {
		return ErrHasPassword
	}
	if err := ValidatePassword(next); err != nil {
		return err
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
	s.NotifyRevoked(userID, TokenKey(token))
	return nil
}

// ConfirmRecent marca a sessão como confirmada agora sem senha (reautenticação social de quem não tem senha).
func (s *Service) ConfirmRecent(ctx context.Context, token string) error {
	return s.store.ConfirmSession(ctx, hashToken(token), s.now())
}

// ListSessions devolve as sessões ativas do usuário; current marca a do token informado.
func (s *Service) ListSessions(ctx context.Context, userID int64, token string) ([]SessionRow, []bool, error) {
	rows, err := s.store.ListSessions(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	cur := hashToken(token)
	flags := make([]bool, len(rows))
	for i, r := range rows {
		flags[i] = bytes.Equal(r.TokenHash, cur)
	}
	return rows, flags, nil
}

// RevokeSession encerra uma sessão do usuário (inclusive a atual: equivale a sair) e derruba as conexões dela
// no gateway. ErrSessionNotFound se não existir ou for de outro usuário.
func (s *Service) RevokeSession(ctx context.Context, userID, id int64) error {
	h, err := s.store.DeleteSessionByID(ctx, userID, id)
	if err != nil {
		return err
	}
	if s.onRevokeKey != nil {
		s.onRevokeKey(userID, hex.EncodeToString(h))
	}
	return nil
}

// RevokeOthers encerra todas as sessões do usuário menos a do token informado ("Encerrar todas as outras") e
// derruba as conexões delas no gateway. Devolve quantas foram encerradas.
func (s *Service) RevokeOthers(ctx context.Context, userID int64, token string) (int64, error) {
	n, err := s.store.DeleteOtherSessions(ctx, userID, hashToken(token))
	if err != nil {
		return 0, err
	}
	if n > 0 {
		s.NotifyRevoked(userID, TokenKey(token))
	}
	return n, nil
}

// OnRevokeKey registra quem deve derrubar as conexões de UMA sessão encerrada (chave = TokenKey).
func (s *Service) OnRevokeKey(fn func(userID int64, key string)) { s.onRevokeKey = fn }
