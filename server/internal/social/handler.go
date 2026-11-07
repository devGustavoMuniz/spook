package social

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"github.com/devGustavoMuniz/spook/server/internal/auth"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/user"
)

// Cookies do fluxo (curtos, httpOnly, SameSite=Lax: o retorno do provedor é uma navegação GET de primeiro nível).
const (
	FlowCookie    = "spook_oauth"
	PendingCookie = "spook_social_signup"
	cookiePath    = "/api/auth/social"
)

type Handler struct {
	svc          *Service
	userID       func(context.Context) int64
	view         func(context.Context, user.User) user.View
	secure       bool
	emailEnabled bool
	limiter      *ratelimit.Limiter
}

func NewHandler(svc *Service, userID func(context.Context) int64, view func(context.Context, user.User) user.View, secure bool) *Handler {
	return &Handler{svc: svc, userID: userID, view: view, secure: secure}
}

// WithEmailEnabled informa se o e-mail está ligado (a web mostra ou esconde "Esqueci minha senha").
func (h *Handler) WithEmailEnabled(on bool) *Handler { h.emailEnabled = on; return h }

// WithLimiter define o limitador por usuário do desvinculo.
func (h *Handler) WithLimiter(l *ratelimit.Limiter) *Handler { h.limiter = l; return h }

func (h *Handler) cookie(name, value string, maxAge int) http.Cookie {
	return http.Cookie{Name: name, Value: value, Path: cookiePath, MaxAge: maxAge, HttpOnly: true, Secure: h.secure, SameSite: http.SameSiteLaxMode}
}

func sessionCookieOf(r *http.Request) string {
	if c, err := r.Cookie(auth.CookieName); err == nil {
		return c.Value
	}
	return ""
}

// RegisterRoutes registra os dois redirecionamentos do OAuth (fora do OpenAPI: não são chamadas de API).
func (h *Handler) RegisterRoutes(r chi.Router) {
	r.Get("/api/auth/social/{provider}/start", h.start)
	r.Get("/api/auth/social/{provider}/callback", h.callback)
}

func (h *Handler) start(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	q := r.URL.Query()
	res, err := h.svc.Start(r.Context(), provider, q.Get("intent"), q.Get("redirect"), sessionCookieOf(r))
	switch {
	case err == nil:
	case errors.Is(err, ErrProviderOff):
		http.Redirect(w, r, "/login?social_error=provider_off", http.StatusSeeOther)
		return
	case errors.Is(err, ErrNeedSession), errors.Is(err, ErrNeedConfirm), errors.Is(err, ErrBadIntent):
		code := ErrCodeNeedSession
		if errors.Is(err, ErrNeedConfirm) {
			code = ErrCodeNeedConfirm
		}
		http.Redirect(w, r, withParam(SafeRedirect(q.Get("redirect")), "social_error", code), http.StatusSeeOther)
		return
	default:
		slog.Error("login social: iniciar", "provider", provider, "err", err)
		http.Redirect(w, r, "/login?social_error=internal", http.StatusSeeOther)
		return
	}
	c := h.cookie(FlowCookie, res.Cookie, int(flowTTL.Seconds()))
	http.SetCookie(w, &c)
	http.Redirect(w, r, res.URL, http.StatusSeeOther)
}

func (h *Handler) callback(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	q := r.URL.Query()
	flowCookie := ""
	if c, err := r.Cookie(FlowCookie); err == nil {
		flowCookie = c.Value
	}
	ua := r.UserAgent()
	if len(ua) > 300 {
		ua = ua[:300]
	}
	out := h.svc.Callback(r.Context(), provider, q.Get("code"), q.Get("state"), q.Get("error"), flowCookie, sessionCookieOf(r), &ua)
	// O cookie do fluxo é de uso único: some em qualquer resultado.
	clear := h.cookie(FlowCookie, "", -1)
	http.SetCookie(w, &clear)
	if out.SessionToken != "" {
		c := auth.SessionCookie(out.SessionToken, h.secure, auth.CookieMaxAge(true))
		http.SetCookie(w, &c)
	}
	if out.PendingToken != "" {
		c := h.cookie(PendingCookie, out.PendingToken, int(PendingTTL.Seconds()))
		http.SetCookie(w, &c)
	}
	http.Redirect(w, r, out.Redirect, http.StatusSeeOther)
}

type ProvidersOutput struct {
	Body struct {
		Providers    []string `json:"providers" doc:"Provedores de login social ligados (google, discord)"`
		EmailEnabled bool     `json:"email_enabled" doc:"O servidor envia e-mails (verificação, recuperação de senha). Falso = modo degradado"`
	}
}

type PendingInput struct {
	Cookie string `cookie:"spook_social_signup"`
}

type PendingOutput struct {
	Body struct {
		Provider  string `json:"provider"`
		Email     string `json:"email"`
		Suggested string `json:"suggested_username" doc:"Sugestão derivada do nome; a pessoa pode trocar"`
	}
}

type CompleteInput struct {
	auth.ClientHeaders
	Cookie string `cookie:"spook_social_signup"`
	Body   struct {
		Username string `json:"username" pattern:"^[a-z0-9_.]{2,32}$" patternDescription:"2 a 32 caracteres: a-z, 0-9, _ e ." minLength:"2" maxLength:"32"`
	}
}

type CompleteOutput struct {
	SetCookie []string `header:"Set-Cookie"`
	Body      auth.SessionBody
}

type MethodsOutput struct {
	Body struct {
		HasPassword bool          `json:"has_password"`
		Accounts    []AccountView `json:"accounts"`
	}
}

type AccountView struct {
	Provider  string    `json:"provider" enum:"google,discord"`
	Email     string    `json:"email,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type UnlinkInput struct {
	Provider string `path:"provider" enum:"google,discord"`
}

// CodeLastMethod é o `code` do 409 de quem tenta remover o último método de login.
const CodeLastMethod = "last_login_method"

func (h *Handler) Register(api huma.API, authed, sensitive huma.Middlewares) {
	huma.Register(api, huma.Operation{
		OperationID: "authProviders", Method: http.MethodGet, Path: "/api/auth/providers",
		Summary: "Provedores de login social ligados e se o e-mail está ativo", Tags: []string{"auth"},
	}, func(ctx context.Context, _ *struct{}) (*ProvidersOutput, error) {
		out := &ProvidersOutput{}
		out.Body.Providers, out.Body.EmailEnabled = h.svc.Enabled(), h.emailEnabled
		if out.Body.Providers == nil {
			out.Body.Providers = []string{}
		}
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "socialSignupPending", Method: http.MethodGet, Path: "/api/auth/social/pending",
		Summary: "Dados do cadastro social em andamento (tela \"Escolha seu username\")",
		Description: "Lê o cookie httpOnly `spook_social_signup`, criado quando o provedor confirma a identidade de alguém sem conta. " +
			"410 se o cadastro expirou (15 min) ou não existe.",
		Tags: []string{"auth"}, Errors: []int{http.StatusGone},
	}, func(ctx context.Context, in *PendingInput) (*PendingOutput, error) {
		p, err := h.svc.PendingInfo(ctx, in.Cookie)
		if errors.Is(err, ErrSignupExpired) {
			return nil, huma.NewError(http.StatusGone, "o cadastro expirou; entre com o provedor de novo")
		}
		if err != nil {
			return nil, err
		}
		out := &PendingOutput{}
		out.Body.Provider, out.Body.Email, out.Body.Suggested = p.Provider, p.Email, p.Suggested
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "socialSignupComplete", Method: http.MethodPost, Path: "/api/auth/social/complete",
		Summary: "Conclui o cadastro social com o username escolhido (sem senha) e abre a sessão",
		Description: "A conta nasce sem senha e com o e-mail já verificado pelo provedor; é possível definir uma senha depois. " +
			"Username em uso: 409; reservado ou inválido: 422; cadastro expirado: 410.",
		Tags: []string{"auth"}, DefaultStatus: http.StatusCreated,
		Errors: []int{http.StatusConflict, http.StatusGone, http.StatusUnprocessableEntity},
	}, func(ctx context.Context, in *CompleteInput) (*CompleteOutput, error) {
		ua := in.UserAgent
		if len(ua) > 300 {
			ua = ua[:300]
		}
		u, tok, err := h.svc.Complete(ctx, in.Cookie, in.Body.Username, &ua)
		switch {
		case errors.Is(err, ErrSignupExpired):
			return nil, huma.NewError(http.StatusGone, "o cadastro expirou; entre com o provedor de novo")
		case errors.Is(err, user.ErrUsernameTaken):
			return nil, huma.Error409Conflict("nome de usuário já em uso")
		case errors.Is(err, user.ErrEmailTaken), errors.Is(err, ErrLinkedElsewhere):
			return nil, huma.Error409Conflict("já existe uma conta com esses dados; entre com a sua senha")
		case errors.Is(err, user.ErrReservedUsername):
			return nil, huma.Error422UnprocessableEntity("esse nome de usuário é reservado; escolha outro")
		case errors.Is(err, ErrBadUsername):
			return nil, huma.Error422UnprocessableEntity("use de 2 a 32 caracteres: a-z, 0-9, _ e .")
		case err != nil:
			return nil, err
		}
		sess := auth.SessionCookie(tok, h.secure, auth.CookieMaxAge(true))
		gone := h.cookie(PendingCookie, "", -1)
		out := &CompleteOutput{SetCookie: []string{sess.String(), gone.String()}, Body: auth.SessionBody{User: h.view(ctx, u)}}
		if in.Client == "desktop" {
			out.Body.Token = tok
		}
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getLoginMethods", Method: http.MethodGet, Path: "/api/users/me/login-methods",
		Summary: "Métodos de login da conta: senha e contas sociais vinculadas",
		Tags:    []string{"users"}, Security: auth.Security, Middlewares: authed, Errors: []int{http.StatusUnauthorized},
	}, func(ctx context.Context, _ *struct{}) (*MethodsOutput, error) {
		has, accs, err := h.svc.Methods(ctx, h.userID(ctx))
		if err != nil {
			return nil, err
		}
		out := &MethodsOutput{}
		out.Body.HasPassword = has
		out.Body.Accounts = make([]AccountView, len(accs))
		for i, a := range accs {
			out.Body.Accounts[i] = AccountView{Provider: a.Provider, Email: a.Email, CreatedAt: a.CreatedAt}
		}
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "unlinkSocial", Method: http.MethodDelete, Path: "/api/auth/social/{provider}",
		Summary: "Desvincula uma conta social (exige a senha ou a reautenticação social recente)",
		Description: "Nunca remove o último método de login: sem senha e com um só provedor, responde 409 `last_login_method`. " +
			"Sem confirmação recente: 403 `password_confirmation_required`.",
		Tags: []string{"auth"}, Security: auth.Security, Middlewares: sensitive, DefaultStatus: http.StatusNoContent,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusConflict, http.StatusTooManyRequests},
	}, func(ctx context.Context, in *UnlinkInput) (*struct{}, error) {
		uid := h.userID(ctx)
		if err := httpx.Take(h.limiter, "unlink:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		err := h.svc.Unlink(ctx, uid, in.Provider)
		switch {
		case errors.Is(err, ErrNotFound):
			return nil, huma.Error404NotFound("essa conta não está vinculada")
		case errors.Is(err, ErrLastMethod):
			return nil, &httpx.ProblemError{Status: http.StatusConflict, Code: CodeLastMethod,
				Detail: "esse é o seu único método de login: defina uma senha ou vincule outro provedor antes"}
		case err != nil:
			return nil, err
		}
		return nil, nil
	})
}
