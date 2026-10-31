package presence

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// Handler expõe a preferência de status e o status personalizado do próprio usuário.
type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

// PresenceUpdateBody é o corpo do PATCH: o que for omitido não muda.
type PresenceUpdateBody struct {
	StatusPref        *string       `json:"status_pref,omitempty" enum:"online,dnd,invisible" doc:"online (ausente é automático), dnd (Não perturbar) ou invisible"`
	CustomStatus      *CustomStatus `json:"custom_status,omitempty" doc:"Define o status personalizado (texto e/ou emoji; expires_at opcional, futuro e em até 48 h)"`
	ClearCustomStatus bool          `json:"clear_custom_status,omitempty" doc:"Remove o status personalizado"`
}

type SelfOutput struct{ Body SelfPayload }

// Register registra as rotas autenticadas.
func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	huma.Register(api, huma.Operation{
		OperationID: "getMyPresence", Method: http.MethodGet, Path: "/api/users/@me/presence",
		Summary:     "Preferência de status e status personalizado do usuário",
		Description: "Status personalizado vencido já vem ausente (a expiração é avaliada no servidor).",
		Tags:        []string{"presence"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized},
	}, func(ctx context.Context, _ *struct{}) (*SelfOutput, error) {
		p, err := h.svc.Self(ctx, h.userID(ctx))
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &SelfOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateMyPresence", Method: http.MethodPatch, Path: "/api/users/@me/presence",
		Summary: "Muda o status (online, não perturbar, invisível) e/ou o status personalizado",
		Description: "Invisível aparece como offline para os outros; Não perturbar aparece como dnd e suprime push e avisos. Publica " +
			"PRESENCE_UPDATE para quem vê o usuário e PRESENCE_SELF_UPDATE nas sessões dele.",
		Tags: []string{"presence"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusUnprocessableEntity},
	}, func(ctx context.Context, in *struct{ Body PresenceUpdateBody }) (*SelfOutput, error) {
		p, err := h.svc.Update(ctx, h.userID(ctx), Update{
			StatusPref: in.Body.StatusPref, Custom: in.Body.CustomStatus, ClearCustom: in.Body.ClearCustomStatus,
		})
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &SelfOutput{Body: p}, nil
	})
}
