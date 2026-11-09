//go:build integration

package app

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

func nitroEnv(t *testing.T) *testEnv {
	return newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.AuthLimiter = ratelimit.New(100000, 100000)
		d.RedeemIPLimiter = ratelimit.New(100000, 100000)
	})
}

func (a *actor) myPlan(t *testing.T) J { return obj(t, a.call(t, "GET", "/api/me/plan", nil, 200)) }

// codes gera n códigos pelo admin e devolve os textos.
func codes(t *testing.T, adm *actor, tier string, days any, n int) []string {
	t.Helper()
	body := J{"tier": tier, "quantity": n}
	if days != nil {
		body["days"] = days
	}
	out := obj(t, adm.call(t, "POST", "/api/admin/redeem-codes", body, 201))
	var cs []string
	for _, it := range list(out, "items") {
		cs = append(cs, str(it, "code"))
	}
	if len(cs) != n {
		t.Fatalf("esperava %d códigos: %v", n, out)
	}
	return cs
}

// entitlementEvent lê até chegar um ENTITLEMENT_UPDATE com o motivo dado.
func (c *wsClient) entitlementEvent(reason string) J {
	c.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			break
		}
		if isEvent(f, "ENTITLEMENT_UPDATE") {
			if p := payload(c.t, f); str(p, "reason") == reason {
				return p
			}
		}
	}
	c.t.Fatalf("ENTITLEMENT_UPDATE %s não chegou", reason)
	return nil
}

func TestPlanRoutesRequireAuthAndAdmin(t *testing.T) {
	e := nitroEnv(t)
	plain, adm := e.newActor(t, "comum"), e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	for _, r := range [][2]string{
		{"GET", "/api/me/plan"}, {"POST", "/api/me/plan/redeem"}, {"GET", "/api/admin/entitlements"},
		{"POST", "/api/admin/users/1/entitlement"}, {"DELETE", "/api/admin/users/1/entitlement"}, {"DELETE", "/api/admin/entitlements/1"},
		{"POST", "/api/admin/redeem-codes"}, {"GET", "/api/admin/redeem-codes"},
	} {
		resp, b := e.do(t, r[0], r[1], nil, nil)
		status(t, resp, b, 401)
	}
	for _, r := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/admin/entitlements", nil},
		{"POST", "/api/admin/users/" + plain.id + "/entitlement", J{"tier": "nitro", "days": 7}},
		{"DELETE", "/api/admin/users/" + plain.id + "/entitlement", nil},
		{"DELETE", "/api/admin/entitlements/1", nil},
		{"POST", "/api/admin/redeem-codes", J{"tier": "nitro", "days": 7, "quantity": 1}},
		{"GET", "/api/admin/redeem-codes", nil},
	} {
		if out := plain.call(t, r.method, r.path, r.body, 403); !strings.Contains(string(out), "administradores") {
			t.Fatalf("403 deve ser genérico: %s", out)
		}
	}
	// Admin: validações e 404.
	adm.call(t, "POST", "/api/admin/users/"+plain.id+"/entitlement", J{"tier": "free", "days": 7}, 422)
	adm.call(t, "POST", "/api/admin/users/"+plain.id+"/entitlement", J{"tier": "nitro", "days": 0}, 422)
	adm.call(t, "POST", "/api/admin/users/"+plain.id+"/entitlement", J{"tier": "nitro", "days": 99999}, 422)
	adm.call(t, "POST", "/api/admin/users/999999999999/entitlement", J{"tier": "nitro", "days": 7}, 404)
	adm.call(t, "POST", "/api/admin/users/abc/entitlement", J{"tier": "nitro", "days": 7}, 404)
	adm.call(t, "DELETE", "/api/admin/users/"+plain.id+"/entitlement", nil, 404) // sem plano ativo
	adm.call(t, "DELETE", "/api/admin/entitlements/999999999999", nil, 404)
	adm.call(t, "POST", "/api/admin/redeem-codes", J{"tier": "nitro", "days": 7, "quantity": 0}, 422)
	adm.call(t, "POST", "/api/admin/redeem-codes", J{"tier": "nitro", "days": 7, "quantity": 101}, 422)
	adm.call(t, "GET", "/api/admin/entitlements?state=lixo", nil, 422)
	adm.call(t, "GET", "/api/admin/redeem-codes?state=lixo", nil, 422)
	p := plain.myPlan(t)
	if str(p, "tier") != "free" || p["expires_at"] != nil || p["source"] != nil {
		t.Fatalf("plano grátis = %v", p)
	}
	if l := obj2(p, "limits"); num(l, "screen_max_height") != 720 || num(l, "screen_max_fps") != 30 || l["animated_avatar"] != false {
		t.Fatalf("limites do grátis = %v", l)
	}
}

// O administrador concede e revoga; a pessoa é avisada em todas as sessões e os colegas recebem o plano em USER_UPDATE.
func TestAdminGrantRevokeAndEvents(t *testing.T) {
	e := nitroEnv(t)
	adm, ana, mate := e.newActor(t, "adm"), e.newActor(t, "ana"), e.newActor(t, "colega")
	e.makeAdmin(t, adm)
	g := ana.createGuild(t, "Nitro")
	mate.join(t, ana, g.id)
	ac, _ := ana.connectReady(t)
	mc, _ := mate.connectReady(t)

	grant := obj(t, adm.call(t, "POST", "/api/admin/users/"+ana.id+"/entitlement", J{"tier": "nitro_plus", "days": 30}, 201))
	if str(grant, "tier") != "nitro_plus" || str(grant, "source") != "admin" || grant["active"] != true || str(grant, "username") != ana.name {
		t.Fatalf("concessão = %v", grant)
	}
	ev := ac.entitlementEvent("granted")
	if str(ev, "tier") != "nitro_plus" || str(ev, "source") != "admin" || num(obj2(ev, "limits"), "screen_max_height") != 1440 {
		t.Fatalf("ENTITLEMENT_UPDATE = %v", ev)
	}
	mate.call(t, "GET", "/api/me/plan", nil, 200) // o colega tem o dele
	// O colega vê o plano de Ana (só o plano) em USER_UPDATE.
	up := mc.userEvent("USER_UPDATE", ana.id)
	if str(up, "plan") != "nitro_plus" {
		t.Fatalf("USER_UPDATE sem plano: %v", up)
	}
	for _, k := range []string{"source", "expires_at", "limits", "email"} {
		if _, leaked := up[k]; leaked {
			t.Fatalf("USER_UPDATE não pode expor %q a terceiros: %v", k, up)
		}
	}

	// O plano aparece em /users/me, na lista de membros e no autor das mensagens.
	if me := obj(t, ana.call(t, "GET", "/api/users/me", nil, 200)); str(me, "plan") != "nitro_plus" {
		t.Fatalf("/users/me = %v", me)
	}
	var found bool
	for _, m := range list(obj(t, mate.call(t, "GET", "/api/guilds/"+g.id+"/members", nil, 200)), "members") {
		if str(m, "user_id") == ana.id {
			found = true
			if str(m, "plan") != "nitro_plus" {
				t.Fatalf("membro sem plano: %v", m)
			}
		} else if _, has := m["plan"]; has {
			t.Fatalf("grátis não leva plan: %v", m)
		}
	}
	if !found {
		t.Fatal("Ana não está na lista de membros")
	}
	msg := ana.say(t, g.textID, "olá", 201)
	if str(obj2(msg, "author"), "plan") != "nitro_plus" {
		t.Fatalf("autor sem plano: %v", msg)
	}
	hist := list(obj(t, mate.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 200)), "messages")
	if len(hist) == 0 || str(obj2(hist[0], "author"), "plan") != "nitro_plus" {
		t.Fatalf("histórico sem plano: %v", hist)
	}

	// Lista do admin: ativa, com busca.
	page := obj(t, adm.call(t, "GET", "/api/admin/entitlements?q="+ana.name, nil, 200))
	if num(page, "total") != 1 || len(list(page, "items")) != 1 || str(list(page, "items")[0], "id") != str(grant, "id") {
		t.Fatalf("lista = %v", page)
	}

	res := obj(t, adm.call(t, "DELETE", "/api/admin/users/"+ana.id+"/entitlement", nil, 200))
	if num(res, "revoked") != 1 || str(obj2(res, "plan"), "tier") != "free" {
		t.Fatalf("revogar = %v", res)
	}
	if ev := ac.entitlementEvent("revoked"); str(ev, "tier") != "free" || ev["source"] != nil {
		t.Fatalf("evento de revogação = %v", ev)
	}
	if up := mc.userEvent("USER_UPDATE", ana.id); str(up, "plan") != "free" {
		t.Fatalf("USER_UPDATE do grátis deve levar plan=free: %v", up)
	}
	if str(ana.myPlan(t), "tier") != "free" {
		t.Fatal("deveria voltar ao grátis")
	}
	if page := obj(t, adm.call(t, "GET", "/api/admin/entitlements?q="+ana.name, nil, 200)); num(page, "total") != 0 {
		t.Fatalf("revogada não é mais ativa: %v", page)
	}
	if page := obj(t, adm.call(t, "GET", "/api/admin/entitlements?state=inactive&q="+ana.name, nil, 200)); num(page, "total") != 1 {
		t.Fatalf("revogada aparece em inactive: %v", page)
	}
}

func TestRedeemFlowAndSecrets(t *testing.T) {
	e := nitroEnv(t)
	adm, ana, bob := e.newActor(t, "adm"), e.newActor(t, "ana"), e.newActor(t, "bob")
	e.makeAdmin(t, adm)
	ac, _ := ana.connectReady(t)

	cs := codes(t, adm, "nitro", 30, 3)
	// Só o hash fica no banco; o texto do código não existe em nenhuma coluna.
	var n int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM redeem_codes WHERE code_hash = ANY($1) OR code_hint = ANY($1)`, cs).Scan(&n)
	if n != 0 {
		t.Fatal("o texto do código não pode estar no banco")
	}
	var hint string
	if err := e.pool.QueryRow(context.Background(), `SELECT code_hint FROM redeem_codes ORDER BY created_at DESC, id DESC LIMIT 1`).Scan(&hint); err != nil || len(hint) != 4 {
		t.Fatalf("dica = %q %v", hint, err)
	}
	// A listagem do admin não devolve o texto.
	lst := adm.call(t, "GET", "/api/admin/redeem-codes?state=unused", nil, 200)
	for _, c := range cs {
		if strings.Contains(string(lst), c) || strings.Contains(string(lst), strings.ReplaceAll(c, "-", "")) {
			t.Fatalf("a lista não pode vazar o código: %s", lst)
		}
	}

	// Inválido e formato ruim.
	ana.call(t, "POST", "/api/me/plan/redeem", J{"code": "SPOOK-AAAA-BBBB-CCCC-DDDD"}, 404)
	ana.call(t, "POST", "/api/me/plan/redeem", J{"code": "lixo!"}, 404)
	ana.call(t, "POST", "/api/me/plan/redeem", J{"code": ""}, 422)

	p := obj(t, ana.call(t, "POST", "/api/me/plan/redeem", J{"code": strings.ToLower(cs[0])}, 200))
	if str(p, "tier") != "nitro" || str(p, "source") != "code" || p["expires_at"] == nil {
		t.Fatalf("resgate = %v", p)
	}
	exp1, _ := time.Parse(time.RFC3339Nano, str(p, "expires_at"))
	if d := time.Until(exp1); d < 29*24*time.Hour || d > 30*24*time.Hour+time.Minute {
		t.Fatalf("validade = %v", exp1)
	}
	if ev := ac.entitlementEvent("redeemed"); str(ev, "tier") != "nitro" {
		t.Fatalf("evento = %v", ev)
	}
	// Mesmo código: 409 (ana) e 409 (outra pessoa). Os dias se somam ao resgatar outro do mesmo plano.
	ana.call(t, "POST", "/api/me/plan/redeem", J{"code": cs[0]}, 409)
	bob.call(t, "POST", "/api/me/plan/redeem", J{"code": cs[0]}, 409)
	p = obj(t, ana.call(t, "POST", "/api/me/plan/redeem", J{"code": cs[1]}, 200))
	exp2, _ := time.Parse(time.RFC3339Nano, str(p, "expires_at"))
	if diff := exp2.Sub(exp1); diff < 29*24*time.Hour+23*time.Hour || diff > 30*24*time.Hour+time.Minute {
		t.Fatalf("os dias deveriam somar: %v -> %v", exp1, exp2)
	}
	if str(bob.myPlan(t), "tier") != "free" {
		t.Fatal("o código usado não pode dar plano a quem o tentou depois")
	}

	// Código com validade vencida: 410. Permanente: expires_at nulo. Plano maior: vale na hora.
	out := obj(t, adm.call(t, "POST", "/api/admin/redeem-codes", J{"tier": "nitro", "days": 7, "quantity": 1, "expires_in_days": 1}, 201))
	old := str(list(out, "items")[0], "code")
	if _, err := e.pool.Exec(context.Background(), `UPDATE redeem_codes SET expires_at = now() - interval '1 minute' WHERE id = $1`, str(list(out, "items")[0], "id")); err != nil {
		t.Fatal(err)
	}
	bob.call(t, "POST", "/api/me/plan/redeem", J{"code": old}, 410)
	perm := codes(t, adm, "nitro_plus", nil, 1)[0]
	p = obj(t, ana.call(t, "POST", "/api/me/plan/redeem", J{"code": perm}, 200))
	if str(p, "tier") != "nitro_plus" || p["expires_at"] != nil {
		t.Fatalf("permanente = %v", p)
	}
	// Estados na lista do admin.
	used := obj(t, adm.call(t, "GET", "/api/admin/redeem-codes?state=used", nil, 200))
	if num(used, "total") < 3 {
		t.Fatalf("usados = %v", used)
	}
	for _, it := range list(used, "items") {
		if str(it, "state") != "used" || str(it, "redeemed_by") == "" {
			t.Fatalf("item usado = %v", it)
		}
	}
	if exp := obj(t, adm.call(t, "GET", "/api/admin/redeem-codes?state=expired", nil, 200)); num(exp, "total") < 1 {
		t.Fatalf("vencidos = %v", exp)
	}
}

// Dez pessoas resgatam o mesmo código ao mesmo tempo: exatamente uma vence.
func TestRedeemConcurrentSingleWinner(t *testing.T) {
	e := nitroEnv(t)
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	code := codes(t, adm, "nitro", 30, 1)[0]
	var actors []*actor
	for i := 0; i < 10; i++ {
		actors = append(actors, e.newActor(t, "corre"))
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	got := map[int]int{}
	for _, a := range actors {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, _ := a.do(t, "POST", "/api/me/plan/redeem", J{"code": code})
			mu.Lock()
			got[resp.StatusCode]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if got[200] != 1 || got[409] != 9 {
		t.Fatalf("respostas = %v, esperado 1x200 e 9x409", got)
	}
	var granted int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM entitlements e JOIN redeem_codes c ON c.id = e.redeem_code_id WHERE c.redeemed_by IS NOT NULL AND c.code_hint = $1`, code[len(code)-4:]).Scan(&granted)
	if granted != 1 {
		t.Fatalf("concessões geradas = %d, esperado 1", granted)
	}
	// A mesma pessoa resgatando dois códigos ao mesmo tempo soma os dias (nada se perde).
	two := codes(t, adm, "nitro", 10, 2)
	p := actors[0]
	for _, c := range two {
		wg.Add(1)
		go func() { defer wg.Done(); p.call(t, "POST", "/api/me/plan/redeem", J{"code": c}, 200) }()
	}
	wg.Wait()
	end, _ := time.Parse(time.RFC3339Nano, str(p.myPlan(t), "expires_at"))
	if d := time.Until(end); d < 29*24*time.Hour+20*time.Hour { // 30 (primeiro código, se foi o dele) ou 20 dias no mínimo
		// actors[0] pode não ter sido o vencedor do primeiro código: nesse caso a soma é de 20 dias.
		if d < 19*24*time.Hour+20*time.Hour {
			t.Fatalf("dois resgates simultâneos deveriam somar 20 dias: faltam %v", d)
		}
	}
}

func TestRedeemRateLimits(t *testing.T) {
	// Por usuário: 5 por minuto (limite padrão da ação plan.redeem).
	e := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.ActionLimiters = map[string]*ratelimit.Limiter{"plan.redeem": ratelimit.New(5.0/60, 5)}
		d.RedeemIPLimiter = ratelimit.New(100000, 100000)
	})
	a := e.newActor(t, "tenta")
	for i := 0; i < 5; i++ {
		a.call(t, "POST", "/api/me/plan/redeem", J{"code": "SPOOK-AAAA-BBBB-CCCC-DDDD"}, 404)
	}
	resp, b := a.do(t, "POST", "/api/me/plan/redeem", J{"code": "SPOOK-AAAA-BBBB-CCCC-DDDD"})
	status(t, resp, b, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 deve levar Retry-After")
	}
	// Por IP: o limitador próprio barra mesmo com o limite por usuário folgado.
	e2 := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.RedeemIPLimiter = ratelimit.New(1.0/3600, 2)
	})
	u1, u2 := e2.newActor(t, "ip1"), e2.newActor(t, "ip2")
	u1.call(t, "POST", "/api/me/plan/redeem", J{"code": "SPOOK-AAAA-BBBB-CCCC-DDDD"}, 404)
	u2.call(t, "POST", "/api/me/plan/redeem", J{"code": "SPOOK-AAAA-BBBB-CCCC-DDDD"}, 404)
	resp, b = u1.do(t, "POST", "/api/me/plan/redeem", J{"code": "SPOOK-AAAA-BBBB-CCCC-DDDD"})
	status(t, resp, b, 429)
}

// A função SQL user_plan (perfis em lote) e plan.Effective (Go) dão sempre o mesmo resultado.
func TestUserPlanSQLMatchesGoEffective(t *testing.T) {
	e := nitroEnv(t)
	ctx := context.Background()
	u := e.newActor(t, "calc")
	now := time.Now()
	h := func(d time.Duration) time.Time { return now.Add(d) }
	cases := []struct {
		name string
		rows [][4]any // tier, expires_at, revoked_at, ...
		want plan.Tier
	}{
		{"nada", nil, plan.Free},
		{"permanente", [][4]any{{"nitro", nil, nil, 0}}, plan.Nitro},
		{"vencida", [][4]any{{"nitro", h(-time.Hour), nil, 0}}, plan.Free},
		{"revogada", [][4]any{{"nitro_plus", nil, h(-time.Hour), 0}}, plan.Free},
		{"maior vence", [][4]any{{"nitro", nil, nil, 0}, {"nitro_plus", h(time.Hour), nil, 0}}, plan.NitroPlus},
		{"maior vencida", [][4]any{{"nitro", h(time.Hour), nil, 0}, {"nitro_plus", h(-time.Hour), nil, 0}}, plan.Nitro},
	}
	for _, c := range cases {
		if _, err := e.pool.Exec(ctx, `DELETE FROM entitlements WHERE user_id = $1`, u.id); err != nil {
			t.Fatal(err)
		}
		for i, r := range c.rows {
			if _, err := e.pool.Exec(ctx, `INSERT INTO entitlements (id, user_id, tier, source, expires_at, revoked_at) VALUES ($1, $2, $3, 'admin', $4, $5)`,
				time.Now().UnixNano()+int64(i), u.id, r[0], r[1], r[2]); err != nil {
				t.Fatal(err)
			}
		}
		var sqlTier string
		if err := e.pool.QueryRow(ctx, `SELECT user_plan($1)`, u.id).Scan(&sqlTier); err != nil {
			t.Fatal(err)
		}
		goTier, err := e.app.plans.Tier(ctx, mustID(t, u.id))
		if err != nil || string(goTier) != sqlTier || goTier != c.want {
			t.Fatalf("%s: sql=%q go=%q esperado=%q (%v)", c.name, sqlTier, goTier, c.want, err)
		}
	}
}

// O job de vencimento avisa quem perdeu o plano (e só quem perdeu).
func TestExpiryJobNotifies(t *testing.T) {
	e := nitroEnv(t)
	adm, ana, bia := e.newActor(t, "adm"), e.newActor(t, "ana"), e.newActor(t, "bia")
	e.makeAdmin(t, adm)
	adm.call(t, "POST", "/api/admin/users/"+ana.id+"/entitlement", J{"tier": "nitro", "days": 1}, 201)
	adm.call(t, "POST", "/api/admin/users/"+bia.id+"/entitlement", J{"tier": "nitro", "days": 1}, 201)
	adm.call(t, "POST", "/api/admin/users/"+bia.id+"/entitlement", J{"tier": "nitro", "days": 30}, 201) // empilha: continua
	ac, _ := ana.connectReady(t)
	bc, _ := bia.connectReady(t)

	if _, err := e.pool.Exec(context.Background(), `UPDATE entitlements SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND expires_at < now() + interval '2 days'`, ana.id); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(context.Background(), `UPDATE entitlements SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND expires_at < now() + interval '2 days'`, bia.id); err != nil {
		t.Fatal(err)
	}
	n, err := e.app.plans.ExpireDue(context.Background())
	if err != nil || n < 2 {
		t.Fatalf("ExpireDue = %d %v", n, err)
	}
	if ev := ac.entitlementEvent("expired"); str(ev, "tier") != "free" {
		t.Fatalf("ana deveria perder o plano: %v", ev)
	}
	bc.noEvent(300*time.Millisecond, "ENTITLEMENT_UPDATE") // bia ainda tem o Nitro empilhado
	if str(ana.myPlan(t), "tier") != "free" || str(bia.myPlan(t), "tier") != "nitro" {
		t.Fatal("planos depois do vencimento")
	}
	if n, _ := e.app.plans.ExpireDue(context.Background()); n != 0 {
		t.Fatalf("idempotente: %d", n)
	}
}

// putBytes sobe o arquivo na URL pré-assinada (Content-Type declarado).
func putBytes(t *testing.T, up J, ct string, body []byte) bool {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, str(up, "upload_url"), bytes.NewReader(body))
	req.Header.Set("Content-Type", ct)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode/100 == 2
}

func problemCodeOf(t *testing.T, b []byte) string { return str(obj(t, b), "code") }

// Sem Nitro, GIF (qualquer um) e imagem animada são recusados em avatar, banner e crop; com Nitro passam.
func TestAnimatedImagesRequireNitro(t *testing.T) {
	e := nitroEnv(t)
	adm, free, paid := e.newActor(t, "adm"), e.newActor(t, "livre"), e.newActor(t, "paga")
	e.makeAdmin(t, adm)
	gifData := animatedGIF()
	pngData := []byte("\x89PNG\r\n\x1a\nfake-image-bytes")
	// WebP "animado" mínimo: RIFF + WEBP + VP8X com a flag de animação.
	animWebP := append([]byte("RIFF\x1e\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x02\x00\x00\x00\x01\x00\x00\x01\x00\x00"), 0)

	for _, kind := range []string{"avatar", "banner"} {
		// 1) GIF declarado: 403 nitro_required, mensagem clara.
		out := free.call(t, "POST", "/api/users/me/"+kind, J{"content_type": "image/gif", "size": len(gifData)}, 403)
		if problemCodeOf(t, out) != "nitro_required" || !strings.Contains(string(out), "Nitro") {
			t.Fatalf("%s gif: %s", kind, out)
		}
		// 2) Estático continua livre, inclusive PATCH.
		up := obj(t, free.call(t, "POST", "/api/users/me/"+kind, J{"content_type": "image/png", "size": len(pngData)}, 200))
		if !putBytes(t, up, "image/png", pngData) {
			t.Skip("PUT direto ao storage recusado: CORS/rede do ambiente; o CI cobre")
		}
		free.call(t, "PATCH", "/api/users/me", J{kind + "_key": str(up, "key")}, 200)

		// 3) GIF disfarçado de PNG e WebP animado: o PATCH confere os bytes.
		for name, data := range map[string][]byte{"gif": gifData, "webp": animWebP} {
			ct := "image/png"
			if name == "webp" {
				ct = "image/webp"
			}
			up := obj(t, free.call(t, "POST", "/api/users/me/"+kind, J{"content_type": ct, "size": len(data)}, 200))
			putBytes(t, up, ct, data)
			out := free.call(t, "PATCH", "/api/users/me", J{kind + "_key": str(up, "key")}, 403)
			if problemCodeOf(t, out) != "nitro_required" {
				t.Fatalf("%s %s disfarçado: %s", kind, name, out)
			}
		}
	}
	// 4) crop-image: 403 sem Nitro (antes de qualquer leitura do storage).
	out := free.call(t, "POST", "/api/users/me/crop-image", J{"key": "avatars/" + free.id + "/1.gif", "x": 0, "y": 0, "width": 8, "height": 8}, 403)
	if problemCodeOf(t, out) != "nitro_required" {
		t.Fatalf("crop: %s", out)
	}

	// Com Nitro: tudo passa (GIF, crop e PATCH).
	adm.call(t, "POST", "/api/admin/users/"+paid.id+"/entitlement", J{"tier": "nitro", "days": 30}, 201)
	for _, kind := range []string{"avatar", "banner"} {
		up := obj(t, paid.call(t, "POST", "/api/users/me/"+kind, J{"content_type": "image/gif", "size": len(gifData)}, 200))
		if !putBytes(t, up, "image/gif", gifData) {
			t.Skip("PUT direto ao storage recusado")
		}
		crop := obj(t, paid.call(t, "POST", "/api/users/me/crop-image", J{"key": str(up, "key"), "x": 4, "y": 0, "width": 8, "height": 16}, 200))
		paid.call(t, "PATCH", "/api/users/me", J{kind + "_key": str(crop, "key")}, 200)
	}
	// Perdeu o plano: o que já estava salvo continua (o cliente mostra estático); trocar por outro GIF volta a exigir.
	adm.call(t, "DELETE", "/api/admin/users/"+paid.id+"/entitlement", nil, 200)
	paid.call(t, "PATCH", "/api/users/me", J{"bio": "sem plano, com GIF salvo"}, 200)
	paid.call(t, "POST", "/api/users/me/avatar", J{"content_type": "image/gif", "size": len(gifData)}, 403)
}

func mustID(t *testing.T, s string) int64 {
	t.Helper()
	var id int64
	for _, r := range s {
		id = id*10 + int64(r-'0')
	}
	return id
}
