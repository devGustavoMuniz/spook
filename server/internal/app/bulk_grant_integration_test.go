//go:build integration

package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

func (e *testEnv) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (e *testEnv) expiresOf(t *testing.T, batchID, userID string) time.Time {
	t.Helper()
	var ts time.Time
	if err := e.pool.QueryRow(context.Background(), `SELECT expires_at FROM entitlements WHERE batch_id = $1 AND user_id = $2`, batchID, userID).Scan(&ts); err != nil {
		t.Fatalf("concessão do lote para %s: %v", userID, err)
	}
	return ts
}

// resetPlans zera lotes e concessões: o banco é compartilhado entre os testes do pacote e as contagens do lote
// dependem de partir do zero. Contas continuam (o lote atinge todas as ativas).
func (e *testEnv) resetPlans(t *testing.T) {
	t.Helper()
	e.exec(t, `DELETE FROM entitlements`)
	e.exec(t, `DELETE FROM entitlement_batches`)
}

func (e *testEnv) giveGrant(t *testing.T, a *actor, tier string, expires any) {
	t.Helper()
	e.exec(t, `INSERT INTO entitlements (id, user_id, tier, source, expires_at) VALUES ((random() * 9e17)::bigint, $1, $2, 'admin', $3)`, a.id, tier, expires)
}

func TestGrantAllAuthAndValidation(t *testing.T) {
	e := nitroEnv(t)
	e.resetPlans(t) // o banco é compartilhado com os outros testes do pacote: parte de zero
	plain, adm := e.newActor(t, "comum"), e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	ok := J{"tier": "nitro_plus", "days": 30, "confirm": true}
	for _, r := range [][2]string{{"POST", "/api/admin/entitlements/grant-all"}, {"GET", "/api/admin/entitlement-batches"}, {"DELETE", "/api/admin/entitlement-batches/1"}} {
		resp, b := e.do(t, r[0], r[1], nil, nil)
		status(t, resp, b, 401)
	}
	plain.call(t, "POST", "/api/admin/entitlements/grant-all", ok, 403)
	plain.call(t, "GET", "/api/admin/entitlement-batches", nil, 403)
	plain.call(t, "DELETE", "/api/admin/entitlement-batches/1", nil, 403)
	for _, body := range []J{
		{"tier": "nitro_plus", "days": 30},                    // confirm ausente
		{"tier": "nitro_plus", "days": 30, "confirm": false},  // confirm falso
		{"tier": "nitro_plus", "confirm": true},               // days obrigatório (sem permanente)
		{"tier": "nitro_plus", "days": nil, "confirm": true},  // days nulo
		{"tier": "nitro_plus", "days": 0, "confirm": true},    // fora da faixa
		{"tier": "nitro_plus", "days": 3651, "confirm": true}, // fora da faixa
		{"tier": "free", "days": 30, "confirm": true},         // plano inválido
		{"days": 30, "confirm": true},                         // plano ausente
	} {
		adm.call(t, "POST", "/api/admin/entitlements/grant-all", body, 422)
	}
	adm.call(t, "DELETE", "/api/admin/entitlement-batches/999999999999", nil, 404)
	adm.call(t, "DELETE", "/api/admin/entitlement-batches/abc", nil, 404)
	if n := e.count(t, `SELECT count(*) FROM entitlement_batches`) + e.count(t, `SELECT count(*) FROM entitlements`); n != 0 {
		t.Fatalf("pedidos inválidos não gravam nada, mas há %d linhas", n)
	}
}

func TestGrantAllEndToEnd(t *testing.T) {
	e := nitroEnv(t)
	e.resetPlans(t)
	adm, ana, bob := e.newActor(t, "adm"), e.newActor(t, "ana"), e.newActor(t, "bob")
	cid, dan, eve, mate := e.newActor(t, "cid"), e.newActor(t, "dan"), e.newActor(t, "eve"), e.newActor(t, "colega")
	e.makeAdmin(t, adm)
	g := ana.createGuild(t, "Lote")
	mate.join(t, ana, g.id)
	ac, _ := ana.connectReady(t)
	mc, _ := mate.connectReady(t)

	e.giveGrant(t, bob, "nitro_plus", time.Now().Add(10*24*time.Hour)) // soma: o lote começa no fim dos 10 dias
	e.giveGrant(t, cid, "nitro_plus", nil)                             // permanente do mesmo plano: pulada
	e.giveGrant(t, dan, "nitro", nil)                                  // plano menor, mesmo permanente: recebe
	e.exec(t, `UPDATE users SET deleted_at = now() WHERE id = $1`, eve.id)
	eligible := e.count(t, `SELECT count(*) FROM users WHERE deleted_at IS NULL`)

	res := obj(t, adm.call(t, "POST", "/api/admin/entitlements/grant-all", J{"tier": "nitro_plus", "days": 30, "confirm": true}, 200))
	batch := str(res, "batch_id")
	if batch == "" || res["already_applied"] != false || int(num(res, "granted")) != eligible-1 || int(num(res, "skipped")) != 1 {
		t.Fatalf("resultado = %v (ativos: %d)", res, eligible)
	}
	if n := e.count(t, `SELECT count(*) FROM entitlements WHERE batch_id = $1 AND source = 'admin' AND granted_by = $2 AND tier = 'nitro_plus' AND revoked_at IS NULL`, batch, adm.id); n != eligible-1 {
		t.Fatalf("concessões do lote = %d", n)
	}
	// Soma de validade, plano menor, pulada e excluída.
	if d := e.expiresOf(t, batch, ana.id).Sub(time.Now()); d < 29*24*time.Hour || d > 30*24*time.Hour+time.Minute {
		t.Fatalf("Ana vence em %v", d)
	}
	if d := e.expiresOf(t, batch, bob.id).Sub(time.Now()); d < 39*24*time.Hour || d > 40*24*time.Hour+time.Minute {
		t.Fatalf("Bob deveria somar 30 dias aos 10 que já tinha: %v", d)
	}
	if d := e.expiresOf(t, batch, dan.id).Sub(time.Now()); d < 29*24*time.Hour || d > 30*24*time.Hour+time.Minute {
		t.Fatalf("Dan (Nitro permanente) ganha o Nitro+ a partir de agora: %v", d)
	}
	for _, skipped := range []*actor{cid, eve} {
		if e.count(t, `SELECT count(*) FROM entitlements WHERE batch_id = $1 AND user_id = $2`, batch, skipped.id) != 0 {
			t.Fatalf("%s não deveria receber", skipped.name)
		}
	}
	for _, a := range []*actor{ana, bob, cid, dan} {
		if str(a.myPlan(t), "tier") != "nitro_plus" {
			t.Fatalf("%s deveria ter Nitro+", a.name)
		}
	}
	if str(mate.myPlan(t), "tier") != "nitro_plus" || str(adm.myPlan(t), "tier") != "nitro_plus" {
		t.Fatal("todos os ativos recebem")
	}
	// Avisos ao vivo: a própria pessoa e os colegas dela.
	if ev := ac.entitlementEvent("granted"); str(ev, "tier") != "nitro_plus" || str(ev, "source") != "admin" {
		t.Fatalf("ENTITLEMENT_UPDATE = %v", ev)
	}
	if up := mc.userEvent("USER_UPDATE", ana.id); str(up, "plan") != "nitro_plus" {
		t.Fatalf("USER_UPDATE = %v", up)
	}
	// Lista de lotes.
	l := obj(t, adm.call(t, "GET", "/api/admin/entitlement-batches", nil, 200))
	items := list(l, "items")
	if int(num(l, "eligible_users")) != eligible || len(items) != 1 || str(items[0], "id") != batch || str(items[0], "created_by") != adm.name ||
		str(items[0], "tier") != "nitro_plus" || num(items[0], "days") != 30 || int(num(items[0], "granted")) != eligible-1 || items[0]["revoked_at"] != nil {
		t.Fatalf("lista de lotes = %v", l)
	}

	// Idempotência: repetir não grava nada.
	before := e.count(t, `SELECT count(*) FROM entitlements`)
	again := obj(t, adm.call(t, "POST", "/api/admin/entitlements/grant-all", J{"tier": "nitro_plus", "days": 30, "confirm": true}, 200))
	if again["already_applied"] != true || str(again, "batch_id") != batch || int(num(again, "granted")) != eligible-1 || e.count(t, `SELECT count(*) FROM entitlements`) != before {
		t.Fatalf("repetição = %v", again)
	}

	// Revogar o lote: só as concessões dele; a de Bob e a de Cid continuam; avisos de revogação.
	rev := obj(t, adm.call(t, "DELETE", "/api/admin/entitlement-batches/"+batch, nil, 200))
	if str(rev, "batch_id") != batch || int(num(rev, "revoked")) != eligible-1 {
		t.Fatalf("revogar = %v", rev)
	}
	if ev := ac.entitlementEvent("revoked"); str(ev, "tier") != "free" {
		t.Fatalf("evento de revogação = %v", ev)
	}
	if up := mc.userEvent("USER_UPDATE", ana.id); str(up, "plan") != "free" {
		t.Fatalf("USER_UPDATE da revogação = %v", up)
	}
	if str(ana.myPlan(t), "tier") != "free" || str(mate.myPlan(t), "tier") != "free" {
		t.Fatal("quem só tinha o lote volta ao grátis")
	}
	if str(bob.myPlan(t), "tier") != "nitro_plus" || str(cid.myPlan(t), "tier") != "nitro_plus" || str(dan.myPlan(t), "tier") != "nitro" {
		t.Fatal("as concessões próprias sobrevivem à revogação do lote")
	}
	adm.call(t, "DELETE", "/api/admin/entitlement-batches/"+batch, nil, 409)
	if l := obj(t, adm.call(t, "GET", "/api/admin/entitlement-batches", nil, 200)); list(l, "items")[0]["revoked_at"] == nil {
		t.Fatalf("lote deveria constar como revogado: %v", l)
	}
	// Revogado, o mesmo pedido vale de novo.
	redo := obj(t, adm.call(t, "POST", "/api/admin/entitlements/grant-all", J{"tier": "nitro_plus", "days": 30, "confirm": true}, 200))
	if redo["already_applied"] != false || str(redo, "batch_id") == batch {
		t.Fatalf("depois de revogar = %v", redo)
	}
}

// Dois pedidos idênticos ao mesmo tempo: só um lote é criado.
func TestGrantAllConcurrentRequestsCreateOneBatch(t *testing.T) {
	e := nitroEnv(t)
	e.resetPlans(t)
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	for i := 0; i < 4; i++ {
		e.newActor(t, "massa")
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	fresh, applied := 0, 0
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out := obj(t, adm.call(t, "POST", "/api/admin/entitlements/grant-all", J{"tier": "nitro", "days": 7, "confirm": true}, 200))
			mu.Lock()
			defer mu.Unlock()
			if out["already_applied"] == true {
				applied++
			} else {
				fresh++
			}
		}()
	}
	wg.Wait()
	if fresh != 1 || applied != 3 {
		t.Fatalf("lotes novos = %d, repetidos = %d", fresh, applied)
	}
	if n, users := e.count(t, `SELECT count(*) FROM entitlement_batches`), e.count(t, `SELECT count(*) FROM users WHERE deleted_at IS NULL`); n != 1 ||
		e.count(t, `SELECT count(*) FROM entitlements WHERE batch_id IS NOT NULL`) != users {
		t.Fatalf("lotes = %d, concessões != usuários (%d)", n, users)
	}
}

// Passa de uma página (500) de pessoas: todas recebem, sem duplicar.
func TestGrantAllSpansPages(t *testing.T) {
	e := nitroEnv(t)
	e.resetPlans(t)
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	e.exec(t, `INSERT INTO users (id, email, username, password_hash)
		SELECT 5000000000000 + g, 'massa' || g || '@t.local', 'massa' || g, '!' FROM generate_series(1, 1100) g`)
	eligible := e.count(t, `SELECT count(*) FROM users WHERE deleted_at IS NULL`)
	res := obj(t, adm.call(t, "POST", "/api/admin/entitlements/grant-all", J{"tier": "nitro", "days": 5, "confirm": true}, 200))
	if int(num(res, "granted")) != eligible || num(res, "skipped") != 0 {
		t.Fatalf("resultado = %v (ativos: %d)", res, eligible)
	}
	if n := e.count(t, `SELECT count(DISTINCT user_id) FROM entitlements WHERE batch_id = $1`, str(res, "batch_id")); n != eligible {
		t.Fatalf("pessoas distintas = %d de %d", n, eligible)
	}
}

func TestGrantAllRateLimit(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.ActionLimiters = map[string]*ratelimit.Limiter{"plan.grant_all": ratelimit.New(3.0/3600, 3)}
	})
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	for i := 1; i <= 3; i++ {
		adm.call(t, "POST", "/api/admin/entitlements/grant-all", J{"tier": "nitro", "days": i, "confirm": true}, 200)
	}
	resp, b := adm.do(t, "POST", "/api/admin/entitlements/grant-all", J{"tier": "nitro", "days": 9, "confirm": true})
	status(t, resp, b, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 deve levar Retry-After")
	}
}
