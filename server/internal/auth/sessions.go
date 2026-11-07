package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// SessionView é uma sessão ativa na lista de Configurações → Segurança. O IP não é guardado nem exibido; o
// dispositivo é aproximado pelo User-Agent (navegador e sistema).
type SessionView struct {
	ID         string    `json:"id" doc:"ID Snowflake (string)"`
	Browser    string    `json:"browser,omitempty" doc:"Navegador aproximado pelo User-Agent (vazio = desconhecido)"`
	OS         string    `json:"os,omitempty" doc:"Sistema aproximado pelo User-Agent (vazio = desconhecido)"`
	Remember   bool      `json:"remember" doc:"Sessão longa (\"Manter conectado\")"`
	Current    bool      `json:"current" doc:"É a sessão que fez esta chamada"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at" doc:"Último uso; atualizado no máximo 1 vez por hora"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type SessionsOutput struct {
	Body struct {
		Sessions []SessionView `json:"sessions"`
	}
}

type RevokeSessionInput struct {
	ID string `path:"id" doc:"ID da sessão"`
}

type RevokeOthersOutput struct {
	Body struct {
		Revoked int64 `json:"revoked" doc:"Quantas sessões foram encerradas"`
	}
}

func (h *Handler) registerSessions(api huma.API, authed, sensitive huma.Middlewares) {
	huma.Register(api, huma.Operation{
		OperationID: "listSessions", Method: http.MethodGet, Path: "/api/users/me/sessions",
		Summary: "Sessões ativas da conta (dispositivo aproximado, criada em, último uso)",
		Description: "Só sessões não expiradas, da mais recente para a mais antiga em uso. `current` marca a sessão que fez a chamada. " +
			"O IP não é guardado.",
		Tags: []string{"users"}, Security: Security, Middlewares: authed, Errors: []int{http.StatusUnauthorized},
	}, func(ctx context.Context, _ *struct{}) (*SessionsOutput, error) {
		rows, cur, err := h.svc.ListSessions(ctx, UserID(ctx), token(ctx))
		if err != nil {
			return nil, err
		}
		out := &SessionsOutput{}
		out.Body.Sessions = make([]SessionView, len(rows))
		for i, r := range rows {
			ua := ""
			if r.UserAgent != nil {
				ua = *r.UserAgent
			}
			b, o := SummarizeUserAgent(ua)
			out.Body.Sessions[i] = SessionView{ID: httpx.ID(r.ID), Browser: b, OS: o, Remember: r.Remember, Current: cur[i],
				CreatedAt: r.CreatedAt, LastSeenAt: r.LastSeen, ExpiresAt: r.Expires}
		}
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "revokeSession", Method: http.MethodDelete, Path: "/api/users/me/sessions/{id}",
		Summary: "Encerra uma sessão (exige a senha confirmada há pouco)",
		Description: "Derruba também as conexões do gateway dessa sessão. A sessão atual não pode ser encerrada aqui (use o logout): 422. " +
			"Sem confirmação recente: 403 `password_confirmation_required`.",
		Tags: []string{"users"}, Security: Security, Middlewares: sensitive, DefaultStatus: http.StatusNoContent,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusUnprocessableEntity, http.StatusTooManyRequests},
	}, func(ctx context.Context, in *RevokeSessionInput) (*struct{}, error) {
		uid := UserID(ctx)
		if err := httpx.Take(h.limiter, "sessions:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		id, ok := httpx.ParseID(in.ID)
		if !ok {
			return nil, httpx.BadID("sessão")
		}
		rows, cur, err := h.svc.ListSessions(ctx, uid, token(ctx))
		if err != nil {
			return nil, err
		}
		for i, r := range rows {
			if r.ID == id && cur[i] {
				return nil, huma.Error422UnprocessableEntity("esta é a sessão atual; use \"Sair\"")
			}
		}
		if err := h.svc.RevokeSession(ctx, uid, id); err != nil {
			if errors.Is(err, ErrSessionNotFound) {
				return nil, httpx.BadID("sessão")
			}
			return nil, err
		}
		return nil, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "revokeOtherSessions", Method: http.MethodPost, Path: "/api/users/me/sessions/revoke-others",
		Summary: "Encerra todas as outras sessões, mantendo a atual (exige a senha confirmada há pouco)",
		Description: "Derruba também as conexões do gateway das sessões encerradas. " +
			"Sem confirmação recente: 403 `password_confirmation_required`.",
		Tags: []string{"users"}, Security: Security, Middlewares: sensitive,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests},
	}, func(ctx context.Context, _ *struct{}) (*RevokeOthersOutput, error) {
		uid := UserID(ctx)
		if err := httpx.Take(h.limiter, "sessions:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		n, err := h.svc.RevokeOthers(ctx, uid, token(ctx))
		if err != nil {
			return nil, err
		}
		out := &RevokeOthersOutput{}
		out.Body.Revoked = n
		return out, nil
	})
}

// SummarizeUserAgent aproxima navegador e sistema a partir do User-Agent (vazio = desconhecido). É só um
// rótulo para a pessoa reconhecer o dispositivo: nada aqui decide segurança.
func SummarizeUserAgent(ua string) (browser, os string) {
	l := strings.ToLower(ua)
	switch {
	case strings.Contains(l, "edg/") || strings.Contains(l, "edga/") || strings.Contains(l, "edgios/"):
		browser = "Edge"
	case strings.Contains(l, "opr/") || strings.Contains(l, "opera"):
		browser = "Opera"
	case strings.Contains(l, "firefox/") || strings.Contains(l, "fxios/"):
		browser = "Firefox"
	case strings.Contains(l, "chrome/") || strings.Contains(l, "crios/"):
		browser = "Chrome"
	case strings.Contains(l, "safari/"):
		browser = "Safari"
	}
	switch {
	case strings.Contains(l, "android"):
		os = "Android"
	case strings.Contains(l, "iphone") || strings.Contains(l, "ipad") || strings.Contains(l, "ipod"):
		os = "iOS"
	case strings.Contains(l, "windows"):
		os = "Windows"
	case strings.Contains(l, "mac os x") || strings.Contains(l, "macintosh"):
		os = "macOS"
	case strings.Contains(l, "cros"):
		os = "ChromeOS"
	case strings.Contains(l, "linux") || strings.Contains(l, "x11"):
		os = "Linux"
	}
	return browser, os
}
