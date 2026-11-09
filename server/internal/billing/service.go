package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// Service reúne a abertura do checkout e o processamento das notificações do Mercado Pago.
type Service struct {
	cfg   Config
	store Store
	gw    Gateway
	plans Entitlements
	ids   IDGenerator
	now   func() time.Time

	tracer trace.Tracer
	events metric.Int64Counter
}

func NewService(cfg Config, store Store, gw Gateway, plans Entitlements, ids IDGenerator) *Service {
	s := &Service{cfg: cfg, store: store, gw: gw, plans: plans, ids: ids, now: time.Now, tracer: otel.Tracer("spook/billing")}
	s.events, _ = otel.Meter("spook/billing").Int64Counter("spook.billing.events",
		metric.WithDescription("Eventos de pagamento por tipo (checkout, webhook) e resultado (created, granted, duplicate, ignored, mismatch, refunded, invalid_signature, error)"))
	return s
}

// Enabled diz se o pagamento está ligado.
func (s *Service) Enabled() bool { return s.cfg.Enabled }

func (s *Service) count(ctx context.Context, kind, result string) {
	s.events.Add(ctx, 1, metric.WithAttributes(attribute.String("kind", kind), attribute.String("result", result)))
}

// Config é GET /api/billing/config. Desligado, não revela preços.
func (s *Service) Config() ConfigPayload {
	if !s.cfg.Enabled {
		return ConfigPayload{Enabled: false, Currency: Currency, Plans: []PlanPrice{}}
	}
	return ConfigPayload{Enabled: true, Currency: Currency, Plans: []PlanPrice{
		{Tier: string(plan.Nitro), PriceCents: s.cfg.NitroCents, Days: PlanDays},
		{Tier: string(plan.NitroPlus), PriceCents: s.cfg.NitroPlusCents, Days: PlanDays},
	}}
}

func tierTitle(t plan.Tier) string {
	if t == plan.NitroPlus {
		return "Spook Nitro+ (30 dias)"
	}
	return "Spook Nitro (30 dias)"
}

// Checkout cria o pedido e a preferência do Checkout Pro e devolve a URL para pagar.
func (s *Service) Checkout(ctx context.Context, userID int64, tier plan.Tier) (CheckoutPayload, error) {
	if !s.cfg.Enabled {
		return CheckoutPayload{}, ErrDisabled
	}
	if !tier.Paid() {
		return CheckoutPayload{}, ErrInvalidTier
	}
	ctx, span := s.tracer.Start(ctx, "billing.checkout", trace.WithAttributes(attribute.String("tier", string(tier))))
	defer span.End()
	o := Order{ID: s.ids.Next(), UserID: userID, Tier: tier, AmountCents: s.cfg.price(tier), Currency: Currency, Days: PlanDays, Status: "pending"}
	if err := s.store.CreateOrder(ctx, o); err != nil {
		return CheckoutPayload{}, err
	}
	back := s.cfg.PublicURL + "/settings/nitro?payment="
	res, err := s.gw.CreatePreference(ctx, Preference{
		ExternalReference: httpx.ID(o.ID), Title: tierTitle(tier), AmountCents: o.AmountCents,
		NotificationURL: s.cfg.PublicURL + WebhookPath,
		SuccessURL:      back + "success", FailureURL: back + "failure", PendingURL: back + "pending",
		AutoReturn:     strings.HasPrefix(s.cfg.PublicURL, "https://"), // o Mercado Pago recusa auto_return com URL não https
		IdempotencyKey: "spook-order-" + httpx.ID(o.ID),
	})
	if err != nil {
		s.count(ctx, "checkout", "error")
		slog.ErrorContext(ctx, "pagamento: não foi possível criar a preferência", "order_id", o.ID, "err", err)
		return CheckoutPayload{}, ErrGateway
	}
	if err := s.store.SetPreference(ctx, o.ID, res.ID); err != nil {
		slog.WarnContext(ctx, "pagamento: não foi possível gravar a preferência", "order_id", o.ID, "err", err)
	}
	s.count(ctx, "checkout", "created")
	slog.InfoContext(ctx, "pagamento: checkout criado", "user", userID, "order_id", o.ID, "tier", string(tier))
	return CheckoutPayload{InitPoint: res.InitPoint}, nil
}

// Notification é o que a rota do webhook entrega ao service.
type Notification struct {
	Signature string // cabeçalho x-signature
	RequestID string // cabeçalho x-request-id
	DataID    string // query data.id (o que a assinatura cobre)
	Type      string // query type (ou o tipo do corpo)
}

// VerifySignature confere o x-signature: HMAC-SHA256 (hex) do manifest "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
// com a chave secreta do webhook. O data.id entra em minúsculas; partes ausentes saem do manifest.
func VerifySignature(secret string, n Notification) bool {
	if secret == "" || n.Signature == "" {
		return false
	}
	var ts, v1 string
	for _, part := range strings.Split(n.Signature, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "ts":
			ts = strings.TrimSpace(v)
		case "v1":
			v1 = strings.TrimSpace(v)
		}
	}
	got, err := hex.DecodeString(v1)
	if err != nil || ts == "" || len(got) == 0 {
		return false
	}
	var manifest strings.Builder
	if n.DataID != "" {
		manifest.WriteString("id:" + strings.ToLower(n.DataID) + ";")
	}
	if n.RequestID != "" {
		manifest.WriteString("request-id:" + n.RequestID + ";")
	}
	manifest.WriteString("ts:" + ts + ";")
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(manifest.String()))
	return hmac.Equal(m.Sum(nil), got)
}

// HandleNotification processa uma notificação do Mercado Pago. Nunca confia no conteúdo: com a assinatura válida,
// busca o pagamento na API do Mercado Pago e decide com o que ela devolve. nil = responder 200 (inclusive para o
// que é ignorado); ErrInvalidSignature = 401; outro erro = 500 (o Mercado Pago reenvia).
func (s *Service) HandleNotification(ctx context.Context, n Notification) error {
	if !s.cfg.Enabled {
		return ErrDisabled
	}
	ctx, span := s.tracer.Start(ctx, "billing.webhook")
	defer span.End()
	if !VerifySignature(s.cfg.WebhookSecret, n) {
		s.count(ctx, "webhook", "invalid_signature")
		return ErrInvalidSignature
	}
	if n.Type != "payment" {
		s.count(ctx, "webhook", "ignored")
		return nil
	}
	id, err := strconv.ParseInt(n.DataID, 10, 64)
	if err != nil || id <= 0 {
		s.count(ctx, "webhook", "ignored")
		return nil
	}
	span.SetAttributes(attribute.Int64("mp.payment_id", id))
	p, err := s.gw.GetPayment(ctx, id)
	if errors.Is(err, ErrPaymentNotFound) {
		s.count(ctx, "webhook", "ignored") // inclusive a notificação de teste do painel (ID fictício)
		return nil
	}
	if err != nil {
		s.count(ctx, "webhook", "error")
		return fmt.Errorf("buscar pagamento %d: %w", id, err)
	}
	orderID, ok := httpx.ParseID(p.ExternalReference)
	if !ok {
		s.count(ctx, "webhook", "ignored")
		return nil
	}
	switch p.Status {
	case "approved":
		return s.approve(ctx, orderID, p)
	case "refunded", "charged_back":
		return s.refund(ctx, p)
	default: // pending, in_process, rejected, cancelled...: nada a conceder
		s.count(ctx, "webhook", "ignored")
		slog.InfoContext(ctx, "pagamento: notificação sem efeito", "mp_payment_id", p.ID, "status", p.Status)
		return nil
	}
}

func (s *Service) approve(ctx context.Context, orderID int64, p MPPayment) error {
	o, err := s.store.Order(ctx, orderID)
	if errors.Is(err, ErrOrderNotFound) {
		s.count(ctx, "webhook", "ignored")
		slog.WarnContext(ctx, "pagamento: pedido desconhecido", "mp_payment_id", p.ID, "order_id", orderID)
		return nil
	}
	if err != nil {
		s.count(ctx, "webhook", "error")
		return err
	}
	if p.Currency != o.Currency || int64(math.Round(p.Amount*100)) != int64(o.AmountCents) {
		s.count(ctx, "webhook", "mismatch")
		slog.WarnContext(ctx, "pagamento: valor ou moeda diferentes do pedido; nada concedido",
			"mp_payment_id", p.ID, "order_id", o.ID, "currency", p.Currency, "amount", p.Amount, "expected_cents", o.AmountCents)
		return nil
	}
	applied, err := s.store.Approve(ctx, o.ID, p.ID, p.Status, s.now(), func(o Order) (int64, error) {
		return s.plans.GrantPayment(ctx, o.UserID, o.Tier, o.Days)
	})
	switch {
	case errors.Is(err, ErrOrderNotFound):
		s.count(ctx, "webhook", "ignored")
		return nil
	case err != nil:
		s.count(ctx, "webhook", "error")
		return err
	case !applied:
		s.count(ctx, "webhook", "duplicate")
	default:
		s.count(ctx, "webhook", "granted")
		slog.InfoContext(ctx, "pagamento: aprovado e plano concedido", "mp_payment_id", p.ID, "order_id", o.ID, "user", o.UserID, "tier", string(o.Tier))
	}
	return nil
}

func (s *Service) refund(ctx context.Context, p MPPayment) error {
	done, err := s.store.Refund(ctx, p.ID, p.Status, func(entitlementID int64) error {
		return s.plans.RevokePayment(ctx, entitlementID)
	})
	if err != nil {
		s.count(ctx, "webhook", "error")
		return err
	}
	if done {
		s.count(ctx, "webhook", "refunded")
		slog.WarnContext(ctx, "pagamento: estornado; concessão revogada", "mp_payment_id", p.ID, "status", p.Status)
	} else {
		s.count(ctx, "webhook", "ignored")
	}
	return nil
}
