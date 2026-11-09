package entitlement

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

type Handler struct {
	svc       *Service
	userID    func(context.Context) int64
	ipLimiter *ratelimit.Limiter // resgates por IP (além do limite por usuário, que é um middleware por ação)
}

// NewHandler recebe userID para ler o usuário autenticado do contexto, sem importar o pacote auth.
func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

// WithIPLimiter define o limitador de resgates por IP.
func (h *Handler) WithIPLimiter(l *ratelimit.Limiter) *Handler { h.ipLimiter = l; return h }

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

// RedeemBody é o corpo de POST /api/me/plan/redeem.
type RedeemBody struct {
	Code string `json:"code" minLength:"1" maxLength:"64" doc:"Código de resgate (SPOOK-XXXX-XXXX-XXXX-XXXX); hífens, espaços e caixa não importam"`
}

// GrantBody é o corpo de POST /api/admin/users/{id}/entitlement.
type GrantBody struct {
	Tier string `json:"tier" enum:"nitro,nitro_plus" doc:"Plano a conceder"`
	Days *int   `json:"days,omitempty" minimum:"1" maximum:"3650" doc:"Dias de plano; omitido ou nulo = permanente. Soma-se à validade vigente do mesmo plano (ou de um maior)"`
}

// CreateCodesBody é o corpo de POST /api/admin/redeem-codes.
type CreateCodesBody struct {
	Tier          string `json:"tier" enum:"nitro,nitro_plus" doc:"Plano que o código dá"`
	Days          *int   `json:"days,omitempty" minimum:"1" maximum:"3650" doc:"Dias de plano que o código dá; omitido ou nulo = permanente"`
	Quantity      int    `json:"quantity" minimum:"1" maximum:"100" default:"1" doc:"Quantos códigos gerar"`
	ExpiresInDays *int   `json:"expires_in_days,omitempty" minimum:"1" maximum:"365" doc:"Prazo para resgatar o código; omitido = não vence"`
}

type userPath struct {
	ID string `path:"id" doc:"ID do usuário"`
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, method, path, summary string, status int, errs ...int) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
			Tags: []string{"plan"}, Security: security, Middlewares: mw,
			Errors: append([]int{http.StatusUnauthorized}, errs...),
		}
	}
	notFound, invalid, conflict, gone, tooMany := http.StatusNotFound, http.StatusUnprocessableEntity, http.StatusConflict, http.StatusGone, http.StatusTooManyRequests

	huma.Register(api, op("getMyPlan", http.MethodGet, "/api/me/plan",
		"Meu plano (Grátis, Nitro ou Nitro+) com validade, origem e limites", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body PlanPayload }, error) {
			p, err := h.svc.Current(ctx, h.userID(ctx))
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body PlanPayload }{Body: p}, nil
		})

	huma.Register(api, op("redeemPlanCode", http.MethodPost, "/api/me/plan/redeem",
		"Resgata um código de Nitro: soma os dias à validade vigente do mesmo plano (ou de um maior) e devolve o plano. Limite: 5 por minuto por usuário e 20 por hora por IP",
		0, notFound, conflict, gone, invalid, tooMany),
		func(ctx context.Context, in *struct{ Body RedeemBody }) (*struct{ Body PlanPayload }, error) {
			if err := httpx.Take(h.ipLimiter, "ip:"+httpx.ClientIP(ctx)); err != nil {
				return nil, err
			}
			p, err := h.svc.Redeem(ctx, h.userID(ctx), in.Body.Code)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body PlanPayload }{Body: p}, nil
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

	huma.Register(api, aop("adminListEntitlements", http.MethodGet, "/api/admin/entitlements",
		"Concessões de plano (ativas por padrão) com busca por username/nome, filtro por plano e página", 0, invalid),
		func(ctx context.Context, in *struct {
			State string `query:"state" enum:"active,inactive,all" default:"active" doc:"active = não revogadas e não vencidas; inactive = revogadas ou vencidas"`
			Tier  string `query:"tier" enum:"nitro,nitro_plus" doc:"Filtra por plano"`
			Q     string `query:"q" maxLength:"100" doc:"Busca no username ou no nome de exibição"`
			Page  int    `query:"page" minimum:"1" default:"1"`
		}) (*struct{ Body GrantsPage }, error) {
			p, err := h.svc.ListGrants(ctx, GrantFilter{State: in.State, Tier: in.Tier, Q: in.Q, Page: in.Page})
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body GrantsPage }{Body: p}, nil
		})

	huma.Register(api, aop("adminGrantEntitlement", http.MethodPost, "/api/admin/users/{id}/entitlement",
		"Concede Nitro ou Nitro+ a um usuário por um prazo em dias (ou permanente). Avisa a pessoa em tempo real", http.StatusCreated, notFound, invalid),
		func(ctx context.Context, in *struct {
			ID   string `path:"id" doc:"ID do usuário"`
			Body GrantBody
		}) (*struct{ Body GrantPayload }, error) {
			uid, ok := httpx.ParseID(in.ID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			g, err := h.svc.Grant(ctx, h.userID(ctx), uid, plan.Tier(in.Body.Tier), in.Body.Days)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body GrantPayload }{Body: g}, nil
		})

	huma.Register(api, aop("adminRevokeEntitlement", http.MethodDelete, "/api/admin/users/{id}/entitlement",
		"Revoga todas as concessões ativas do usuário (volta ao plano Grátis). 404 se não havia plano ativo", 0, notFound),
		func(ctx context.Context, in *userPath) (*struct{ Body RevokeResult }, error) {
			uid, ok := httpx.ParseID(in.ID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			r, err := h.svc.Revoke(ctx, h.userID(ctx), uid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body RevokeResult }{Body: r}, nil
		})

	huma.Register(api, aop("adminRevokeEntitlementGrant", http.MethodDelete, "/api/admin/entitlements/{id}",
		"Revoga uma concessão específica (a pessoa pode continuar com outra)", 0, notFound),
		func(ctx context.Context, in *struct {
			ID string `path:"id" doc:"ID da concessão"`
		}) (*struct{ Body RevokeResult }, error) {
			id, ok := httpx.ParseID(in.ID)
			if !ok {
				return nil, httpx.Err(ErrGrantNotFound)
			}
			r, err := h.svc.RevokeGrant(ctx, h.userID(ctx), id)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body RevokeResult }{Body: r}, nil
		})

	huma.Register(api, aop("adminCreateRedeemCodes", http.MethodPost, "/api/admin/redeem-codes",
		"Gera códigos de resgate. O texto de cada código aparece só nesta resposta: o servidor guarda apenas o hash", http.StatusCreated, invalid),
		func(ctx context.Context, in *struct{ Body CreateCodesBody }) (*struct {
			CacheControl string `header:"Cache-Control"`
			Body         NewCodesPayload
		}, error) {
			b := in.Body
			out, err := h.svc.CreateCodes(ctx, h.userID(ctx), plan.Tier(b.Tier), b.Days, b.Quantity, b.ExpiresInDays)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct {
				CacheControl string `header:"Cache-Control"`
				Body         NewCodesPayload
			}{CacheControl: "no-store", Body: out}, nil
		})

	huma.Register(api, aop("adminListRedeemCodes", http.MethodGet, "/api/admin/redeem-codes",
		"Códigos de resgate (não usados por padrão), sem o texto: só os 4 últimos caracteres", 0, invalid),
		func(ctx context.Context, in *struct {
			State string `query:"state" enum:"unused,used,expired,all" default:"unused"`
			Tier  string `query:"tier" enum:"nitro,nitro_plus" doc:"Filtra por plano"`
			Page  int    `query:"page" minimum:"1" default:"1"`
		}) (*struct{ Body CodesPage }, error) {
			p, err := h.svc.ListCodes(ctx, CodeFilter{State: in.State, Tier: in.Tier, Page: in.Page})
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body CodesPage }{Body: p}, nil
		})
}
