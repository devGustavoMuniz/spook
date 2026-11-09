package billing

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// WebhookPath é a rota que o Mercado Pago chama (sem sessão: a assinatura autentica). Só é registrada com o
// pagamento ligado.
const WebhookPath = "/api/billing/webhook"

// MaxWebhookBody limita o corpo do webhook (as notificações têm poucas centenas de bytes).
const MaxWebhookBody = 16 << 10

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

// NewHandler recebe userID para ler o usuário autenticado do contexto, sem importar o pacote auth.
func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

// CheckoutBody é o corpo de POST /api/billing/checkout.
type CheckoutBody struct {
	Tier string `json:"tier" enum:"nitro,nitro_plus" doc:"Plano a assinar (30 dias)"`
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	huma.Register(api, huma.Operation{
		OperationID: "getBillingConfig", Method: http.MethodGet, Path: "/api/billing/config", Tags: []string{"billing"},
		Summary: "Pagamento do Nitro: se está ligado, moeda e preços (público; desligado devolve enabled=false)",
	}, func(context.Context, *struct{}) (*struct{ Body ConfigPayload }, error) {
		return &struct{ Body ConfigPayload }{Body: h.svc.Config()}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "createBillingCheckout", Method: http.MethodPost, Path: "/api/billing/checkout", Tags: []string{"billing"},
		Summary:  "Abre o Checkout Pro do Mercado Pago para 30 dias de Nitro ou Nitro+ e devolve a URL (503 se o pagamento está desligado). Limite: 10 por hora por usuário",
		Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusUnprocessableEntity, http.StatusTooManyRequests, http.StatusServiceUnavailable},
	}, func(ctx context.Context, in *struct{ Body CheckoutBody }) (*struct{ Body CheckoutPayload }, error) {
		out, err := h.svc.Checkout(ctx, h.userID(ctx), plan.Tier(in.Body.Tier))
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &struct{ Body CheckoutPayload }{Body: out}, nil
	})
}

// WebhookHandler é o POST do Mercado Pago (fora do OpenAPI).
func (h *Handler) WebhookHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxWebhookBody))
		if err != nil {
			http.Error(w, "corpo inválido ou grande demais", http.StatusRequestEntityTooLarge)
			return
		}
		q := r.URL.Query()
		typ := q.Get("type")
		if typ == "" {
			typ = q.Get("topic")
		}
		if typ == "" { // só o tipo vem do corpo; o ID que vale é o da query, coberto pela assinatura
			var b struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(body, &b)
			typ = b.Type
		}
		err = h.svc.HandleNotification(r.Context(), Notification{
			Signature: r.Header.Get("x-signature"), RequestID: r.Header.Get("x-request-id"), DataID: q.Get("data.id"), Type: typ,
		})
		switch {
		case err == nil:
			w.WriteHeader(http.StatusOK)
		case errors.Is(err, ErrInvalidSignature):
			http.Error(w, "assinatura inválida", http.StatusUnauthorized)
		case errors.Is(err, ErrDisabled):
			http.Error(w, ErrDisabled.Msg, http.StatusServiceUnavailable)
		default:
			slog.ErrorContext(r.Context(), "pagamento: webhook falhou", "err", err) // 5xx: o Mercado Pago reenvia
			http.Error(w, "erro interno", http.StatusInternalServerError)
		}
	})
}
