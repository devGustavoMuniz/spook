package feedback

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

// requireAdmin barra quem não é administrador (depois do middleware de sessão, que dá o 401).
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

type idPath struct {
	ID string `path:"id" doc:"ID do chamado"`
}

func parseID(s string) (int64, error) {
	id, ok := httpx.ParseID(s)
	if !ok {
		return 0, httpx.BadID("chamado")
	}
	return id, nil
}

// CreateTicketBody é o corpo de POST /api/tickets.
type CreateTicketBody struct {
	Kind        string         `json:"kind" enum:"bug,suggestion,feedback" doc:"Tipo do chamado"`
	Title       string         `json:"title" minLength:"3" maxLength:"120" doc:"Resumo curto"`
	Description string         `json:"description" minLength:"1" maxLength:"4000" doc:"Descrição (vira a primeira mensagem)"`
	Context     *TicketContext `json:"context,omitempty" doc:"Contexto técnico opcional (o usuário pode desligar)"`
}

type TicketMessageBody struct {
	Body string `json:"body" minLength:"1" maxLength:"4000" doc:"Texto da mensagem"`
}

type AdminTicketMessageBody struct {
	Body     string `json:"body" minLength:"1" maxLength:"4000" doc:"Texto da mensagem"`
	Internal bool   `json:"internal,omitempty" doc:"true = nota interna, invisível para o autor"`
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, method, path, summary string, status int, errs ...int) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
			Tags: []string{"tickets"}, Security: security, Middlewares: mw,
			Errors: append([]int{http.StatusUnauthorized}, errs...),
		}
	}
	notFound, invalid, conflict, tooMany := http.StatusNotFound, http.StatusUnprocessableEntity, http.StatusConflict, http.StatusTooManyRequests

	huma.Register(api, op("createTicket", http.MethodPost, "/api/tickets",
		"Abre um chamado de feedback, sugestão ou bug. Limite: 5 por hora por usuário e 20 em andamento", http.StatusCreated, invalid, conflict, tooMany),
		func(ctx context.Context, in *struct{ Body CreateTicketBody }) (*struct{ Body TicketDetail }, error) {
			d, err := h.svc.Create(ctx, h.userID(ctx), Kind(in.Body.Kind), in.Body.Title, in.Body.Description, in.Body.Context)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body TicketDetail }{Body: d}, nil
		})

	huma.Register(api, op("listMyTickets", http.MethodGet, "/api/tickets",
		"Meus chamados, do mais recentemente movimentado para o mais antigo, com cursor", 0, invalid),
		func(ctx context.Context, in *struct {
			Status string `query:"status" enum:"open,in_review,answered,resolved,closed" doc:"Filtra por estado"`
			Cursor string `query:"cursor" maxLength:"64" doc:"next_cursor da página anterior"`
			Limit  int    `query:"limit" minimum:"1" maximum:"50" default:"20" doc:"Itens por página (máx. 50)"`
		}) (*struct{ Body TicketPage }, error) {
			p, err := h.svc.List(ctx, h.userID(ctx), in.Status, in.Cursor, in.Limit)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body TicketPage }{Body: p}, nil
		})

	huma.Register(api, op("getMyTicket", http.MethodGet, "/api/tickets/{id}",
		"Um chamado meu com a conversa (sem notas internas); abrir marca como lido", 0, notFound),
		func(ctx context.Context, in *idPath) (*struct{ Body TicketDetail }, error) {
			id, err := parseID(in.ID)
			if err != nil {
				return nil, err
			}
			d, err := h.svc.Get(ctx, h.userID(ctx), id)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body TicketDetail }{Body: d}, nil
		})

	huma.Register(api, op("replyMyTicket", http.MethodPost, "/api/tickets/{id}/messages",
		"Responde no meu chamado (chamado respondido ou resolvido volta a aberto; fechado exige reabrir)", http.StatusCreated, notFound, invalid, conflict, tooMany),
		func(ctx context.Context, in *struct {
			ID   string `path:"id" doc:"ID do chamado"`
			Body TicketMessageBody
		}) (*struct{ Body TicketMessagePayload }, error) {
			id, err := parseID(in.ID)
			if err != nil {
				return nil, err
			}
			m, err := h.svc.Reply(ctx, h.userID(ctx), id, in.Body.Body)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body TicketMessagePayload }{Body: m}, nil
		})

	huma.Register(api, op("setMyTicketStatus", http.MethodPut, "/api/tickets/{id}/status",
		"Fecha o meu chamado (closed) ou reabre um resolvido/fechado (open)", 0, notFound, invalid, conflict, tooMany),
		func(ctx context.Context, in *struct {
			ID   string `path:"id" doc:"ID do chamado"`
			Body struct {
				Status string `json:"status" enum:"open,closed" doc:"open reabre; closed fecha"`
			}
		}) (*struct{ Body TicketPayload }, error) {
			id, err := parseID(in.ID)
			if err != nil {
				return nil, err
			}
			t, err := h.svc.SetOwnStatus(ctx, h.userID(ctx), id, Status(in.Body.Status))
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body TicketPayload }{Body: t}, nil
		})

	// ---- administrador ----
	guard := append(huma.Middlewares{}, mw...)
	guard = append(guard, h.requireAdmin(api))
	aop := func(id, method, path, summary string, status int, errs ...int) huma.Operation {
		o := op(id, method, path, summary, status, http.StatusForbidden)
		o.Tags, o.Middlewares = []string{"admin"}, guard
		o.Errors = append(o.Errors, errs...)
		return o
	}

	huma.Register(api, aop("adminListTickets", http.MethodGet, "/api/admin/tickets",
		"Fila de chamados com filtros por estado e tipo, busca (título ou username), ordenação e cursor", 0, invalid),
		func(ctx context.Context, in *struct {
			Status string `query:"status" enum:"open,in_review,answered,resolved,closed" doc:"Filtra por estado"`
			Kind   string `query:"kind" enum:"bug,suggestion,feedback" doc:"Filtra por tipo"`
			Q      string `query:"q" maxLength:"100" doc:"Busca no título ou no username do autor"`
			Sort   string `query:"sort" enum:"activity,oldest" default:"activity" doc:"activity = movimento mais recente; oldest = mais antigos primeiro"`
			Cursor string `query:"cursor" maxLength:"64" doc:"next_cursor da página anterior"`
			Limit  int    `query:"limit" minimum:"1" maximum:"50" default:"20" doc:"Itens por página (máx. 50)"`
		}) (*struct{ Body AdminTicketPage }, error) {
			p, err := h.svc.AdminList(ctx, in.Status, in.Kind, in.Q, in.Sort, in.Cursor, in.Limit)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body AdminTicketPage }{Body: p}, nil
		})

	huma.Register(api, aop("adminTicketSummary", http.MethodGet, "/api/admin/tickets/summary",
		"Contagem de chamados por estado (badge do menu)", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body TicketSummary }, error) {
			s, err := h.svc.Summary(ctx)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body TicketSummary }{Body: s}, nil
		})

	huma.Register(api, aop("adminGetTicket", http.MethodGet, "/api/admin/tickets/{id}",
		"Chamado completo: conversa, notas internas, contexto técnico e dados do autor", 0, notFound),
		func(ctx context.Context, in *idPath) (*struct{ Body AdminTicketDetail }, error) {
			id, err := parseID(in.ID)
			if err != nil {
				return nil, err
			}
			d, err := h.svc.AdminGet(ctx, id)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body AdminTicketDetail }{Body: d}, nil
		})

	huma.Register(api, aop("adminReplyTicket", http.MethodPost, "/api/admin/tickets/{id}/messages",
		"Responde ao autor (internal=false: avisa o autor e move para respondido) ou registra uma nota interna", http.StatusCreated, notFound, invalid, conflict),
		func(ctx context.Context, in *struct {
			ID   string `path:"id" doc:"ID do chamado"`
			Body AdminTicketMessageBody
		}) (*struct{ Body TicketAdminMessagePayload }, error) {
			id, err := parseID(in.ID)
			if err != nil {
				return nil, err
			}
			m, err := h.svc.AdminReply(ctx, h.userID(ctx), id, in.Body.Body, in.Body.Internal)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body TicketAdminMessagePayload }{Body: m}, nil
		})

	huma.Register(api, aop("adminSetTicketStatus", http.MethodPut, "/api/admin/tickets/{id}/status",
		"Muda o estado do chamado (resolver ou fechar avisa o autor)", 0, notFound, invalid),
		func(ctx context.Context, in *struct {
			ID   string `path:"id" doc:"ID do chamado"`
			Body struct {
				Status string `json:"status" enum:"open,in_review,answered,resolved,closed"`
			}
		}) (*struct{ Body AdminTicketPayload }, error) {
			id, err := parseID(in.ID)
			if err != nil {
				return nil, err
			}
			t, err := h.svc.AdminSetStatus(ctx, h.userID(ctx), id, Status(in.Body.Status))
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body AdminTicketPayload }{Body: t}, nil
		})
}
