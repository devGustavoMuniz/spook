package account

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

type Handler struct {
	svc     *Service
	userID  func(context.Context) int64
	limiter *ratelimit.Limiter
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

// WithLimiter define o limitador por usuário da exclusão de conta.
func (h *Handler) WithLimiter(l *ratelimit.Limiter) *Handler { h.limiter = l; return h }

// DeleteInput: a própria senha é a confirmação (vale como confirmação recente).
type DeleteInput struct {
	Body struct {
		Password string `json:"password" minLength:"1" maxLength:"128"`
	}
}

// CodeOwnsGuilds é o `code` do 409 devolvido a quem ainda é dono de servidores.
const CodeOwnsGuilds = "owns_guilds"

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	huma.Register(api, huma.Operation{
		OperationID: "deleteMe", Method: http.MethodDelete, Path: "/api/users/me",
		Summary: "Exclui a própria conta (exige a senha no corpo)",
		Description: "Recusa quem é dono de servidor (409 com `code: owns_guilds` e a lista em `guilds`: transfira ou exclua antes). " +
			"As mensagens permanecem com o autor anonimizado (`removido_<id>`); membros, sessões, push e configurações são apagados " +
			"e o avatar/banner saem do storage por job. Limite: 3 tentativas e depois 1 por minuto por usuário.",
		Tags: []string{"users"}, Security: security, Middlewares: mw, DefaultStatus: http.StatusNoContent,
		Errors: []int{http.StatusUnauthorized, http.StatusConflict, http.StatusUnprocessableEntity, http.StatusTooManyRequests},
	}, func(ctx context.Context, in *DeleteInput) (*struct{}, error) {
		uid := h.userID(ctx)
		if err := httpx.Take(h.limiter, "delete:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		err := h.svc.Delete(ctx, uid, in.Body.Password)
		var owns *OwnsGuildsError
		switch {
		case errors.Is(err, ErrWrongPassword):
			return nil, huma.Error422UnprocessableEntity("senha incorreta")
		case errors.As(err, &owns):
			guilds := make([]map[string]string, len(owns.Guilds))
			for i, g := range owns.Guilds {
				guilds[i] = map[string]string{"id": httpx.ID(g.ID), "name": g.Name}
			}
			return nil, &httpx.ProblemError{
				Status: http.StatusConflict, Code: CodeOwnsGuilds,
				Detail: "você é dono de servidores: transfira a propriedade ou exclua-os antes de excluir a conta",
				Extra:  map[string]any{"guilds": guilds},
			}
		case errors.Is(err, errAlreadyDeleted):
			return nil, huma.Error404NotFound("conta não encontrada")
		case err != nil:
			return nil, err
		}
		return nil, nil
	})
}
