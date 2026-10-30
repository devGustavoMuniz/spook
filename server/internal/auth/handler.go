package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

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
	svc    *Service
	secure bool
	view   func(context.Context, user.User) user.View
}

// NewHandler: secure marca o cookie como Secure (desligado só em dev http); view monta o perfil da resposta.
func NewHandler(svc *Service, secure bool, view func(context.Context, user.User) user.View) *Handler {
	return &Handler{svc: svc, secure: secure, view: view}
}

// Middleware exige sessão válida (cookie ou Authorization: Bearer) e coloca usuário e token no contexto.
func (h *Handler) Middleware(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		tok := ""
		if a := ctx.Header("Authorization"); strings.HasPrefix(a, "Bearer ") {
			tok = strings.TrimPrefix(a, "Bearer ")
		} else if c, err := huma.ReadCookie(ctx, CookieName); err == nil {
			tok = c.Value
		}
		uid, err := h.svc.Authenticate(ctx.Context(), tok)
		if err != nil {
			if errors.Is(err, ErrUnauthorized) {
				_ = huma.WriteErr(api, ctx, http.StatusUnauthorized, "autenticação necessária")
			} else {
				_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, "erro interno")
			}
			return
		}
		next(huma.WithValue(huma.WithValue(ctx, userIDKey, uid), tokenKey, tok))
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
	}
}

type LoginInput struct {
	ClientHeaders
	Body struct {
		Email    string `json:"email" format:"email" maxLength:"254"`
		Password string `json:"password" minLength:"1" maxLength:"128"`
	}
}

type LogoutOutput struct {
	SetCookie http.Cookie `header:"Set-Cookie"`
}

func (h *Handler) cookie(value string, maxAge int) http.Cookie {
	return http.Cookie{
		Name: CookieName, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: h.secure, SameSite: http.SameSiteLaxMode,
	}
}

func (h *Handler) session(ctx context.Context, in ClientHeaders, u user.User, tok string) *SessionOutput {
	out := &SessionOutput{SetCookie: h.cookie(tok, int(SessionTTL.Seconds())), Body: SessionBody{User: h.view(ctx, u)}}
	if in.Client == desktopValue {
		out.Body.Token = tok
	}
	return out
}

func (h *Handler) Register(api huma.API, authed huma.Middlewares) {
	huma.Register(api, huma.Operation{
		OperationID: "register", Method: http.MethodPost, Path: "/api/auth/register",
		Summary: "Cadastro (já abre a sessão)", Tags: []string{"auth"}, DefaultStatus: http.StatusCreated,
		Errors: []int{http.StatusConflict},
	}, func(ctx context.Context, in *RegisterInput) (*SessionOutput, error) {
		ua := optional(in.UserAgent)
		u, tok, err := h.svc.Register(ctx, in.Body.Email, in.Body.Username, in.Body.Password, ua)
		switch {
		case errors.Is(err, user.ErrEmailTaken):
			return nil, huma.Error409Conflict("e-mail já cadastrado")
		case errors.Is(err, user.ErrUsernameTaken):
			return nil, huma.Error409Conflict("nome de usuário já em uso")
		case err != nil:
			return nil, err
		}
		return h.session(ctx, in.ClientHeaders, u, tok), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "login", Method: http.MethodPost, Path: "/api/auth/login",
		Summary: "Login", Tags: []string{"auth"}, Errors: []int{http.StatusUnauthorized},
	}, func(ctx context.Context, in *LoginInput) (*SessionOutput, error) {
		u, tok, err := h.svc.Login(ctx, in.Body.Email, in.Body.Password, optional(in.UserAgent))
		if errors.Is(err, ErrUnauthorized) {
			return nil, huma.Error401Unauthorized("e-mail ou senha incorretos")
		}
		if err != nil {
			return nil, err
		}
		return h.session(ctx, in.ClientHeaders, u, tok), nil
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
