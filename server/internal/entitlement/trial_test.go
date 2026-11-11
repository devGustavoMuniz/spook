package entitlement

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
)

func TestTrialDisabledByDefaultAndWithZeroDays(t *testing.T) {
	r := newRig(10)
	ctx := context.Background()
	if ok, err := r.svc.GrantTrial(ctx, 10); ok || err != nil { // sem WithTrial
		t.Fatalf("sem WithTrial = %v %v", ok, err)
	}
	r.svc.WithTrial(plan.NitroPlus, 0)
	r.svc.OnAccountCreated(ctx, 10)
	if len(r.store.grants) != 0 || len(r.rec.of("ENTITLEMENT_UPDATE")) != 0 {
		t.Fatalf("0 dia não concede: %+v", r.store.grants)
	}
}

func TestTrialGrantsOnceWithEventsAndPlan(t *testing.T) {
	r := newRig(10)
	r.svc.WithTrial(plan.NitroPlus, 14)
	ctx := context.Background()
	r.svc.OnAccountCreated(ctx, 10)
	r.svc.OnAccountCreated(ctx, 10) // repetição: idempotente
	if len(r.store.grants) != 1 {
		t.Fatalf("deveria haver 1 concessão: %+v", r.store.grants)
	}
	g := r.store.grants[0]
	if g.Source != SourceTrial || g.Tier != plan.NitroPlus || g.ExpiresAt == nil || !g.ExpiresAt.Equal(t0.Add(14*24*time.Hour)) {
		t.Fatalf("concessão = %+v", g)
	}
	p, _ := r.svc.Current(ctx, 10)
	if p.Tier != "nitro_plus" || p.Source == nil || *p.Source != "trial" {
		t.Fatalf("plano = %+v", p)
	}
	evs := r.rec.of("ENTITLEMENT_UPDATE")
	if len(evs) != 1 || evs[0].Data.(UpdatePayload).Reason != "granted" {
		t.Fatalf("eventos = %+v", evs)
	}
	if len(r.prof.seen) != 1 {
		t.Fatalf("USER_UPDATE (Republish) = %d", len(r.prof.seen))
	}
	if _, err := r.svc.GrantTrial(ctx, 10); !errors.Is(err, ErrTrialExists) {
		t.Fatalf("2ª concessão = %v", err)
	}
	// Vencido o período, volta ao grátis e o aviso de vencimento sai uma vez.
	r.advance(15 * 24 * time.Hour)
	if tier, _ := r.svc.Tier(ctx, 10); tier != plan.Free {
		t.Fatalf("vencido = %q", tier)
	}
	if n, err := r.svc.ExpireDue(ctx); err != nil || n != 1 {
		t.Fatalf("ExpireDue = %d %v", n, err)
	}
	if evs := r.rec.of("ENTITLEMENT_UPDATE"); len(evs) != 2 || evs[1].Data.(UpdatePayload).Reason != "expired" {
		t.Fatalf("aviso de vencimento: %+v", evs)
	}
}

func TestTrialRevokedNeverComesBack(t *testing.T) {
	r := newRig(10)
	r.svc.WithTrial(plan.Nitro, 7)
	ctx := context.Background()
	r.svc.OnAccountCreated(ctx, 10)
	if _, err := r.svc.Revoke(ctx, 1, 10); err != nil {
		t.Fatal(err)
	}
	r.svc.OnAccountCreated(ctx, 10)
	if n := len(r.store.grants); n != 1 {
		t.Fatalf("a cortesia não volta depois de revogada: %d concessões", n)
	}
}

func TestTrialStacksWithRedeemAndAdmin(t *testing.T) {
	r := newRig(10)
	r.svc.WithTrial(plan.NitroPlus, 14)
	ctx := context.Background()
	r.svc.OnAccountCreated(ctx, 10)
	// Nitro+ por mais 30 dias soma depois da cortesia (mesmo plano): 14 + 30.
	p, err := r.svc.Redeem(ctx, 10, r.code(t, plan.NitroPlus, ip(30)))
	if err != nil || p.ExpiresAt == nil || !p.ExpiresAt.Equal(t0.Add(44*24*time.Hour)) {
		t.Fatalf("resgate sobre a cortesia = %+v %v", p, err)
	}
	// Nitro (menor) concedido pelo admin: não muda o efetivo (Nitro+), empilha depois do Nitro+ vigente (44) + 5.
	if _, err := r.svc.Grant(ctx, 1, 10, plan.Nitro, ip(5)); err != nil {
		t.Fatal(err)
	}
	if tier, _ := r.svc.Tier(ctx, 10); tier != plan.NitroPlus {
		t.Fatalf("efetivo = %q", tier)
	}
	r.advance(45 * 24 * time.Hour)
	if tier, _ := r.svc.Tier(ctx, 10); tier != plan.Nitro {
		t.Fatalf("depois do Nitro+ sobra o Nitro: %q", tier)
	}
	var trials int
	for _, g := range r.store.grants {
		if g.Source == SourceTrial {
			trials++
		}
	}
	if trials != 1 {
		t.Fatalf("cortesias = %d", trials)
	}
}

type failingTrialStore struct {
	*fakeStore
}

func (failingTrialStore) GrantTrial(context.Context, int64, func([]Grant) (Grant, error)) (Grant, error) {
	return Grant{}, errors.New("banco fora")
}

func TestTrialFailureDoesNotPanicOrGrant(t *testing.T) {
	st := newFakeStore(10)
	svc := NewService(failingTrialStore{st}, &seq{}, &recorder{}, &profiles{}).WithTrial(plan.NitroPlus, 14)
	svc.OnAccountCreated(context.Background(), 10) // só loga
	if len(st.grants) != 0 {
		t.Fatalf("nada gravado: %+v", st.grants)
	}
}

func TestTrialConcurrentSingleGrant(t *testing.T) {
	r := newRig(10)
	r.svc.WithTrial(plan.NitroPlus, 14)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); r.svc.OnAccountCreated(context.Background(), 10) }()
	}
	wg.Wait()
	if len(r.store.grants) != 1 {
		t.Fatalf("concessões = %d", len(r.store.grants))
	}
}
