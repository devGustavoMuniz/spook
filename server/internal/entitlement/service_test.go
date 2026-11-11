package entitlement

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

// ---- falsos ----

type fakeStore struct {
	mu       sync.Mutex
	users    map[int64]Account
	grants   []Grant
	codes    map[string]*Code // por hash
	notified map[int64]bool
	batches  []*Batch
	deleted  map[int64]bool // contas excluídas
	failPage int            // >0: a página de concessão em massa de número failPage falha
}

func newFakeStore(userIDs ...int64) *fakeStore {
	f := &fakeStore{users: map[int64]Account{}, codes: map[string]*Code{}, notified: map[int64]bool{}}
	for _, id := range userIDs {
		f.users[id] = Account{ID: id, Username: "u" + string(rune('a'+id%26))}
	}
	return f
}

func (f *fakeStore) live(userID int64) []Grant {
	var out []Grant
	for _, g := range f.grants {
		if g.UserID == userID && g.RevokedAt == nil {
			out = append(out, g)
		}
	}
	return out
}

func (f *fakeStore) Live(_ context.Context, userID int64) ([]Grant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.live(userID), nil
}

func (f *fakeStore) Account(_ context.Context, userID int64) (Account, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.users[userID]
	if !ok {
		return Account{}, ErrUserNotFound
	}
	return a, nil
}

func (f *fakeStore) Grant(_ context.Context, userID int64, build func([]Grant) (Grant, error)) (Grant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.users[userID]; !ok {
		return Grant{}, ErrUserNotFound
	}
	g, err := build(f.live(userID))
	if err != nil {
		return Grant{}, err
	}
	f.grants = append(f.grants, g)
	return g, nil
}

func (f *fakeStore) Redeem(_ context.Context, hash string, userID int64, now time.Time, build func([]Grant, Code) (Grant, error)) (Grant, Code, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.codes[hash]
	switch {
	case !ok:
		return Grant{}, Code{}, ErrCodeInvalid
	case c.RedeemedAt != nil:
		return Grant{}, Code{}, ErrCodeUsed
	case c.ExpiresAt != nil && !c.ExpiresAt.After(now):
		return Grant{}, Code{}, ErrCodeExpired
	}
	t, u := now, userID
	c.RedeemedAt, c.RedeemedBy = &t, &u
	g, err := build(f.live(userID), *c)
	if err != nil {
		return Grant{}, Code{}, err
	}
	f.grants = append(f.grants, g)
	return g, *c, nil
}

func (f *fakeStore) Revoke(_ context.Context, userID int64, now time.Time) ([]Grant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Grant
	for i, g := range f.grants {
		if g.UserID == userID && g.Plan().Active(now) {
			f.grants[i].RevokedAt = &now
			out = append(out, f.grants[i])
		}
	}
	return out, nil
}

func (f *fakeStore) RevokeOne(_ context.Context, id int64, now time.Time) (Grant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, g := range f.grants {
		if g.ID == id && g.Plan().Active(now) {
			f.grants[i].RevokedAt = &now
			return f.grants[i], nil
		}
	}
	return Grant{}, ErrGrantNotFound
}

func (f *fakeStore) ListGrants(context.Context, GrantFilter, time.Time) ([]GrantRow, int64, error) {
	return nil, 0, nil
}

func (f *fakeStore) ClaimExpired(_ context.Context, now time.Time, max int) ([]Grant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Grant
	for _, g := range f.grants {
		if g.RevokedAt == nil && g.ExpiresAt != nil && !g.ExpiresAt.After(now) && !f.notified[g.ID] && len(out) < max {
			f.notified[g.ID] = true
			out = append(out, g)
		}
	}
	return out, nil
}

func (f *fakeStore) InsertCodes(_ context.Context, codes []Code) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range codes {
		c := c
		f.codes[c.Hash] = &c
	}
	return nil
}

func (f *fakeStore) ListCodes(context.Context, CodeFilter, time.Time) ([]CodeRow, int64, error) {
	return nil, 0, nil
}

type seq struct{ n atomic.Int64 }

func (s *seq) Next() int64 { return s.n.Add(1) }

type recorder struct {
	mu  sync.Mutex
	evs []events.Event
}

func (r *recorder) Publish(e events.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evs = append(r.evs, e)
}

func (r *recorder) of(typ string) []events.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []events.Event
	for _, e := range r.evs {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

type profiles struct {
	mu   sync.Mutex
	seen []int64
}

func (p *profiles) Republish(_ context.Context, id int64) {
	p.mu.Lock()
	p.seen = append(p.seen, id)
	p.mu.Unlock()
}

var t0 = time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

type rig struct {
	svc   *Service
	store *fakeStore
	rec   *recorder
	prof  *profiles
	clock *time.Time
}

func newRig(userIDs ...int64) *rig {
	st := newFakeStore(userIDs...)
	rec, prof := &recorder{}, &profiles{}
	svc := NewService(st, &seq{}, rec, prof)
	now := t0
	svc.now = func() time.Time { return now }
	r := &rig{svc: svc, store: st, rec: rec, prof: prof}
	r.clock = &now
	return r
}

func (r *rig) advance(d time.Duration) { *r.clock = r.clock.Add(d) }

func ip(n int) *int { return &n }

func (r *rig) code(t *testing.T, tier plan.Tier, days *int) string {
	t.Helper()
	out, err := r.svc.CreateCodes(context.Background(), 1, tier, days, 1, nil)
	if err != nil || len(out.Items) != 1 {
		t.Fatalf("CreateCodes: %v %v", out, err)
	}
	return out.Items[0].Code
}

// ---- testes ----

func TestEffectiveTierWithSeveralGrants(t *testing.T) {
	r := newRig(10)
	ctx := context.Background()
	if tier, _ := r.svc.Tier(ctx, 10); tier != plan.Free {
		t.Fatalf("sem concessão = %q", tier)
	}
	if _, err := r.svc.Grant(ctx, 1, 10, plan.Nitro, nil); err != nil { // permanente
		t.Fatal(err)
	}
	if _, err := r.svc.Grant(ctx, 1, 10, plan.NitroPlus, ip(7)); err != nil {
		t.Fatal(err)
	}
	if tier, _ := r.svc.Tier(ctx, 10); tier != plan.NitroPlus {
		t.Fatalf("o maior vence, veio %q", tier)
	}
	r.advance(8 * 24 * time.Hour) // o Nitro+ venceu; o Nitro permanente continua
	if tier, _ := r.svc.Tier(ctx, 10); tier != plan.Nitro {
		t.Fatalf("vencida cai para o menor, veio %q", tier)
	}
	if _, err := r.svc.Revoke(ctx, 1, 10); err != nil {
		t.Fatal(err)
	}
	if tier, _ := r.svc.Tier(ctx, 10); tier != plan.Free {
		t.Fatalf("revogada = %q", tier)
	}
	p, _ := r.svc.Current(ctx, 10)
	if p.Tier != "free" || p.Source != nil || p.ExpiresAt != nil || p.Limits != plan.For(plan.Free) {
		t.Fatalf("plano grátis = %+v", p)
	}
}

func TestRedeemStacksDaysOnSameOrHigherTier(t *testing.T) {
	r := newRig(10)
	ctx := context.Background()
	p, err := r.svc.Redeem(ctx, 10, r.code(t, plan.Nitro, ip(30)))
	if err != nil || p.Tier != "nitro" || p.ExpiresAt == nil || !p.ExpiresAt.Equal(t0.Add(30*24*time.Hour)) || *p.Source != "code" {
		t.Fatalf("1º resgate = %+v %v", p, err)
	}
	// Mesmo plano: soma à validade vigente (30 + 15).
	p, err = r.svc.Redeem(ctx, 10, r.code(t, plan.Nitro, ip(15)))
	if err != nil || !p.ExpiresAt.Equal(t0.Add(45*24*time.Hour)) {
		t.Fatalf("soma = %+v %v", p, err)
	}
	// Plano maior: vale já (e vale 10 dias a partir de agora, pois o Nitro+ é maior que o Nitro vigente).
	p, _ = r.svc.Redeem(ctx, 10, r.code(t, plan.NitroPlus, ip(10)))
	if p.Tier != "nitro_plus" || !p.ExpiresAt.Equal(t0.Add(10*24*time.Hour)) {
		t.Fatalf("Nitro+ = %+v", p)
	}
	// Plano menor com o maior ativo: empilha depois do fim do maior (10 dias) e do próprio Nitro (45): max(45, 10) + 20.
	p, _ = r.svc.Redeem(ctx, 10, r.code(t, plan.Nitro, ip(20)))
	if p.Tier != "nitro_plus" {
		t.Fatalf("o efetivo continua sendo o maior: %+v", p)
	}
	r.advance(11 * 24 * time.Hour) // Nitro+ venceu
	cur, _ := r.svc.Current(ctx, 10)
	if cur.Tier != "nitro" || !cur.ExpiresAt.Equal(t0.Add(65*24*time.Hour)) {
		t.Fatalf("depois do Nitro+ = %+v (esperado nitro até +65 dias)", cur)
	}
	// Permanente.
	p, _ = r.svc.Redeem(ctx, 10, r.code(t, plan.NitroPlus, nil))
	if p.Tier != "nitro_plus" || p.ExpiresAt != nil {
		t.Fatalf("permanente = %+v", p)
	}
	if n := len(r.rec.of(events.EntitlementUpdate)); n != 5 {
		t.Fatalf("ENTITLEMENT_UPDATE = %d, esperado 5", n)
	}
	if len(r.prof.seen) != 5 {
		t.Fatalf("USER_UPDATE (Republish) = %d, esperado 5", len(r.prof.seen))
	}
}

func TestRedeemErrors(t *testing.T) {
	r := newRig(10, 11)
	ctx := context.Background()
	if _, err := r.svc.Redeem(ctx, 10, "lixo"); !errors.Is(err, ErrCodeInvalid) {
		t.Fatalf("formato inválido = %v", err)
	}
	if _, err := r.svc.Redeem(ctx, 10, "SPOOK-AAAA-BBBB-CCCC-DDDD"); !errors.Is(err, ErrCodeInvalid) {
		t.Fatalf("código inexistente = %v", err)
	}
	code := r.code(t, plan.Nitro, ip(30))
	if _, err := r.svc.Redeem(ctx, 10, strings.ToLower(strings.ReplaceAll(code, "-", " "))); err != nil {
		t.Fatalf("caixa e separadores não importam: %v", err)
	}
	if _, err := r.svc.Redeem(ctx, 11, code); !errors.Is(err, ErrCodeUsed) {
		t.Fatalf("código usado = %v", err)
	}
	if _, err := r.svc.Redeem(ctx, 10, code); !errors.Is(err, ErrCodeUsed) {
		t.Fatalf("reusar o próprio código = %v", err)
	}
	// Código com validade vencida.
	out, _ := r.svc.CreateCodes(ctx, 1, plan.Nitro, ip(30), 1, ip(2))
	r.advance(3 * 24 * time.Hour)
	if _, err := r.svc.Redeem(ctx, 11, out.Items[0].Code); !errors.Is(err, ErrCodeExpired) {
		t.Fatalf("código vencido = %v", err)
	}
	if tier, _ := r.svc.Tier(ctx, 11); tier != plan.Free {
		t.Fatal("resgate recusado não pode conceder plano")
	}
}

func TestRedeemConcurrentSingleWinner(t *testing.T) {
	r := newRig(10, 11, 12, 13, 14, 15, 16, 17)
	ctx := context.Background()
	code := r.code(t, plan.Nitro, ip(30))
	var wins, used atomic.Int32
	var wg sync.WaitGroup
	for id := int64(10); id <= 17; id++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.svc.Redeem(ctx, id, code)
			switch {
			case err == nil:
				wins.Add(1)
			case errors.Is(err, ErrCodeUsed):
				used.Add(1)
			default:
				t.Errorf("erro inesperado: %v", err)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 || used.Load() != 7 {
		t.Fatalf("vencedores=%d usados=%d, esperado 1 e 7", wins.Load(), used.Load())
	}
}

func TestCodeFormatAndHashing(t *testing.T) {
	re := regexp.MustCompile(`^SPOOK(-[A-Z2-7]{4}){4}$`)
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		display, raw, err := newCode()
		if err != nil || !re.MatchString(display) || len(raw) != 16 {
			t.Fatalf("código malformado: %q %q %v", display, raw, err)
		}
		if seen[display] {
			t.Fatal("código repetido")
		}
		seen[display] = true
		norm, ok := normalizeCode(display)
		if !ok || norm != raw {
			t.Fatalf("normalizar(%q) = %q %v", display, norm, ok)
		}
	}
	for _, bad := range []string{"", "SPOOK", "SPOOK-AAAA", "SPOOK-AAAA-BBBB-CCCC-DDDD-EEEE", "SPOOK-AAAA-BBBB-CCCC-DDD0", "SPOOK-AAAA-BBBB-CCCC-DDD!"} {
		if _, ok := normalizeCode(bad); ok {
			t.Errorf("%q deveria ser rejeitado", bad)
		}
	}
	a, b := NewService(nil, nil, nil, nil), NewService(nil, nil, nil, nil).WithPepper("segredo")
	h1, h2, h3 := a.hash("AAAABBBBCCCCDDDD"), b.hash("AAAABBBBCCCCDDDD"), b.hash("AAAABBBBCCCCDDDE")
	if len(h1) != 64 || h1 == h2 || h2 == h3 {
		t.Fatalf("hashes = %s %s %s", h1, h2, h3)
	}
	// O texto do código nunca fica no que o store guarda.
	r := newRig(10)
	display, _ := func() (string, error) {
		out, err := r.svc.CreateCodes(context.Background(), 1, plan.Nitro, ip(7), 1, nil)
		return out.Items[0].Code, err
	}()
	for hash, c := range r.store.codes {
		if strings.Contains(hash, "SPOOK") || strings.Contains(c.Hash, display) || len(c.Hint) != 4 {
			t.Fatalf("o store não pode guardar o texto do código: %+v", c)
		}
	}
}

func TestAdminValidationAndRevoke(t *testing.T) {
	r := newRig(10)
	ctx := context.Background()
	if _, err := r.svc.Grant(ctx, 1, 10, plan.Free, ip(7)); !errors.Is(err, ErrInvalidTier) {
		t.Fatalf("plano free = %v", err)
	}
	if _, err := r.svc.Grant(ctx, 1, 10, plan.Nitro, ip(0)); !errors.Is(err, ErrInvalidDays) {
		t.Fatalf("0 dias = %v", err)
	}
	if _, err := r.svc.Grant(ctx, 1, 10, plan.Nitro, ip(MaxDays+1)); !errors.Is(err, ErrInvalidDays) {
		t.Fatalf("dias demais = %v", err)
	}
	if _, err := r.svc.Grant(ctx, 1, 99, plan.Nitro, ip(7)); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("usuário inexistente = %v", err)
	}
	if _, err := r.svc.Revoke(ctx, 1, 10); !errors.Is(err, ErrNoActive) {
		t.Fatalf("revogar sem plano = %v", err)
	}
	if _, err := r.svc.CreateCodes(ctx, 1, plan.Nitro, ip(7), 0, nil); !errors.Is(err, ErrInvalidQty) {
		t.Fatalf("0 códigos = %v", err)
	}
	if _, err := r.svc.CreateCodes(ctx, 1, plan.Nitro, ip(7), MaxCodeBatch+1, nil); !errors.Is(err, ErrInvalidQty) {
		t.Fatalf("lote grande = %v", err)
	}
	g, err := r.svc.Grant(ctx, 1, 10, plan.NitroPlus, ip(30))
	if err != nil || g.Tier != "nitro_plus" || g.Source != "admin" || !g.Active || g.ExpiresAt == nil {
		t.Fatalf("grant = %+v %v", g, err)
	}
	res, err := r.svc.Revoke(ctx, 1, 10)
	if err != nil || res.Revoked != 1 || res.Plan.Tier != "free" {
		t.Fatalf("revoke = %+v %v", res, err)
	}
	evs := r.rec.of(events.EntitlementUpdate)
	if len(evs) != 2 {
		t.Fatalf("eventos = %d", len(evs))
	}
	last := evs[1].Data.(UpdatePayload)
	if last.Reason != "revoked" || last.Tier != "free" || evs[1].Topics[0] != "user:10" {
		t.Fatalf("último evento = %+v %v", last, evs[1].Topics)
	}
}

func TestExpireDueNotifiesOnlyWhenPlanDrops(t *testing.T) {
	r := newRig(10, 11)
	ctx := context.Background()
	// 10: dois Nitro que vencem em momentos diferentes (o 1º vencer não muda o plano). 11: um Nitro+ de 2 dias.
	_, _ = r.svc.Grant(ctx, 1, 10, plan.Nitro, ip(1))
	r.store.grants = append(r.store.grants, Grant{ID: 900, UserID: 10, Tier: plan.Nitro, Source: SourceCode, ExpiresAt: ptrT(t0.Add(72 * time.Hour))})
	_, _ = r.svc.Grant(ctx, 1, 11, plan.NitroPlus, ip(2))
	before := len(r.rec.of(events.EntitlementUpdate))

	r.advance(25 * time.Hour) // venceu o Nitro de 1 dia do usuário 10, mas há outro
	n, err := r.svc.ExpireDue(ctx)
	if err != nil || n != 1 || len(r.rec.of(events.EntitlementUpdate)) != before {
		t.Fatalf("1ª rodada: n=%d err=%v eventos=%d", n, err, len(r.rec.of(events.EntitlementUpdate))-before)
	}
	r.advance(48 * time.Hour) // venceram o Nitro+ do 11 (2 dias) e o Nitro do 10 (3 dias)
	n, err = r.svc.ExpireDue(ctx)
	if err != nil || n != 2 {
		t.Fatalf("2ª rodada: n=%d err=%v", n, err)
	}
	evs := r.rec.of(events.EntitlementUpdate)[before:]
	if len(evs) != 2 {
		t.Fatalf("eventos de vencimento = %d", len(evs))
	}
	for _, e := range evs {
		if p := e.Data.(UpdatePayload); p.Reason != "expired" || p.Tier != "free" {
			t.Fatalf("evento = %+v", p)
		}
	}
	// Idempotente: nada novo na rodada seguinte.
	if n, _ := r.svc.ExpireDue(ctx); n != 0 || len(r.rec.of(events.EntitlementUpdate))-before != 2 {
		t.Fatalf("3ª rodada deveria ser vazia: %d", n)
	}
}

func ptrT(t time.Time) *time.Time { return &t }
