package entitlement

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// IDGenerator gera IDs Snowflake.
type IDGenerator interface{ Next() int64 }

// Admins responde se o usuário é administrador (implementado em app com admin.Service).
type Admins interface {
	IsAdmin(ctx context.Context, userID int64) (bool, error)
}

// Profiles republica o perfil público de alguém (USER_UPDATE, que leva o plano) para quem o vê.
type Profiles interface {
	Republish(ctx context.Context, userID int64)
}

// Service reúne as regras de concessão, resgate e consulta de plano.
type Service struct {
	store    Store
	ids      IDGenerator
	pub      events.Publisher
	profiles Profiles
	admins   Admins
	pepper   []byte
	now      func() time.Time

	// Avisos em segundo plano (concessão e revogação em massa): um aviso a cada notifyGap, para não travar o
	// gateway nem o banco em bases grandes. bg conta as rotinas em andamento (testes e desligamento esperam).
	notifyGap time.Duration
	bg        sync.WaitGroup
	stop      chan struct{}
	stopOnce  sync.Once

	// Período de cortesia de conta nova (zero dias = desligado, o padrão de quem monta o Service sem WithTrial).
	trialTier plan.Tier
	trialDays int

	changes     metric.Int64Counter
	redeems     metric.Int64Counter
	trialFailed metric.Int64Counter
}

func NewService(store Store, ids IDGenerator, pub events.Publisher, profiles Profiles) *Service {
	if pub == nil {
		pub = events.Discard{}
	}
	s := &Service{store: store, ids: ids, pub: pub, profiles: profiles, now: time.Now, notifyGap: NotifyGap, stop: make(chan struct{})}
	m := otel.Meter("spook/entitlement")
	s.changes, _ = m.Int64Counter("spook.entitlement.changes",
		metric.WithDescription("Mudanças de plano por ação (grant, grant_all, revoke, revoke_batch, redeem, expire, codes_created), plano e origem"))
	s.redeems, _ = m.Int64Counter("spook.entitlement.redeem_failed",
		metric.WithDescription("Resgates recusados, por motivo (invalid, used, expired)"))
	s.trialFailed, _ = m.Int64Counter("spook.entitlement.trial_failed",
		metric.WithDescription("Períodos de cortesia que falharam ao ser concedidos a uma conta nova (o cadastro segue)"))
	return s
}

// WithTrial liga o período de cortesia: toda conta nova ganha tier por days dias (days <= 0 desliga).
func (s *Service) WithTrial(tier plan.Tier, days int) *Service {
	s.trialTier, s.trialDays = tier, days
	return s
}

// WithAdmins liga a checagem de administrador das rotas /api/admin.
func (s *Service) WithAdmins(a Admins) *Service { s.admins = a; return s }

// WithPepper define a chave do HMAC que protege o hash dos códigos (vazio = SHA-256 simples). Trocar a chave
// invalida os códigos ainda não resgatados.
func (s *Service) WithPepper(key string) *Service {
	s.pepper = []byte(key)
	return s
}

// IsAdmin diz se o usuário é administrador (a barreira das rotas /api/admin do plano).
func (s *Service) IsAdmin(ctx context.Context, userID int64) (bool, error) {
	if s.admins == nil {
		return false, nil
	}
	return s.admins.IsAdmin(ctx, userID)
}

func (s *Service) count(ctx context.Context, action string, tier plan.Tier, source Source) {
	s.changes.Add(ctx, 1, metric.WithAttributes(
		attribute.String("action", action), attribute.String("tier", string(tier)), attribute.String("source", string(source))))
}

func plans(gs []Grant) []plan.Entitlement {
	out := make([]plan.Entitlement, len(gs))
	for i, g := range gs {
		out[i] = g.Plan()
	}
	return out
}

// status monta o plano visto pela própria pessoa a partir das concessões vivas dela.
func status(gs []Grant, now time.Time) PlanPayload {
	cur, ok := plan.Current(plans(gs), now)
	if !ok {
		return PlanPayload{Tier: string(plan.Free), Limits: plan.For(plan.Free)}
	}
	src := cur.Source
	return PlanPayload{Tier: string(cur.Tier), ExpiresAt: cur.ExpiresAt, Source: &src, Limits: plan.For(cur.Tier)}
}

// Tier devolve o plano efetivo da pessoa agora (usado pelo upload de avatar/banner, pela voz e pelos perfis).
func (s *Service) Tier(ctx context.Context, userID int64) (plan.Tier, error) {
	gs, err := s.store.Live(ctx, userID)
	if err != nil {
		return plan.Free, err
	}
	return plan.Effective(plans(gs), s.now()), nil
}

// Current é o plano da própria pessoa (GET /api/me/plan).
func (s *Service) Current(ctx context.Context, userID int64) (PlanPayload, error) {
	gs, err := s.store.Live(ctx, userID)
	if err != nil {
		return PlanPayload{}, err
	}
	return status(gs, s.now()), nil
}

// notify avisa a pessoa (ENTITLEMENT_UPDATE, todas as sessões) e quem vê o perfil dela (USER_UPDATE com o plano).
// Falhar aqui nunca desfaz a mudança: o plano novo vale na próxima leitura.
func (s *Service) notify(ctx context.Context, userID int64, reason string) {
	ctx = context.WithoutCancel(ctx)
	p, err := s.Current(ctx, userID)
	if err != nil {
		slog.WarnContext(ctx, "plano: não foi possível ler o plano para avisar", "user", userID, "err", err)
		return
	}
	s.pub.Publish(events.Event{
		Type: events.EntitlementUpdate, Topics: []string{"user:" + httpx.ID(userID)},
		Data: UpdatePayload{PlanPayload: p, Reason: reason},
	})
	if s.profiles != nil {
		s.profiles.Republish(ctx, userID)
	}
}

// stackBase é o instante em que os dias novos de um plano começam a contar: o fim da validade mais longa entre as
// concessões ativas do mesmo plano ou de um maior (assim os dias se somam em vez de correr juntos); agora, se
// não há nenhuma ou se alguma é permanente (nada a somar).
func stackBase(live []Grant, tier plan.Tier, now time.Time) time.Time {
	base := now
	for _, g := range live {
		if !g.Plan().Active(now) || g.Tier.Rank() < tier.Rank() {
			continue
		}
		if g.ExpiresAt == nil {
			return now
		}
		if g.ExpiresAt.After(base) {
			base = *g.ExpiresAt
		}
	}
	return base
}

func expiry(live []Grant, tier plan.Tier, days *int, now time.Time) *time.Time {
	if days == nil {
		return nil
	}
	t := stackBase(live, tier, now).Add(time.Duration(*days) * 24 * time.Hour)
	return &t
}

// daysLog formata o prazo para o log: o número de dias, ou "permanente".
func daysLog(d *int) any {
	if d == nil {
		return "permanente"
	}
	return *d
}

func validTier(t plan.Tier) bool { return t.Paid() }

func validDays(d *int) bool { return d == nil || (*d >= 1 && *d <= MaxDays) }

// ---- resgate ----

// codeAlphabet é o do base32 padrão (A-Z e 2-7): sem 0, 1, 8 nem 9, que se confundem com O, I e B.
var codeEnc = base32.StdEncoding.WithPadding(base32.NoPadding)

const (
	codeBytes  = 10 // 80 bits de entropia
	codeChars  = 16
	codePrefix = "SPOOK"
)

// newCode gera um código: 10 bytes aleatórios em base32 (16 caracteres) no formato SPOOK-XXXX-XXXX-XXXX-XXXX.
func newCode() (display, raw string, err error) {
	b := make([]byte, codeBytes)
	if _, err = rand.Read(b); err != nil {
		return "", "", fmt.Errorf("gerar código: %w", err)
	}
	raw = codeEnc.EncodeToString(b)
	parts := []string{codePrefix}
	for i := 0; i < codeChars; i += 4 {
		parts = append(parts, raw[i:i+4])
	}
	return strings.Join(parts, "-"), raw, nil
}

// normalizeCode aceita o código com ou sem hífens, em qualquer caixa e com espaços; devolve os 16 caracteres.
func normalizeCode(in string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.ToUpper(in) {
		switch {
		case r >= 'A' && r <= 'Z', r >= '2' && r <= '7':
			b.WriteRune(r)
		case r == '-', r == ' ', r == '\t':
		default:
			return "", false
		}
	}
	s := strings.TrimPrefix(b.String(), codePrefix)
	if len(s) != codeChars {
		return "", false
	}
	return s, true
}

func (s *Service) hash(raw string) string {
	if len(s.pepper) == 0 {
		h := sha256.Sum256([]byte(raw))
		return hex.EncodeToString(h[:])
	}
	m := hmac.New(sha256.New, s.pepper)
	m.Write([]byte(raw))
	return hex.EncodeToString(m.Sum(nil))
}

// Redeem resgata um código: soma os dias à validade vigente (mesmo plano ou maior) e avisa a pessoa.
func (s *Service) Redeem(ctx context.Context, userID int64, input string) (PlanPayload, error) {
	raw, ok := normalizeCode(input)
	if !ok {
		s.redeems.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", "invalid")))
		return PlanPayload{}, ErrCodeInvalid
	}
	now := s.now()
	g, code, err := s.store.Redeem(ctx, s.hash(raw), userID, now, func(live []Grant, c Code) (Grant, error) {
		cid := c.ID
		return Grant{
			ID: s.ids.Next(), UserID: userID, Tier: c.Tier, Source: SourceCode, ExpiresAt: expiry(live, c.Tier, c.Days, now),
			RedeemCodeID: &cid, CreatedAt: now,
		}, nil
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrCodeInvalid):
			s.redeems.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", "invalid")))
		case errors.Is(err, ErrCodeUsed):
			s.redeems.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", "used")))
		case errors.Is(err, ErrCodeExpired):
			s.redeems.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", "expired")))
		}
		return PlanPayload{}, err
	}
	s.count(ctx, "redeem", g.Tier, SourceCode)
	slog.InfoContext(ctx, "código de plano resgatado", "user", userID, "code_id", code.ID, "tier", string(g.Tier))
	s.notify(ctx, userID, "redeemed")
	return s.Current(ctx, userID)
}

// ---- administrador ----

// Grant concede o plano a alguém por days dias (nulo = permanente). Os dias se somam à validade vigente do mesmo
// plano ou de um maior. Devolve a concessão criada.
func (s *Service) Grant(ctx context.Context, adminID, userID int64, tier plan.Tier, days *int) (GrantPayload, error) {
	if !validTier(tier) {
		return GrantPayload{}, ErrInvalidTier
	}
	if !validDays(days) {
		return GrantPayload{}, ErrInvalidDays
	}
	acc, err := s.store.Account(ctx, userID)
	if err != nil {
		return GrantPayload{}, err
	}
	now := s.now()
	by := adminID
	g, err := s.store.Grant(ctx, userID, func(live []Grant) (Grant, error) {
		return Grant{
			ID: s.ids.Next(), UserID: userID, Tier: tier, Source: SourceAdmin, ExpiresAt: expiry(live, tier, days, now),
			GrantedBy: &by, CreatedAt: now,
		}, nil
	})
	if err != nil {
		return GrantPayload{}, err
	}
	s.count(ctx, "grant", tier, SourceAdmin)
	slog.InfoContext(ctx, "plano concedido pela equipe", "admin_id", adminID, "user", userID, "tier", string(tier), "days", daysLog(days), "grant_id", g.ID)
	s.notify(ctx, userID, "granted")
	return grantPayload(GrantRow{Grant: g, Username: acc.Username, DisplayName: acc.DisplayName, Active: g.Plan().Active(now)}), nil
}

// Revoke revoga todas as concessões ativas da pessoa; ErrNoActive se não havia nenhuma.
func (s *Service) Revoke(ctx context.Context, adminID, userID int64) (RevokeResult, error) {
	if _, err := s.store.Account(ctx, userID); err != nil {
		return RevokeResult{}, err
	}
	rs, err := s.store.Revoke(ctx, userID, s.now())
	if err != nil {
		return RevokeResult{}, err
	}
	if len(rs) == 0 {
		return RevokeResult{}, ErrNoActive
	}
	for _, g := range rs {
		s.count(ctx, "revoke", g.Tier, g.Source)
	}
	slog.InfoContext(ctx, "plano revogado pela equipe", "admin_id", adminID, "user", userID, "revoked", len(rs))
	s.notify(ctx, userID, "revoked")
	p, err := s.Current(ctx, userID)
	return RevokeResult{Revoked: len(rs), Plan: p}, err
}

// RevokeGrant revoga uma concessão específica.
func (s *Service) RevokeGrant(ctx context.Context, adminID, grantID int64) (RevokeResult, error) {
	g, err := s.store.RevokeOne(ctx, grantID, s.now())
	if err != nil {
		return RevokeResult{}, err
	}
	s.count(ctx, "revoke", g.Tier, g.Source)
	slog.InfoContext(ctx, "concessão de plano revogada pela equipe", "admin_id", adminID, "user", g.UserID, "grant_id", grantID)
	s.notify(ctx, g.UserID, "revoked")
	p, err := s.Current(ctx, g.UserID)
	return RevokeResult{Revoked: 1, Plan: p}, err
}

// ListGrants é a lista de concessões do /admin.
func (s *Service) ListGrants(ctx context.Context, f GrantFilter) (GrantsPage, error) {
	switch f.State {
	case "":
		f.State = "active"
	case "active", "inactive", "all":
	default:
		return GrantsPage{}, ErrInvalidFilter
	}
	if f.Tier != "" && !validTier(plan.Tier(f.Tier)) {
		return GrantsPage{}, ErrInvalidFilter
	}
	if f.Page < 1 {
		f.Page = 1
	}
	f.Q = strings.TrimSpace(f.Q)
	rows, total, err := s.store.ListGrants(ctx, f, s.now())
	if err != nil {
		return GrantsPage{}, err
	}
	items := make([]GrantPayload, len(rows))
	for i, r := range rows {
		items[i] = grantPayload(r)
	}
	return GrantsPage{Items: items, Total: total, Page: f.Page, PageSize: AdminPageSize}, nil
}

// CreateCodes gera qty códigos de resgate. O texto de cada um só existe no retorno: o banco guarda o hash.
func (s *Service) CreateCodes(ctx context.Context, adminID int64, tier plan.Tier, days *int, qty int, validForDays *int) (NewCodesPayload, error) {
	if !validTier(tier) {
		return NewCodesPayload{}, ErrInvalidTier
	}
	if !validDays(days) || (validForDays != nil && (*validForDays < 1 || *validForDays > MaxCodeValidity)) {
		return NewCodesPayload{}, ErrInvalidDays
	}
	if qty < 1 || qty > MaxCodeBatch {
		return NewCodesPayload{}, ErrInvalidQty
	}
	now := s.now()
	var until *time.Time
	if validForDays != nil {
		t := now.Add(time.Duration(*validForDays) * 24 * time.Hour)
		until = &t
	}
	by := adminID
	rows := make([]Code, 0, qty)
	out := NewCodesPayload{Items: make([]NewCodePayload, 0, qty)}
	for i := 0; i < qty; i++ {
		display, raw, err := newCode()
		if err != nil {
			return NewCodesPayload{}, err
		}
		id := s.ids.Next()
		rows = append(rows, Code{ID: id, Hash: s.hash(raw), Hint: raw[codeChars-4:], Tier: tier, Days: days, CreatedBy: &by, ExpiresAt: until})
		out.Items = append(out.Items, NewCodePayload{ID: httpx.ID(id), Code: display, Tier: string(tier), Days: days, ExpiresAt: until})
	}
	if err := s.store.InsertCodes(ctx, rows); err != nil {
		return NewCodesPayload{}, err
	}
	s.changes.Add(ctx, int64(qty), metric.WithAttributes(attribute.String("action", "codes_created"), attribute.String("tier", string(tier))))
	slog.InfoContext(ctx, "códigos de plano gerados pela equipe", "admin_id", adminID, "tier", string(tier), "days", daysLog(days), "quantity", qty)
	return out, nil
}

// ListCodes é a lista de códigos do /admin (sem o texto).
func (s *Service) ListCodes(ctx context.Context, f CodeFilter) (CodesPage, error) {
	switch f.State {
	case "":
		f.State = "unused"
	case "unused", "used", "expired", "all":
	default:
		return CodesPage{}, ErrInvalidFilter
	}
	if f.Tier != "" && !validTier(plan.Tier(f.Tier)) {
		return CodesPage{}, ErrInvalidFilter
	}
	if f.Page < 1 {
		f.Page = 1
	}
	now := s.now()
	rows, total, err := s.store.ListCodes(ctx, f, now)
	if err != nil {
		return CodesPage{}, err
	}
	items := make([]CodePayload, len(rows))
	for i, r := range rows {
		items[i] = codePayload(r, now)
	}
	return CodesPage{Items: items, Total: total, Page: f.Page, PageSize: AdminPageSize}, nil
}

// ---- vencimento ----

// ExpireDue avisa quem teve o plano vencido: para cada pessoa cujo plano efetivo caiu (a concessão que vence não
// era coberta por outra), publica ENTITLEMENT_UPDATE (reason "expired") e USER_UPDATE. Devolve quantas concessões
// foram tratadas. O plano em si não depende deste job: vencida, a concessão já deixa de contar nas consultas.
func (s *Service) ExpireDue(ctx context.Context) (int, error) {
	total := 0
	for {
		now := s.now()
		claimed, err := s.store.ClaimExpired(ctx, now, expireBatch)
		if err != nil {
			return total, err
		}
		top := map[int64]plan.Tier{} // maior plano que venceu, por pessoa
		for _, g := range claimed {
			top[g.UserID] = plan.Higher(top[g.UserID], g.Tier)
			s.count(ctx, "expire", g.Tier, g.Source)
		}
		for uid, lost := range top {
			cur, err := s.Tier(ctx, uid)
			if err != nil {
				slog.WarnContext(ctx, "plano: não foi possível reavaliar quem teve o plano vencido", "user", uid, "err", err)
				continue
			}
			if cur.Rank() < lost.Rank() {
				s.notify(ctx, uid, "expired")
			}
		}
		total += len(claimed)
		if len(claimed) < expireBatch {
			return total, nil
		}
	}
}

// ---- pagamento ----

// ---- período de cortesia ----

// GrantTrial concede o período de cortesia a uma conta nova (source "trial"): idempotente por pessoa (no máximo um,
// garantido por índice único parcial; ErrTrialExists na repetição). Desligado (0 dia) não faz nada e devolve false.
func (s *Service) GrantTrial(ctx context.Context, userID int64) (bool, error) {
	if s.trialDays <= 0 || !validTier(s.trialTier) {
		return false, nil
	}
	d, tier, now := s.trialDays, s.trialTier, s.now()
	g, err := s.store.GrantTrial(ctx, userID, func(live []Grant) (Grant, error) {
		return Grant{ID: s.ids.Next(), UserID: userID, Tier: tier, Source: SourceTrial, ExpiresAt: expiry(live, tier, &d, now), CreatedAt: now}, nil
	})
	if err != nil {
		return false, err
	}
	s.count(ctx, "trial", tier, SourceTrial)
	slog.InfoContext(ctx, "período de cortesia concedido", "user", userID, "tier", string(tier), "days", d, "grant_id", g.ID)
	s.notify(ctx, userID, "granted")
	return true, nil
}

// OnAccountCreated é o gancho de conta nova (cadastro por senha e por login social): concede o período de cortesia.
// Nunca falha o cadastro: erro vira log e métrica (spook.entitlement.trial_failed); repetição é ignorada.
func (s *Service) OnAccountCreated(ctx context.Context, userID int64) {
	if s.trialDays <= 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if _, err := s.GrantTrial(ctx, userID); err != nil && !errors.Is(err, ErrTrialExists) {
		s.trialFailed.Add(ctx, 1)
		slog.ErrorContext(ctx, "período de cortesia: não foi possível conceder", "user", userID, "err", err)
	}
}

// GrantPayment concede o plano de um pagamento aprovado (source "payment"): os dias se somam à validade vigente do
// mesmo plano ou de um maior, como no resgate. Devolve o ID da concessão (para estornar depois).
func (s *Service) GrantPayment(ctx context.Context, userID int64, tier plan.Tier, days int) (int64, error) {
	if !validTier(tier) {
		return 0, ErrInvalidTier
	}
	d := days
	if !validDays(&d) {
		return 0, ErrInvalidDays
	}
	now := s.now()
	g, err := s.store.Grant(ctx, userID, func(live []Grant) (Grant, error) {
		return Grant{ID: s.ids.Next(), UserID: userID, Tier: tier, Source: SourcePayment, ExpiresAt: expiry(live, tier, &d, now), CreatedAt: now}, nil
	})
	if err != nil {
		return 0, err
	}
	s.count(ctx, "grant", tier, SourcePayment)
	slog.InfoContext(ctx, "plano concedido por pagamento", "user", userID, "tier", string(tier), "days", days, "grant_id", g.ID)
	s.notify(ctx, userID, "granted")
	return g.ID, nil
}

// RevokePayment revoga a concessão de um pagamento estornado. Já revogada ou vencida não é erro.
func (s *Service) RevokePayment(ctx context.Context, grantID int64) error {
	g, err := s.store.RevokeOne(ctx, grantID, s.now())
	if errors.Is(err, ErrGrantNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	s.count(ctx, "revoke", g.Tier, g.Source)
	slog.InfoContext(ctx, "concessão de plano revogada por estorno", "user", g.UserID, "grant_id", grantID)
	s.notify(ctx, g.UserID, "revoked")
	return nil
}
