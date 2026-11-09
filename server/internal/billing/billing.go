// Package billing implementa o pagamento do Nitro e do Nitro+ pelo Mercado Pago (Checkout Pro, pagamento único =
// 30 dias; adicional fora do SPEC). Segue handler → service → store.
//
// Sem MERCADOPAGO_ACCESS_TOKEN o pacote fica desligado: GET /api/billing/config devolve {enabled:false}, o checkout
// responde 503 e a rota do webhook nem é registrada. Regras que não podem vazar: o corpo do webhook nunca é
// confiável (só serve para achar o ID do pagamento: o service busca o pagamento na API do Mercado Pago e confere
// status, pedido, valor e moeda); a assinatura x-signature é obrigatória; o Access Token nunca é logado.
package billing

import (
	"context"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// Dias de plano de um pagamento único e moeda.
const (
	PlanDays = 30
	Currency = "BRL"
)

var (
	ErrDisabled         = apperr.Unavailable("pagamentos indisponíveis no momento")
	ErrInvalidTier      = apperr.Invalid("plano inválido: use nitro ou nitro_plus")
	ErrOrderNotFound    = apperr.NotFound("pedido não encontrado")
	ErrInvalidSignature = apperr.Forbidden("assinatura inválida")
	ErrPaymentNotFound  = apperr.NotFound("pagamento não encontrado no Mercado Pago")
	ErrGateway          = apperr.Unavailable("não foi possível falar com o Mercado Pago; tente de novo")
)

// Order é o pedido criado no checkout (valor e moeda congelados).
type Order struct {
	ID          int64
	UserID      int64
	Tier        plan.Tier
	AmountCents int
	Currency    string
	Days        int
	Status      string // pending | paid | refunded
}

// Config é a configuração do serviço (derivada do config.Billing e do PublicURL).
type Config struct {
	Enabled        bool
	PublicURL      string
	WebhookSecret  string
	NitroCents     int
	NitroPlusCents int
}

func (c Config) price(t plan.Tier) int {
	if t == plan.NitroPlus {
		return c.NitroPlusCents
	}
	return c.NitroCents
}

// Preference é o que o service pede ao Mercado Pago ao abrir um checkout.
type Preference struct {
	ExternalReference string
	Title             string
	AmountCents       int
	NotificationURL   string
	SuccessURL        string
	FailureURL        string
	PendingURL        string
	AutoReturn        bool
	IdempotencyKey    string
}

// PreferenceResult é a preferência criada.
type PreferenceResult struct{ ID, InitPoint string }

// MPPayment é o pagamento como o Mercado Pago o devolve (a fonte da verdade).
type MPPayment struct {
	ID                int64
	Status            string
	StatusDetail      string
	ExternalReference string
	Amount            float64
	Currency          string
}

// Gateway é o que o service precisa do Mercado Pago (definida aqui, por quem consome).
type Gateway interface {
	CreatePreference(ctx context.Context, p Preference) (PreferenceResult, error)
	GetPayment(ctx context.Context, id int64) (MPPayment, error) // ErrPaymentNotFound
}

// Entitlements é o que o service precisa do serviço de planos.
type Entitlements interface {
	GrantPayment(ctx context.Context, userID int64, tier plan.Tier, days int) (int64, error)
	RevokePayment(ctx context.Context, grantID int64) error
}

// IDGenerator gera IDs Snowflake.
type IDGenerator interface{ Next() int64 }

// Store é o que o service precisa do banco.
type Store interface {
	CreateOrder(ctx context.Context, o Order) error
	SetPreference(ctx context.Context, orderID int64, preferenceID string) error
	Order(ctx context.Context, id int64) (Order, error) // ErrOrderNotFound
	// Approve registra o pagamento aprovado do pedido, sob trava do pedido, e chama grant para conceder o plano;
	// tudo ou nada. Devolve false (sem chamar grant) se o pagamento já foi processado ou o pedido não está pendente.
	Approve(ctx context.Context, orderID, mpPaymentID int64, rawStatus string, now time.Time, grant func(Order) (int64, error)) (bool, error)
	// Refund marca o pagamento como estornado e chama revoke com a concessão dele (se houver). Devolve false se o
	// pagamento é desconhecido ou já estava estornado.
	Refund(ctx context.Context, mpPaymentID int64, rawStatus string, revoke func(entitlementID int64) error) (bool, error)
}

// PlanPrice é um plano à venda.
type PlanPrice struct {
	Tier       string `json:"tier" enum:"nitro,nitro_plus"`
	PriceCents int    `json:"price_cents" doc:"Preço em centavos (BRL)"`
	Days       int    `json:"days" doc:"Dias de plano de um pagamento"`
}

// ConfigPayload é GET /api/billing/config.
type ConfigPayload struct {
	Enabled  bool        `json:"enabled" doc:"Pagamento ligado neste servidor"`
	Currency string      `json:"currency"`
	Plans    []PlanPrice `json:"plans"`
}

// CheckoutPayload é a resposta do checkout.
type CheckoutPayload struct {
	InitPoint string `json:"init_point" doc:"URL do Checkout Pro do Mercado Pago para onde levar a pessoa"`
}
