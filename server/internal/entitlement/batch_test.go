package entitlement

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// ---- métodos de lote do falso (mesma semântica do SQL: pula quem tem permanente do mesmo plano ou maior; os dias
// começam no fim da validade mais longa do mesmo plano ou de um maior) ----

func (f *fakeStore) BeginBatch(_ context.Context, b Batch, since time.Time) (Batch, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, x := range f.batches {
		if x.Tier == b.Tier && x.Days == b.Days && x.RevokedAt == nil && x.CreatedAt.After(since) {
			return *x, true, nil
		}
	}
	c := b
	f.batches = append(f.batches, &c)
	return b, false, nil
}

func (f *fakeStore) TargetUsers(_ context.Context, after int64, limit int) ([]int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var ids []int64
	for id := range f.users {
		if id > after && !f.deleted[id] {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	if len(ids) > limit {
		ids = ids[:limit]
	}
	return ids, nil
}

func (f *fakeStore) CountTargetUsers(context.Context) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return int64(len(f.users) - len(f.deleted)), nil
}

func (f *fakeStore) GrantPage(_ context.Context, b Batch, now time.Time, userIDs, grantIDs []int64) ([]int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failPage > 0 {
		f.failPage--
		if f.failPage == 0 {
			return nil, errors.New("falha simulada")
		}
	}
	var got []int64
	for i, uid := range userIDs {
		exp := expiry(f.live(uid), b.Tier, &b.Days, now)
		permanent := false
		for _, g := range f.live(uid) {
			if g.Plan().Active(now) && g.Tier.Rank() >= b.Tier.Rank() && g.ExpiresAt == nil {
				permanent = true
			}
		}
		if permanent {
			continue
		}
		by, bid := *b.CreatedBy, b.ID
		f.grants = append(f.grants, Grant{ID: grantIDs[i], UserID: uid, Tier: b.Tier, Source: SourceAdmin, ExpiresAt: exp, GrantedBy: &by, CreatedAt: now, BatchID: &bid})
		got = append(got, uid)
	}
	return got, nil
}

func (f *fakeStore) FinishBatch(_ context.Context, id int64, granted, skipped int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, b := range f.batches {
		if b.ID == id {
			b.Granted, b.Skipped = granted, skipped
		}
	}
	return nil
}

func (f *fakeStore) AbortBatch(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	var gs []Grant
	for _, g := range f.grants {
		if g.BatchID == nil || *g.BatchID != id {
			gs = append(gs, g)
		}
	}
	f.grants = gs
	var bs []*Batch
	for _, b := range f.batches {
		if b.ID != id {
			bs = append(bs, b)
		}
	}
	f.batches = bs
	return nil
}

func (f *fakeStore) ListBatches(context.Context, int) ([]BatchRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []BatchRow
	for _, b := range f.batches {
		out = append(out, BatchRow{Batch: *b})
	}
	return out, nil
}

func (f *fakeStore) RevokeBatch(_ context.Context, id int64, now time.Time) ([]Grant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var b *Batch
	for _, x := range f.batches {
		if x.ID == id {
			b = x
		}
	}
	switch {
	case b == nil:
		return nil, ErrBatchNotFound
	case b.RevokedAt != nil:
		return nil, ErrBatchRevoked
	}
	b.RevokedAt = &now
	var out []Grant
	for i, g := range f.grants {
		if g.BatchID != nil && *g.BatchID == id && g.Plan().Active(now) {
			f.grants[i].RevokedAt = &now
			out = append(out, f.grants[i])
		}
	}
	return out, nil
}

func newBatchRig(userIDs ...int64) *rig {
	r := newRig(userIDs...)
	r.svc.notifyGap = 0
	return r
}

func (r *rig) tier(t *testing.T, uid int64) plan.Tier {
	t.Helper()
	tier, err := r.svc.Tier(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	return tier
}

func TestGrantAllRequiresConfirmAndValidInput(t *testing.T) {
	r := newBatchRig(1, 2)
	ctx := context.Background()
	if _, err := r.svc.GrantAll(ctx, 1, plan.NitroPlus, 30, false); !errors.Is(err, ErrConfirmRequired) {
		t.Fatalf("sem confirm = %v", err)
	}
	if _, err := r.svc.GrantAll(ctx, 1, plan.Free, 30, true); !errors.Is(err, ErrInvalidTier) {
		t.Fatalf("tier = %v", err)
	}
	for _, d := range []int{0, -1, MaxDays + 1} {
		if _, err := r.svc.GrantAll(ctx, 1, plan.Nitro, d, true); !errors.Is(err, ErrInvalidDays) {
			t.Fatalf("days %d = %v", d, err)
		}
	}
	if len(r.store.batches) != 0 || len(r.store.grants) != 0 {
		t.Fatal("entrada inválida não grava nada")
	}
}

func TestGrantAllGrantsEveryActiveUserWithStackingRules(t *testing.T) {
	r := newBatchRig(10, 11, 12, 13, 14)
	r.store.deleted = map[int64]bool{14: true}
	ctx := context.Background()
	// 11 tem Nitro+ por 10 dias: o lote de 30 dias começa no fim dessa validade (soma).
	if _, err := r.svc.Grant(ctx, 1, 11, plan.NitroPlus, ip(10)); err != nil {
		t.Fatal(err)
	}
	// 12 tem Nitro+ permanente: pulado.
	if _, err := r.svc.Grant(ctx, 1, 12, plan.NitroPlus, nil); err != nil {
		t.Fatal(err)
	}
	// 13 tem Nitro permanente: o plano menor não cobre, ganha o Nitro+ a partir de agora.
	if _, err := r.svc.Grant(ctx, 1, 13, plan.Nitro, nil); err != nil {
		t.Fatal(err)
	}
	res, err := r.svc.GrantAll(ctx, 99, plan.NitroPlus, 30, true)
	if err != nil {
		t.Fatal(err)
	}
	r.svc.WaitNotifications()
	if res.Granted != 3 || res.Skipped != 1 || res.AlreadyApplied || res.BatchID == "" {
		t.Fatalf("resultado = %+v", res)
	}
	day := 24 * time.Hour
	want := map[int64]time.Time{10: t0.Add(30 * day), 11: t0.Add(40 * day), 13: t0.Add(30 * day)}
	got := map[int64]time.Time{}
	for _, g := range r.store.grants {
		if g.BatchID != nil {
			if g.Source != SourceAdmin || g.GrantedBy == nil || *g.GrantedBy != 99 || g.Tier != plan.NitroPlus {
				t.Fatalf("concessão do lote = %+v", g)
			}
			got[g.UserID] = *g.ExpiresAt
		}
	}
	if len(got) != 3 {
		t.Fatalf("concessões do lote = %v", got)
	}
	for uid, w := range want {
		if !got[uid].Equal(w) {
			t.Errorf("usuário %d vence em %v, esperava %v", uid, got[uid], w)
		}
	}
	for _, uid := range []int64{10, 11, 12, 13} {
		if r.tier(t, uid) != plan.NitroPlus {
			t.Errorf("usuário %d deveria ter Nitro+", uid)
		}
	}
	if r.tier(t, 14) != plan.Free {
		t.Error("conta excluída não recebe")
	}
	// Avisos: 1 ENTITLEMENT_UPDATE (granted) por pessoa afetada (e 3 anteriores dos Grant individuais, sem contar).
	n := 0
	for _, e := range r.rec.of(events.EntitlementUpdate) {
		if e.Data.(UpdatePayload).Reason == "granted" {
			n++
		}
	}
	if n != 3+3 { // 3 concessões individuais + 3 do lote
		t.Fatalf("avisos granted = %d", n)
	}
}

func TestGrantAllIsIdempotentWithinWindowAndRepeatableAfter(t *testing.T) {
	r := newBatchRig(10, 11)
	ctx := context.Background()
	first, err := r.svc.GrantAll(ctx, 1, plan.Nitro, 30, true)
	if err != nil || first.Granted != 2 {
		t.Fatalf("1º = %+v %v", first, err)
	}
	r.svc.WaitNotifications()
	evs := len(r.rec.of(events.EntitlementUpdate))
	again, err := r.svc.GrantAll(ctx, 1, plan.Nitro, 30, true)
	if err != nil || !again.AlreadyApplied || again.BatchID != first.BatchID || again.Granted != 2 {
		t.Fatalf("2º = %+v %v", again, err)
	}
	r.svc.WaitNotifications()
	if len(r.store.grants) != 2 || len(r.rec.of(events.EntitlementUpdate)) != evs {
		t.Fatal("repetir não grava nem avisa de novo")
	}
	// Prazo ou plano diferentes são lotes distintos.
	if res, _ := r.svc.GrantAll(ctx, 1, plan.Nitro, 31, true); res.AlreadyApplied {
		t.Fatal("prazo diferente é outro lote")
	}
	if res, _ := r.svc.GrantAll(ctx, 1, plan.NitroPlus, 30, true); res.AlreadyApplied {
		t.Fatal("plano diferente é outro lote")
	}
	// Passadas 24 h, o mesmo pedido vale de novo e soma os dias.
	r.advance(BatchWindow + time.Minute)
	res, err := r.svc.GrantAll(ctx, 1, plan.Nitro, 30, true)
	if err != nil || res.AlreadyApplied || res.Granted != 2 {
		t.Fatalf("depois da janela = %+v %v", res, err)
	}
	r.svc.WaitNotifications()
}

func TestRevokeBatchRevokesOnlyBatchGrantsAndNotifies(t *testing.T) {
	r := newBatchRig(10, 11)
	ctx := context.Background()
	if _, err := r.svc.Grant(ctx, 1, 11, plan.Nitro, nil); err != nil { // própria concessão: sobrevive ao lote revogado
		t.Fatal(err)
	}
	res, err := r.svc.GrantAll(ctx, 1, plan.NitroPlus, 30, true)
	if err != nil {
		t.Fatal(err)
	}
	r.svc.WaitNotifications()
	id, _ := httpx.ParseID(res.BatchID)
	out, err := r.svc.RevokeBatch(ctx, 1, id)
	r.svc.WaitNotifications()
	if err != nil || out.Revoked != 2 || out.BatchID != res.BatchID {
		t.Fatalf("revogar = %+v %v", out, err)
	}
	if r.tier(t, 10) != plan.Free || r.tier(t, 11) != plan.Nitro {
		t.Fatalf("depois de revogar: %q e %q", r.tier(t, 10), r.tier(t, 11))
	}
	revoked := 0
	for _, e := range r.rec.of(events.EntitlementUpdate) {
		if e.Data.(UpdatePayload).Reason == "revoked" {
			revoked++
		}
	}
	if revoked != 2 {
		t.Fatalf("avisos revoked = %d", revoked)
	}
	if _, err := r.svc.RevokeBatch(ctx, 1, id); !errors.Is(err, ErrBatchRevoked) {
		t.Fatalf("revogar de novo = %v", err)
	}
	if _, err := r.svc.RevokeBatch(ctx, 1, 424242); !errors.Is(err, ErrBatchNotFound) {
		t.Fatalf("lote inexistente = %v", err)
	}
	// Lote revogado libera repetir o mesmo pedido.
	if again, _ := r.svc.GrantAll(ctx, 1, plan.NitroPlus, 30, true); again.AlreadyApplied || again.Granted != 2 {
		t.Fatalf("repetir depois de revogar = %+v", again)
	}
	r.svc.WaitNotifications()
}

func TestGrantAllFailureRollsBackPartialBatch(t *testing.T) {
	ids := make([]int64, 0, batchPage+10)
	for i := int64(1); i <= batchPage+10; i++ {
		ids = append(ids, i)
	}
	r := newBatchRig(ids...)
	r.store.failPage = 2 // a 2ª página falha
	if _, err := r.svc.GrantAll(context.Background(), 1, plan.Nitro, 30, true); err == nil {
		t.Fatal("deveria falhar")
	}
	r.svc.WaitNotifications()
	if len(r.store.grants) != 0 || len(r.store.batches) != 0 || len(r.rec.of(events.EntitlementUpdate)) != 0 {
		t.Fatalf("lote parcial deveria ser desfeito: %d concessões, %d lotes", len(r.store.grants), len(r.store.batches))
	}
	// Repetir é seguro e passa por todas as páginas.
	res, err := r.svc.GrantAll(context.Background(), 1, plan.Nitro, 30, true)
	if err != nil || res.Granted != batchPage+10 {
		t.Fatalf("repetição = %+v %v", res, err)
	}
	r.svc.WaitNotifications()
}

func TestListBatchesIncludesEligibleCount(t *testing.T) {
	r := newBatchRig(10, 11, 12)
	r.store.deleted = map[int64]bool{12: true}
	if _, err := r.svc.GrantAll(context.Background(), 1, plan.Nitro, 7, true); err != nil {
		t.Fatal(err)
	}
	r.svc.WaitNotifications()
	l, err := r.svc.ListBatches(context.Background())
	if err != nil || l.EligibleUsers != 2 || len(l.Items) != 1 || l.Items[0].Granted != 2 || l.Items[0].Days != 7 {
		t.Fatalf("lista = %+v %v", l, err)
	}
}
