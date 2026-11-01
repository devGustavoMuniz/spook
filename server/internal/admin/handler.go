package admin

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

// NewHandler recebe userID para ler o usuário autenticado do contexto, sem importar o pacote auth.
func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

type ListInput struct {
	Q     string `query:"q" maxLength:"100" doc:"Busca por texto (parte do nome/username/e-mail)"`
	Sort  string `query:"sort" doc:"Coluna de ordenação (padrão created_at)"`
	Order string `query:"order" enum:"asc,desc" default:"desc"`
	Page  int    `query:"page" minimum:"1" default:"1"`
}

func (in ListInput) query() ListQuery {
	return ListQuery{Q: in.Q, Sort: in.Sort, Desc: in.Order != "asc", Page: in.Page}
}

type UsersBody struct {
	Items    []UserRow `json:"items"`
	Total    int64     `json:"total" doc:"Total de linhas que casam com a busca"`
	Page     int       `json:"page"`
	PageSize int       `json:"page_size"`
	Sort     string    `json:"sort"`
	Order    string    `json:"order"`
	Q        string    `json:"q"`
}

type ServersBody struct {
	Items    []ServerRow `json:"items"`
	Total    int64       `json:"total" doc:"Total de linhas que casam com a busca"`
	Page     int         `json:"page"`
	PageSize int         `json:"page_size"`
	Sort     string      `json:"sort"`
	Order    string      `json:"order"`
	Q        string      `json:"q"`
}

func order(q ListQuery) string {
	if q.Desc {
		return "desc"
	}
	return "asc"
}

type OverviewOutput struct{ Body Overview }
type LiveOutput struct{ Body Live }
type SystemOutput struct{ Body System }
type CallsOutput struct{ Body Calls }
type UsersOutput struct{ Body UsersBody }
type ServersOutput struct{ Body ServersBody }

// requireAdmin barra quem não é administrador. Vem depois do middleware de sessão (401): aqui o usuário
// já está autenticado. A mensagem é genérica, sem revelar nada do painel.
func (h *Handler) requireAdmin(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		ok, err := h.svc.IsAdmin(ctx.Context(), h.userID(ctx.Context()))
		switch {
		case err != nil:
			_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, "erro interno")
		case !ok:
			_ = huma.WriteErr(api, ctx, http.StatusForbidden, "acesso restrito a administradores")
		default:
			next(ctx)
		}
	}
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	guard := append(huma.Middlewares{}, mw...)
	guard = append(guard, h.requireAdmin(api))
	op := func(id, path, summary string) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: http.MethodGet, Path: path, Summary: summary,
			Tags: []string{"admin"}, Security: security, Middlewares: guard,
			Errors: []int{http.StatusUnauthorized, http.StatusForbidden},
		}
	}

	huma.Register(api, op("adminOverview", "/api/admin/overview", "Contagens, séries de 14 dias e comparações (cache de 30 s)"),
		func(ctx context.Context, _ *struct{}) (*OverviewOutput, error) {
			o, err := h.svc.Overview(ctx)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &OverviewOutput{Body: o}, nil
		})
	huma.Register(api, op("adminLive", "/api/admin/live", "Chamadas ao vivo e uso do LiveKit (cache de 5 s)"),
		func(ctx context.Context, _ *struct{}) (*LiveOutput, error) {
			l, err := h.svc.Live(ctx)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &LiveOutput{Body: l}, nil
		})
	huma.Register(api, op("adminSystem", "/api/admin/system", "Aplicação, banco, armazenamento, fila de jobs e gateway (cache de 5 s)"),
		func(ctx context.Context, _ *struct{}) (*SystemOutput, error) {
			s, err := h.svc.System(ctx)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &SystemOutput{Body: s}, nil
		})

	usersOp := op("adminUsers", "/api/admin/users", "Usuários, paginado (25 por página), com busca e ordenação")
	usersOp.Errors = append(usersOp.Errors, http.StatusUnprocessableEntity)
	huma.Register(api, usersOp, func(ctx context.Context, in *ListInput) (*UsersOutput, error) {
		p, q, err := h.svc.Users(ctx, in.query())
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &UsersOutput{Body: UsersBody{Items: p.Items, Total: p.Total, Page: q.Page, PageSize: q.PageSize, Sort: q.Sort, Order: order(q), Q: q.Q}}, nil
	})
	serversOp := op("adminServers", "/api/admin/servers", "Servidores, paginado (25 por página), com busca e ordenação")
	serversOp.Errors = append(serversOp.Errors, http.StatusUnprocessableEntity)
	huma.Register(api, serversOp, func(ctx context.Context, in *ListInput) (*ServersOutput, error) {
		p, q, err := h.svc.Servers(ctx, in.query())
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &ServersOutput{Body: ServersBody{Items: p.Items, Total: p.Total, Page: q.Page, PageSize: q.PageSize, Sort: q.Sort, Order: order(q), Q: q.Q}}, nil
	})
	huma.Register(api, op("adminCalls", "/api/admin/calls", "Salas de voz ativas lidas do LiveKit (cache de 5 s)"),
		func(ctx context.Context, in *struct {
			Q string `query:"q" maxLength:"100" doc:"Filtra por servidor, canal ou pessoa"`
		}) (*CallsOutput, error) {
			c, err := h.svc.Calls(ctx, in.Q)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &CallsOutput{Body: c}, nil
		})
}
