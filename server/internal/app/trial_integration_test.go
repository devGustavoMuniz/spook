//go:build integration

package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/entitlement"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/social"
)

// trialCfg liga o período de cortesia (os testes montam Cfg à mão: sem isto ele fica desligado).
func trialCfg(d *Deps) {
	bigLimits(d)
	d.AuthLimiter = ratelimit.New(100000, 100000)
	d.RedeemIPLimiter = ratelimit.New(100000, 100000)
	d.Cfg.NitroTrialDays = 14
	d.Cfg.NitroTrialTier = "nitro_plus"
}

func (e *testEnv) trials(t *testing.T, userID string) int {
	return e.count(t, `SELECT count(*) FROM entitlements WHERE user_id = $1 AND source = 'trial'`, userID)
}

func daysLeft(t *testing.T, p J) float64 {
	t.Helper()
	exp, err := time.Parse(time.RFC3339, str(p, "expires_at"))
	if err != nil {
		t.Fatalf("expires_at: %v (%v)", err, p)
	}
	return time.Until(exp).Hours() / 24
}

func TestTrialOnRegisterGrantsOnceAndLoginDoesNotDuplicate(t *testing.T) {
	var mu sync.Mutex
	var evs []events.Event
	bus := events.NewBus(4096)
	bus.Subscribe(func(ev events.Event) { mu.Lock(); evs = append(evs, ev); mu.Unlock() })
	e := newEnvWith(t, func(d *Deps) { trialCfg(d); d.Bus = bus })
	mail, uname := uniq("cortesia")
	a := e.newActorRaw()
	a.name = uname
	resp, b := a.do(t, "POST", "/api/auth/register", J{"email": mail, "username": uname, "password": "senha-forte-123"})
	status(t, resp, b, 201)
	a.id = str(obj(t, a.call(t, "GET", "/api/users/me", nil, 200)), "id")

	// A primeira leitura depois do cadastro já mostra o plano.
	p := a.myPlan(t)
	if str(p, "tier") != "nitro_plus" || str(p, "source") != "trial" {
		t.Fatalf("plano = %v", p)
	}
	if d := daysLeft(t, p); d < 13.9 || d > 14.01 {
		t.Fatalf("dias restantes = %v", d)
	}
	if me := obj(t, a.call(t, "GET", "/api/users/me", nil, 200)); str(me, "plan") != "nitro_plus" {
		t.Fatalf("plan em /users/me = %v", me["plan"])
	}
	if e.trials(t, a.id) != 1 {
		t.Fatal("deveria haver 1 concessão trial")
	}
	// ENTITLEMENT_UPDATE (granted) publicado no tópico da pessoa.
	deadline := time.Now().Add(3 * time.Second)
	found := false
	for !found && time.Now().Before(deadline) {
		mu.Lock()
		for _, ev := range evs {
			if up, ok := ev.Data.(entitlement.UpdatePayload); ok && ev.Type == events.EntitlementUpdate && up.Reason == "granted" && len(ev.Topics) == 1 && ev.Topics[0] == "user:"+a.id {
				found = up.Tier == "nitro_plus" && up.Source != nil && *up.Source == "trial"
			}
		}
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	if !found {
		t.Fatal("ENTITLEMENT_UPDATE granted não foi publicado")
	}

	// Entrar de novo (outras sessões) não concede nada.
	for i := 0; i < 2; i++ {
		l := e.newActorRaw()
		resp, b := l.do(t, "POST", "/api/auth/login", J{"email": mail, "password": "senha-forte-123"})
		status(t, resp, b, 200)
	}
	if n := e.count(t, `SELECT count(*) FROM entitlements WHERE user_id = $1`, a.id); n != 1 {
		t.Fatalf("login duplicou a concessão: %d", n)
	}
	// A idempotência é do banco: uma segunda linha trial é recusada pelo índice único.
	if _, err := e.pool.Exec(context.Background(), `INSERT INTO entitlements (id, user_id, tier, source) VALUES (1234567, $1, 'nitro', 'trial')`, a.id); err == nil {
		t.Fatal("o índice único parcial deveria recusar a 2ª cortesia")
	}
}

func TestTrialDisabledByDefaultInTestConfig(t *testing.T) {
	e := nitroEnv(t) // Cfg de teste: NitroTrialDays zero
	a := e.newActor(t, "semcortesia")
	if p := a.myPlan(t); str(p, "tier") != "free" || p["source"] != nil {
		t.Fatalf("plano = %v", p)
	}
	if e.trials(t, a.id) != 0 {
		t.Fatal("não deveria haver cortesia")
	}
	// 0 dia explícito também desliga, mesmo com o plano configurado.
	e0 := newEnvWith(t, func(d *Deps) { trialCfg(d); d.Cfg.NitroTrialDays = 0 })
	if p := e0.newActor(t, "zero").myPlan(t); str(p, "tier") != "free" {
		t.Fatalf("0 dia: %v", p)
	}
}

func TestTrialTierNitroIsConfigurable(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) { trialCfg(d); d.Cfg.NitroTrialTier = "nitro"; d.Cfg.NitroTrialDays = 3 })
	p := e.newActor(t, "tiernitro").myPlan(t)
	if str(p, "tier") != "nitro" || str(p, "source") != "trial" || daysLeft(t, p) > 3.01 {
		t.Fatalf("plano = %v", p)
	}
}

func TestTrialFailureDoesNotBreakRegistration(t *testing.T) {
	e := newEnvWith(t, trialCfg)
	e.exec(t, `ALTER TABLE entitlements ADD CONSTRAINT entitlements_no_trial_test CHECK (source <> 'trial') NOT VALID`)
	restored := false
	restore := func() {
		if !restored {
			restored = true
			_, _ = e.pool.Exec(context.Background(), `ALTER TABLE entitlements DROP CONSTRAINT entitlements_no_trial_test`)
		}
	}
	t.Cleanup(restore)
	a := e.newActor(t, "falha") // o cadastro tem de dar 201 mesmo com a concessão falhando
	if p := a.myPlan(t); str(p, "tier") != "free" {
		t.Fatalf("plano = %v", p)
	}
	if e.trials(t, a.id) != 0 {
		t.Fatal("nada gravado")
	}
	restore()
}

func TestTrialStacksWithRedeemAndBulkGrant(t *testing.T) {
	e := newEnvWith(t, trialCfg)
	t.Cleanup(func() { e.resetPlans(t) }) // o lote em massa de 24 h travaria os testes de lote seguintes
	adm := e.newActor(t, "admtrial")
	e.makeAdmin(t, adm)
	a := e.newActor(t, "somar")
	if d := daysLeft(t, a.myPlan(t)); d < 13.9 || d > 14.01 {
		t.Fatalf("cortesia = %v", d)
	}
	// Código de Nitro+ de 30 dias soma depois da cortesia: 14 + 30.
	code := codes(t, adm, "nitro_plus", 30, 1)[0]
	p := obj(t, a.call(t, "POST", "/api/me/plan/redeem", J{"code": code}, 200))
	if str(p, "tier") != "nitro_plus" || daysLeft(t, p) < 43.9 || daysLeft(t, p) > 44.01 {
		t.Fatalf("depois do resgate = %v", p)
	}
	// Concessão em massa de mais 30 dias soma de novo (concessões independentes): 74.
	adm.call(t, "POST", "/api/admin/entitlements/grant-all", J{"tier": "nitro_plus", "days": 30, "confirm": true}, 200)
	p = a.myPlan(t)
	if d := daysLeft(t, p); d < 73.9 || d > 74.01 {
		t.Fatalf("depois do lote = %v dias", d)
	}
	if n := e.count(t, `SELECT count(*) FROM entitlements WHERE user_id = $1`, a.id); n != 3 {
		t.Fatalf("concessões independentes: %d", n)
	}
	// Revogar a pessoa derruba tudo e a cortesia não volta num novo login.
	adm.call(t, "DELETE", "/api/admin/users/"+a.id+"/entitlement", nil, 200)
	if str(a.myPlan(t), "tier") != "free" {
		t.Fatal("revogado deveria ser grátis")
	}
}

func TestTrialSocialNewAccountGetsItExistingDoesNot(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := newMailEnv(t, func(dd *Deps) {
		trialCfg(dd)
		dd.SocialProviders = map[string]social.Provider{social.Google: g, social.Discord: d}
	})
	mail, uname := uniq("sociallnew")
	g.codes["c1"] = social.Profile{ID: "g-" + uname, Email: mail, EmailVerified: true, Name: "Maria Silva"}

	a := e.rawActor()
	e.socialFlow(t, a, "google", "", "c1")
	// Antes de escolher o nome ainda não há conta: nada concedido.
	if n := e.count(t, `SELECT count(*) FROM entitlements WHERE source = 'trial' AND user_id IN (SELECT id FROM users WHERE email = $1)`, mail); n != 0 {
		t.Fatalf("antes de completar: %d", n)
	}
	a.call(t, "POST", "/api/auth/social/complete", J{"username": uname}, 201)
	a.id = str(obj(t, a.call(t, "GET", "/api/users/me", nil, 200)), "id")
	if p := a.myPlan(t); str(p, "tier") != "nitro_plus" || str(p, "source") != "trial" {
		t.Fatalf("social novo = %v", p)
	}

	// Entrar de novo pelo provedor (conta existente) não concede de novo.
	b := e.rawActor()
	e.socialFlow(t, b, "google", "", "c1")
	b.call(t, "GET", "/api/users/me", nil, 200)
	if e.trials(t, a.id) != 1 {
		t.Fatalf("cortesias = %d", e.trials(t, a.id))
	}

	// Conta existente por e-mail e senha, vinculada depois pelo provedor: nenhuma cortesia nova.
	old := e.newActor(t, "antiga")
	e.exec(t, `DELETE FROM entitlements WHERE user_id = $1`, old.id) // simula conta anterior ao recurso
	oldMail := e.emailOf(t, old)
	d.codes["c2"] = social.Profile{ID: "d-" + old.name, Email: oldMail, EmailVerified: true, Name: "Antiga"}
	c := e.rawActor()
	e.socialFlow(t, c, "discord", "", "c2")
	c.call(t, "GET", "/api/users/me", nil, 200)
	if n := e.count(t, `SELECT count(*) FROM entitlements WHERE user_id = $1`, old.id); n != 0 {
		t.Fatalf("vincular conta existente concedeu cortesia: %d", n)
	}
}
