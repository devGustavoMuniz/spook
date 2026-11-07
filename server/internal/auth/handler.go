package auth

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/user"
)

const (
	CookieName   = "spook_session"
	desktopValue = "desktop"
)

type ctxKey int

const (
	userIDKey ctxKey = iota
	tokenKey
)

// UserID devolve o usuário autenticado (0 fora de rotas protegidas).
func UserID(ctx context.Context) int64 {
	id, _ := ctx.Value(userIDKey).(int64)
	return id
}

func token(ctx context.Context) string {
	t, _ := ctx.Value(tokenKey).(string)
	return t
}

// Security descreve os esquemas aceitos em rotas protegidas (cookie da web ou Bearer do desktop).
var Security = []map[string][]string{{"cookieAuth": {}}, {"bearerAuth": {}}}

type Handler struct {
	svc     *Service
	secure  bool
	view    func(context.Context, user.User) user.View
	limiter *ratelimit.Limiter // por usuário e ação (trocar/confirmar senha)
}

// WithLimiter define o limitador de ações de senha por usuário.
func (h *Handler) WithLimiter(l *ratelimit.Limiter) *Handler { h.limiter = l; return h }

// CodePasswordConfirmationRequired é o `code` do 403 devolvido às ações que exigem senha confirmada há pouco.
const CodePasswordConfirmationRequired = "password_confirmation_required"

// Token devolve o token da sessão atual (vazio fora de rotas protegidas); serve a quem precisa
// identificar a sessão (ex.: o gateway, ao emitir tickets).
func Token(ctx context.Context) string { return token(ctx) }

// RequireRecentPassword é o middleware das ações sensíveis (trocar e-mail, excluir servidor...): deve
// vir DEPOIS de Middleware. Sem confirmação de senha nos últimos 10 min responde 403 com
// `code: "password_confirmation_required"`; o cliente pede a senha (POST /api/auth/confirm-password)
// e repete a ação.
func (h *Handler) RequireRecentPassword(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		ok, err := h.svc.RecentlyConfirmed(ctx.Context(), token(ctx.Context()))
		if err != nil {
			slog.Error("verificar confirmação de senha", "err", err)
			_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, "erro interno")
			return
		}
		if !ok {
			ctx.SetHeader("Content-Type", "application/problem+json")
			ctx.SetStatus(http.StatusForbidden)
			_ = json.NewEncoder(ctx.BodyWriter()).Encode(&httpx.ProblemError{
				Status: http.StatusForbidden, Code: CodePasswordConfirmationRequired,
				Detail: "confirme sua senha para continuar",
			})
			return
		}
		next(ctx)
	}
}

// NewHandler: secure marca o cookie como Secure (desligado só em dev http); view monta o perfil da resposta.
func NewHandler(svc *Service, secure bool, view func(context.Context, user.User) user.View) *Handler {
	return &Handler{svc: svc, secure: secure, view: view}
}

// Middleware exige sessão válida (cookie ou Authorization: Bearer) e coloca usuário e token no contexto.
func (h *Handler) Middleware(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		tok, viaCookie := "", false
		if a := ctx.Header("Authorization"); strings.HasPrefix(a, "Bearer ") {
			tok = strings.TrimPrefix(a, "Bearer ")
		} else if c, err := huma.ReadCookie(ctx, CookieName); err == nil {
			tok, viaCookie = c.Value, true
		}
		au, err := h.svc.Resolve(ctx.Context(), tok)
		if err != nil {
			if errors.Is(err, ErrUnauthorized) {
				_ = huma.WriteErr(api, ctx, http.StatusUnauthorized, "autenticação necessária")
			} else {
				_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, "erro interno")
			}
			return
		}
		// Validade renovada numa sessão lembrada: reenvia o cookie persistente com o Max-Age novo.
		if viaCookie && au.RefreshCookieMaxAge > 0 {
			c := h.cookie(tok, au.RefreshCookieMaxAge)
			ctx.AppendHeader("Set-Cookie", c.String())
		}
		next(huma.WithValue(huma.WithValue(ctx, userIDKey, au.UserID), tokenKey, tok))
	}
}

type SessionBody struct {
	User  user.View `json:"user"`
	Token string    `json:"token,omitempty" doc:"Só é devolvido ao cliente desktop (header X-Spook-Client: desktop); a web usa o cookie httpOnly"`
}

type SessionOutput struct {
	SetCookie http.Cookie `header:"Set-Cookie"`
	Body      SessionBody
}

type ClientHeaders struct {
	UserAgent string `header:"User-Agent"`
	Client    string `header:"X-Spook-Client" doc:"Use \"desktop\" para receber o token no corpo"`
}

type RegisterInput struct {
	ClientHeaders
	Body struct {
		Email    string `json:"email" format:"email" maxLength:"254"`
		Username string `json:"username" pattern:"^[a-z0-9_.]{2,32}$" patternDescription:"2 a 32 caracteres: a-z, 0-9, _ e ." minLength:"2" maxLength:"32"`
		Password string `json:"password" minLength:"8" maxLength:"128"`
		Remember *bool  `json:"remember,omitempty" default:"true" doc:"\"Manter conectado\": true (padrão) = sessão longa (90 dias deslizantes, cookie persistente); false = 24 h deslizantes e cookie de sessão (some ao fechar o navegador)"`
	}
}

type LoginInput struct {
	ClientHeaders
	Body struct {
		Email    string `json:"email" format:"email" maxLength:"254"`
		Password string `json:"password" minLength:"1" maxLength:"128"`
		Remember *bool  `json:"remember,omitempty" default:"true" doc:"\"Manter conectado\": true (padrão) = sessão longa (90 dias deslizantes, cookie persistente); false = 24 h deslizantes e cookie de sessão (some ao fechar o navegador)"`
	}
}

type ConfirmPasswordInput struct {
	Body struct {
		Password string `json:"password" minLength:"1" maxLength:"128"`
	}
}

type ConfirmPasswordOutput struct {
	Body struct {
		ConfirmedUntil time.Time `json:"confirmed_until" doc:"Até quando as ações sensíveis ficam liberadas nesta sessão"`
	}
}

type ChangePasswordInput struct {
	Body struct {
		CurrentPassword string `json:"current_password" minLength:"1" maxLength:"128"`
		NewPassword     string `json:"new_password" minLength:"8" maxLength:"128"`
	}
}

type SetPasswordInput struct {
	Body struct {
		NewPassword string `json:"new_password" minLength:"8" maxLength:"128"`
	}
}

type DesktopAuthorizeInput struct {
	Body struct {
		CodeChallenge string `json:"code_challenge" pattern:"^[A-Za-z0-9_-]{43}$" patternDescription:"base64url(SHA-256(code_verifier)), 43 caracteres" minLength:"43" maxLength:"43"`
	}
}

type DesktopAuthorizeOutput struct {
	Body struct {
		Code        string    `json:"code" doc:"Código de uso único (60 s) para o app trocar por um token"`
		RedirectURL string    `json:"redirect_url" doc:"Deep link spook://auth?code=... para o navegador abrir o app"`
		ExpiresAt   time.Time `json:"expires_at"`
	}
}

type DesktopExchangeInput struct {
	ClientHeaders
	Body struct {
		Code         string `json:"code" minLength:"20" maxLength:"128"`
		CodeVerifier string `json:"code_verifier" minLength:"43" maxLength:"128" pattern:"^[A-Za-z0-9._~-]+$" doc:"PKCE: o segredo cujo SHA-256 (base64url) foi enviado como code_challenge"`
	}
}

type DesktopExchangeOutput struct{ Body SessionBody }

type LogoutOutput struct {
	SetCookie http.Cookie `header:"Set-Cookie"`
}

func (h *Handler) cookie(value string, maxAge int) http.Cookie {
	return SessionCookie(value, h.secure, maxAge)
}

// SessionCookie monta o cookie de sessão (httpOnly, SameSite=Lax; Secure fora do http de desenvolvimento).
func SessionCookie(value string, secure bool, maxAge int) http.Cookie {
	return http.Cookie{
		Name: CookieName, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode,
	}
}

func (h *Handler) session(ctx context.Context, in ClientHeaders, u user.User, tok string, remember bool) *SessionOutput {
	out := &SessionOutput{SetCookie: h.cookie(tok, CookieMaxAge(remember)), Body: SessionBody{User: h.view(ctx, u)}}
	if in.Client == desktopValue {
		out.Body.Token = tok
	}
	return out
}

func (h *Handler) Register(api huma.API, authed, sensitive huma.Middlewares) {
	h.registerSessions(api, authed, sensitive)
	huma.Register(api, huma.Operation{
		OperationID: "register", Method: http.MethodPost, Path: "/api/auth/register",
		Summary: "Cadastro (já abre a sessão)", Tags: []string{"auth"}, DefaultStatus: http.StatusCreated,
		Errors: []int{http.StatusConflict, http.StatusUnprocessableEntity},
	}, func(ctx context.Context, in *RegisterInput) (*SessionOutput, error) {
		ua := optional(in.UserAgent)
		u, tok, err := h.svc.Register(ctx, in.Body.Email, in.Body.Username, in.Body.Password, ua, rememberOf(in.Body.Remember))
		switch {
		case errors.Is(err, user.ErrEmailTaken):
			return nil, huma.Error409Conflict("e-mail já cadastrado")
		case errors.Is(err, user.ErrUsernameTaken):
			return nil, huma.Error409Conflict("nome de usuário já em uso")
		case errors.Is(err, user.ErrReservedUsername):
			return nil, huma.Error422UnprocessableEntity("esse nome de usuário é reservado; escolha outro")
		case errors.Is(err, ErrWeakPassword):
			return nil, huma.Error422UnprocessableEntity("a senha deve ter de 8 a 128 caracteres")
		case err != nil:
			return nil, err
		}
		return h.session(ctx, in.ClientHeaders, u, tok, rememberOf(in.Body.Remember)), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "login", Method: http.MethodPost, Path: "/api/auth/login",
		Summary: "Login", Tags: []string{"auth"}, Errors: []int{http.StatusUnauthorized},
	}, func(ctx context.Context, in *LoginInput) (*SessionOutput, error) {
		u, tok, err := h.svc.Login(ctx, in.Body.Email, in.Body.Password, optional(in.UserAgent), rememberOf(in.Body.Remember))
		if errors.Is(err, ErrUnauthorized) {
			return nil, huma.Error401Unauthorized("e-mail ou senha incorretos")
		}
		if err != nil {
			return nil, err
		}
		return h.session(ctx, in.ClientHeaders, u, tok, rememberOf(in.Body.Remember)), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "logout", Method: http.MethodPost, Path: "/api/auth/logout",
		Summary: "Logout (encerra a sessão atual)", Tags: []string{"auth"}, DefaultStatus: http.StatusNoContent,
		Security: Security, Middlewares: authed, Errors: []int{http.StatusUnauthorized},
	}, func(ctx context.Context, _ *struct{}) (*LogoutOutput, error) {
		if err := h.svc.Logout(ctx, token(ctx)); err != nil {
			return nil, err
		}
		return &LogoutOutput{SetCookie: h.cookie("", -1)}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "confirmPassword", Method: http.MethodPost, Path: "/api/auth/confirm-password",
		Summary: "Confirma a senha (\"modo sudo\"): a sessão fica confirmada por 10 minutos",
		Description: "Libera as ações sensíveis (trocar e-mail, excluir conta ou servidor). " +
			"Senha errada responde 422; limite: 5 tentativas e depois 1 a cada 30 s por usuário.",
		Tags: []string{"auth"}, Security: Security, Middlewares: authed,
		Errors: []int{http.StatusUnauthorized, http.StatusUnprocessableEntity, http.StatusTooManyRequests},
	}, func(ctx context.Context, in *ConfirmPasswordInput) (*ConfirmPasswordOutput, error) {
		uid := UserID(ctx)
		if err := httpx.Take(h.limiter, "confirm:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		until, err := h.svc.ConfirmPassword(ctx, uid, token(ctx), in.Body.Password)
		if errors.Is(err, ErrWrongPassword) {
			return nil, huma.Error422UnprocessableEntity("senha incorreta")
		}
		if err != nil {
			return nil, err
		}
		out := &ConfirmPasswordOutput{}
		out.Body.ConfirmedUntil = until
		return out, nil
	})

	h.registerDesktop(api, authed)

	setPwd := huma.Operation{
		OperationID: "setInitialPassword", Method: http.MethodPost, Path: "/api/users/me/password/initial",
		Summary: "Define a primeira senha de uma conta criada por login social",
		Description: "Só para contas sem senha (`has_password: false`). Exige a sessão reautenticada nos últimos 10 min " +
			"(`/api/auth/social/google|discord/start?intent=reauth`); sem isso responde 403 `password_confirmation_required`. " +
			"Encerra as outras sessões. Conta que já tem senha responde 409.",
		Tags: []string{"users"}, Security: Security, Middlewares: huma.Middlewares{authed[0], h.RequireRecentPassword(api)}, DefaultStatus: http.StatusNoContent,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusConflict, http.StatusUnprocessableEntity, http.StatusTooManyRequests},
	}
	huma.Register(api, setPwd, func(ctx context.Context, in *SetPasswordInput) (*struct{}, error) {
		uid := UserID(ctx)
		if err := httpx.Take(h.limiter, "pwd:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		err := h.svc.SetInitialPassword(ctx, uid, token(ctx), in.Body.NewPassword)
		switch {
		case errors.Is(err, ErrHasPassword):
			return nil, huma.Error409Conflict("a conta já tem senha; use a troca de senha")
		case errors.Is(err, ErrWeakPassword):
			return nil, huma.Error422UnprocessableEntity("a senha deve ter de 8 a 128 caracteres")
		case err != nil:
			return nil, err
		}
		return nil, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "changePassword", Method: http.MethodPost, Path: "/api/users/me/password",
		Summary: "Troca a senha (encerra as outras sessões e mantém a atual)",
		Description: "Exige a senha atual. A nova segue as regras do cadastro (8 a 128 caracteres) e precisa ser diferente. " +
			"As demais sessões (e conexões do gateway) são encerradas. Limite: 5 tentativas e depois 1 a cada 30 s por usuário.",
		Tags: []string{"users"}, Security: Security, Middlewares: authed, DefaultStatus: http.StatusNoContent,
		Errors: []int{http.StatusUnauthorized, http.StatusUnprocessableEntity, http.StatusTooManyRequests},
	}, func(ctx context.Context, in *ChangePasswordInput) (*struct{}, error) {
		uid := UserID(ctx)
		if err := httpx.Take(h.limiter, "pwd:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		err := h.svc.ChangePassword(ctx, uid, token(ctx), in.Body.CurrentPassword, in.Body.NewPassword)
		switch {
		case errors.Is(err, ErrWrongPassword):
			return nil, huma.Error422UnprocessableEntity("senha atual incorreta")
		case errors.Is(err, ErrWeakPassword):
			return nil, huma.Error422UnprocessableEntity("a nova senha deve ter de 8 a 128 caracteres")
		case errors.Is(err, ErrSamePassword):
			return nil, huma.Error422UnprocessableEntity("a nova senha deve ser diferente da atual")
		case err != nil:
			return nil, err
		}
		return nil, nil
	})
}

// DesktopRedirectScheme é o esquema do deep link do app desktop.
const DesktopRedirectScheme = "spook://auth"

func (h *Handler) registerDesktop(api huma.API, authed huma.Middlewares) {
	huma.Register(api, huma.Operation{
		OperationID: "desktopAuthorize", Method: http.MethodPost, Path: "/api/auth/desktop/authorize",
		Summary: "Login do desktop pelo navegador: gera o código de uso único para o app",
		Description: "Chamado pela página /desktop-login depois que a pessoa confirma \"Entrar no app do computador\" (sessão do navegador). " +
			"Devolve o código (vale 60 s, uso único) e o deep link `spook://auth?code=...`. O app troca o código em `POST /api/auth/desktop/exchange` com o `code_verifier` (PKCE).",
		Tags: []string{"auth"}, Security: Security, Middlewares: authed,
		Errors: []int{http.StatusUnauthorized, http.StatusTooManyRequests},
	}, func(ctx context.Context, in *DesktopAuthorizeInput) (*DesktopAuthorizeOutput, error) {
		uid := UserID(ctx)
		if err := httpx.Take(h.limiter, "desktop:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		code, exp, err := h.svc.DesktopAuthorize(ctx, uid, in.Body.CodeChallenge)
		if errors.Is(err, ErrInvalidChallenge) {
			return nil, huma.Error422UnprocessableEntity("code_challenge inválido")
		}
		if err != nil {
			return nil, err
		}
		out := &DesktopAuthorizeOutput{}
		out.Body.Code, out.Body.ExpiresAt = code, exp
		out.Body.RedirectURL = DesktopRedirectScheme + "?code=" + code
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "desktopExchange", Method: http.MethodPost, Path: "/api/auth/desktop/exchange",
		Summary: "Troca o código do handoff (+ code_verifier PKCE) por um token Bearer do desktop",
		Description: "Sem sessão prévia. O código é de uso único e vale 60 s; uma tentativa com verificador errado também consome o código. " +
			"Devolve o token no corpo (como o login com `X-Spook-Client: desktop`) e abre a sessão.",
		Tags: []string{"auth"}, Errors: []int{http.StatusUnprocessableEntity},
	}, func(ctx context.Context, in *DesktopExchangeInput) (*DesktopExchangeOutput, error) {
		u, tok, err := h.svc.DesktopExchange(ctx, in.Body.Code, in.Body.CodeVerifier, optional(in.UserAgent))
		if errors.Is(err, ErrInvalidCode) {
			return nil, huma.Error422UnprocessableEntity("código inválido ou expirado; entre pelo navegador de novo")
		}
		if err != nil {
			return nil, err
		}
		return &DesktopExchangeOutput{Body: SessionBody{User: h.view(ctx, u), Token: tok}}, nil
	})
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	if len(s) > 300 {
		s = s[:300]
	}
	return &s
}

// rememberOf aplica o padrão do contrato: ausente = true. (É ponteiro porque o huma trata `false` como
// "campo vazio" e o trocaria pelo padrão; com ponteiro um `false` explícito chega como false.)
func rememberOf(r *bool) bool { return r == nil || *r }
