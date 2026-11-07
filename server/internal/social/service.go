package social

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"

	"github.com/devGustavoMuniz/spook/server/internal/platform/secret"
	"github.com/devGustavoMuniz/spook/server/internal/user"
)

var tracer = otel.Tracer("spook/social")

// PendingTTL é a validade do cadastro social pendente (a tela "Escolha seu username").
const PendingTTL = 15 * time.Minute

// Códigos de erro que voltam à web em `?social_error=`.
const (
	ErrCodeState        = "state"            // estado/cookie inválido ou expirado
	ErrCodeDenied       = "denied"           // a pessoa recusou no provedor
	ErrCodeProvider     = "provider_error"   // falha ao falar com o provedor
	ErrCodeNoEmail      = "no_email"         // o provedor não devolveu e-mail
	ErrCodeUnverified   = "email_unverified" // o e-mail do provedor não é verificado
	ErrCodeAlreadyLinks = "already_linked"   // essa conta do provedor já pertence a outro usuário
	ErrCodeHasProvider  = "provider_linked"  // a conta com esse e-mail já tem OUTRA conta desse provedor vinculada
	ErrCodeWrongAccount = "wrong_account"    // reautenticou com outra conta do provedor
	ErrCodeNeedSession  = "need_session"     // vincular/reautenticar exige estar logado
	ErrCodeNeedConfirm  = "need_confirm"     // vincular exige a senha confirmada há pouco
	ErrCodeInternal     = "internal"
)

var (
	ErrProviderOff = errors.New("provedor desligado")
	ErrBadIntent   = errors.New("intenção inválida")
	ErrNeedSession = errors.New("é preciso estar logado")
	ErrNeedConfirm = errors.New("confirme sua senha antes")
	ErrBadUsername = errors.New("nome de usuário inválido")
	usernameRe     = regexp.MustCompile(`^[a-z0-9_.]{2,32}$`)
)

// Store é o que o service precisa do banco.
type Store interface {
	Find(ctx context.Context, provider, providerID string) (Account, error)
	List(ctx context.Context, userID int64) ([]Account, error)
	Link(ctx context.Context, id, userID int64, provider, providerID, email string) error
	Unlink(ctx context.Context, userID int64, provider string) error
	HasPassword(ctx context.Context, userID int64) (bool, error)
	// LinkByEmail vincula a conta do provedor à conta que tem esse e-mail (ErrNoUserForEmail se não houver).
	LinkByEmail(ctx context.Context, accountID int64, provider, providerID, email string) (LinkedUser, error)
	CreatePending(ctx context.Context, hash []byte, p Pending) error
	GetPending(ctx context.Context, hash []byte) (Pending, error)
	Complete(ctx context.Context, hash []byte, userID, accountID int64, username string) (user.User, error)
}

// Sessions é o que o service precisa do pacote auth.
type Sessions interface {
	Authenticate(ctx context.Context, token string) (int64, error)
	RecentlyConfirmed(ctx context.Context, token string) (bool, error)
	ConfirmRecent(ctx context.Context, token string) error
	NewSession(ctx context.Context, userID int64, userAgent *string) (string, error)
	// NotifyRevoked derruba as conexões do gateway do usuário (keepKey vazio = todas).
	NotifyRevoked(userID int64, keepKey string)
}

type IDGenerator interface{ Next() int64 }

type Deps struct {
	Providers map[string]Provider // só os ligados
	PublicURL string              // base dos callbacks
	Box       *secret.Box
	Store     Store
	Sessions  Sessions
	IDs       IDGenerator
	Now       func() time.Time
}

type Service struct{ d Deps }

func NewService(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	return &Service{d: d}
}

// Enabled lista os provedores ligados, em ordem estável.
func (s *Service) Enabled() []string {
	var out []string
	for _, n := range []string{Google, Discord} {
		if _, ok := s.d.Providers[n]; ok {
			out = append(out, n)
		}
	}
	return out
}

// CallbackURL é o redirect_uri registrado no app OAuth do provedor.
func (s *Service) CallbackURL(provider string) string {
	return s.d.PublicURL + "/api/auth/social/" + provider + "/callback"
}

// StartResult é o que o handler precisa para redirecionar ao provedor.
type StartResult struct {
	URL    string // destino do redirecionamento
	Cookie string // valor assinado do cookie do fluxo
}

// Start inicia o fluxo. link e reauth exigem sessão (link exige ainda a senha confirmada há pouco).
func (s *Service) Start(ctx context.Context, provider, intent, redirect, sessionToken string) (StartResult, error) {
	ctx, span := tracer.Start(ctx, "social.Start")
	defer span.End()
	span.SetAttributes(attribute.String("provider", provider), attribute.String("intent", intent))
	p, ok := s.d.Providers[provider]
	if !ok {
		return StartResult{}, ErrProviderOff
	}
	if intent == "" {
		intent = IntentLogin
	}
	var uid int64
	switch intent {
	case IntentLogin:
	case IntentLink, IntentReauth:
		var err error
		if uid, err = s.d.Sessions.Authenticate(ctx, sessionToken); err != nil {
			return StartResult{}, ErrNeedSession
		}
		if intent == IntentLink {
			if ok, err := s.d.Sessions.RecentlyConfirmed(ctx, sessionToken); err != nil {
				return StartResult{}, err
			} else if !ok {
				return StartResult{}, ErrNeedConfirm
			}
		}
	default:
		return StartResult{}, ErrBadIntent
	}
	f, err := newFlow(provider, intent, redirect, uid, s.d.Now())
	if err != nil {
		return StartResult{}, fmt.Errorf("iniciar fluxo: %w", err)
	}
	url := p.AuthURL(AuthParams{State: f.State, Challenge: f.challenge(), RedirectURI: s.CallbackURL(provider), Reauth: intent != IntentLogin})
	return StartResult{URL: url, Cookie: f.seal(s.d.Box)}, nil
}

// Outcome é o resultado do retorno do provedor: para onde ir e que cookies definir.
type Outcome struct {
	Redirect     string
	SessionToken string // definir o cookie de sessão
	PendingToken string // definir o cookie do cadastro pendente
	ErrCode      string // preenchido quando o fluxo falhou (o Redirect já aponta para a tela certa)
}

func (s *Service) fail(f *flow, code string) Outcome {
	if f != nil && f.Intent != IntentLogin {
		return Outcome{Redirect: withParam(f.Redirect, "social_error", code), ErrCode: code}
	}
	dest := "/login?social_error=" + code
	if f != nil && f.Redirect != "/" {
		dest = withParam(dest, "redirect", f.Redirect)
	}
	return Outcome{Redirect: dest, ErrCode: code}
}

// Callback conclui o fluxo. Nunca devolve erro ao chamador: tudo vira um redirecionamento amigável (erros de
// infraestrutura são logados). providerErr é o parâmetro `error` do provedor (ex.: access_denied).
func (s *Service) Callback(ctx context.Context, provider, code, state, providerErr, flowCookie, sessionToken string, userAgent *string) Outcome {
	ctx, span := tracer.Start(ctx, "social.Callback")
	defer span.End()
	span.SetAttributes(attribute.String("provider", provider))
	p, ok := s.d.Providers[provider]
	if !ok {
		return s.fail(nil, ErrCodeProvider)
	}
	f, err := openFlow(s.d.Box, flowCookie, provider, state, s.d.Now())
	if err != nil {
		return s.fail(nil, ErrCodeState)
	}
	span.SetAttributes(attribute.String("intent", f.Intent))
	if providerErr != "" {
		if providerErr == "access_denied" {
			return s.fail(&f, ErrCodeDenied)
		}
		return s.fail(&f, ErrCodeProvider)
	}
	if code == "" {
		return s.fail(&f, ErrCodeProvider)
	}
	prof, err := p.Exchange(ctx, code, f.Verifier, s.CallbackURL(provider))
	if err != nil || prof.ID == "" {
		slog.Warn("login social: falha na troca do código", "provider", provider, "err", err)
		return s.fail(&f, ErrCodeProvider)
	}
	var out Outcome
	switch f.Intent {
	case IntentLink:
		out = s.link(ctx, f, prof, sessionToken)
	case IntentReauth:
		out = s.reauth(ctx, f, prof, sessionToken)
	default:
		out = s.login(ctx, f, prof, userAgent)
	}
	return out
}

func (s *Service) internal(f flow, err error) Outcome {
	slog.Error("login social", "intent", f.Intent, "provider", f.Provider, "err", err)
	return s.fail(&f, ErrCodeInternal)
}

func (s *Service) login(ctx context.Context, f flow, prof Profile, ua *string) Outcome {
	acc, err := s.d.Store.Find(ctx, f.Provider, prof.ID)
	switch {
	case err == nil:
		tok, err := s.d.Sessions.NewSession(ctx, acc.UserID, ua)
		if err != nil {
			return s.internal(f, err)
		}
		return Outcome{Redirect: f.Redirect, SessionToken: tok}
	case !errors.Is(err, ErrNotFound):
		return s.internal(f, err)
	}
	// Sem conta social vinculada. Só segue com e-mail verificado PELO PROVEDOR (Google `email_verified`, Discord
	// `verified`): é isso que prova que a pessoa controla o endereço.
	if prof.Email == "" {
		return s.fail(&f, ErrCodeNoEmail)
	}
	if !prof.EmailVerified {
		return s.fail(&f, ErrCodeUnverified)
	}
	// Já existe conta com esse e-mail (sem diferença de caixa)? Então vincula e entra (SPEC 7.4).
	linked, err := s.d.Store.LinkByEmail(ctx, s.d.IDs.Next(), f.Provider, prof.ID, prof.Email)
	switch {
	case err == nil:
		return s.loginLinked(ctx, f, linked, ua)
	case errors.Is(err, ErrAlreadyLinked):
		return s.fail(&f, ErrCodeHasProvider)
	case errors.Is(err, ErrLinkedElsewhere):
		return s.fail(&f, ErrCodeAlreadyLinks)
	case !errors.Is(err, ErrNoUserForEmail):
		return s.internal(f, err)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return s.internal(f, err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	name := prof.Name
	if r := []rune(name); len(r) > 32 {
		name = string(r[:32])
	}
	err = s.d.Store.CreatePending(ctx, hash(token), Pending{
		Provider: f.Provider, ProviderID: prof.ID, Email: prof.Email, DisplayName: name,
		Suggested: suggestUsername(prof.Name, prof.Email), Expires: s.d.Now().Add(PendingTTL),
	})
	if err != nil {
		return s.internal(f, err)
	}
	dest := "/auth/choose-username"
	if f.Redirect != "/" {
		dest = withParam(dest, "redirect", f.Redirect)
	}
	return Outcome{Redirect: dest, PendingToken: token}
}

// loginLinked abre a sessão (longa) de uma conta que acabou de ganhar o vínculo social pelo e-mail. Se o e-mail
// da conta ainda NÃO estava verificado, ele passou a ser e TODAS as sessões antigas caíram (tudo na transação
// do vínculo): quem cadastrou o e-mail alheio com senha antes ("pre-hijacking") perde o acesso que já tinha
// aberto. Aqui só se derrubam as conexões do gateway delas e abre-se a sessão nova.
func (s *Service) loginLinked(ctx context.Context, f flow, l LinkedUser, ua *string) Outcome {
	if l.WasUnverified {
		s.d.Sessions.NotifyRevoked(l.UserID, "")
	}
	level := slog.LevelInfo
	if l.WasUnverified {
		level = slog.LevelWarn // vínculo que verificou o e-mail e derrubou sessões: merece atenção na auditoria
	}
	slog.Log(ctx, level, "login social: conta existente vinculada pelo e-mail verificado do provedor",
		"user", l.UserID, "provider", f.Provider, "email_was_unverified", l.WasUnverified, "sessions_revoked", l.Revoked)
	tok, err := s.d.Sessions.NewSession(ctx, l.UserID, ua)
	if err != nil {
		return s.internal(f, err)
	}
	return Outcome{Redirect: f.Redirect, SessionToken: tok}
}

// sessionUser confere que a sessão atual é a do usuário que iniciou o fluxo.
func (s *Service) sessionUser(ctx context.Context, f flow, token string) bool {
	uid, err := s.d.Sessions.Authenticate(ctx, token)
	return err == nil && uid == f.UserID && f.UserID != 0
}

func (s *Service) link(ctx context.Context, f flow, prof Profile, token string) Outcome {
	if !s.sessionUser(ctx, f, token) {
		return s.fail(&f, ErrCodeNeedSession)
	}
	if ok, err := s.d.Sessions.RecentlyConfirmed(ctx, token); err != nil {
		return s.internal(f, err)
	} else if !ok {
		return s.fail(&f, ErrCodeNeedConfirm)
	}
	err := s.d.Store.Link(ctx, s.d.IDs.Next(), f.UserID, f.Provider, prof.ID, prof.Email)
	switch {
	case errors.Is(err, ErrLinkedElsewhere):
		return s.fail(&f, ErrCodeAlreadyLinks)
	case errors.Is(err, ErrAlreadyLinked):
		return s.fail(&f, ErrCodeHasProvider)
	case err != nil:
		return s.internal(f, err)
	}
	return Outcome{Redirect: withParam(f.Redirect, "linked", f.Provider)}
}

func (s *Service) reauth(ctx context.Context, f flow, prof Profile, token string) Outcome {
	if !s.sessionUser(ctx, f, token) {
		return s.fail(&f, ErrCodeNeedSession)
	}
	acc, err := s.d.Store.Find(ctx, f.Provider, prof.ID)
	if errors.Is(err, ErrNotFound) || (err == nil && acc.UserID != f.UserID) {
		return s.fail(&f, ErrCodeWrongAccount)
	}
	if err != nil {
		return s.internal(f, err)
	}
	if err := s.d.Sessions.ConfirmRecent(ctx, token); err != nil {
		return s.internal(f, err)
	}
	return Outcome{Redirect: withParam(f.Redirect, "reauth", "ok")}
}

func hash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// PendingInfo devolve o que a tela "Escolha seu username" mostra.
func (s *Service) PendingInfo(ctx context.Context, token string) (Pending, error) {
	if token == "" {
		return Pending{}, ErrSignupExpired
	}
	return s.d.Store.GetPending(ctx, hash(token))
}

// Complete conclui o cadastro social com o username escolhido e abre a sessão.
func (s *Service) Complete(ctx context.Context, pendingToken, username string, ua *string) (user.User, string, error) {
	ctx, span := tracer.Start(ctx, "social.Complete")
	defer span.End()
	if pendingToken == "" {
		return user.User{}, "", ErrSignupExpired
	}
	username = strings.ToLower(strings.TrimSpace(username))
	if !usernameRe.MatchString(username) {
		return user.User{}, "", ErrBadUsername
	}
	if user.IsReservedUsername(username) {
		return user.User{}, "", user.ErrReservedUsername
	}
	u, err := s.d.Store.Complete(ctx, hash(pendingToken), s.d.IDs.Next(), s.d.IDs.Next(), username)
	if err != nil {
		return user.User{}, "", err
	}
	tok, err := s.d.Sessions.NewSession(ctx, u.ID, ua)
	return u, tok, err
}

// Methods devolve as contas vinculadas e se a conta tem senha.
func (s *Service) Methods(ctx context.Context, userID int64) (hasPassword bool, accounts []Account, err error) {
	if hasPassword, err = s.d.Store.HasPassword(ctx, userID); err != nil {
		return false, nil, err
	}
	accounts, err = s.d.Store.List(ctx, userID)
	return hasPassword, accounts, err
}

// Unlink desvincula um provedor (nunca o último método de login). A confirmação recente é exigida pelo HTTP.
func (s *Service) Unlink(ctx context.Context, userID int64, provider string) error {
	return s.d.Store.Unlink(ctx, userID, provider)
}
