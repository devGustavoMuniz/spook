//go:build integration

package app

import (
	"net/http"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/gateway"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

const testGrace = 400 * time.Millisecond

// p4Cfg: limites folgados e tolerância de presença curta (o padrão é 15 s).
func p4Cfg(d *Deps) {
	gwCfg(d)
	d.DMLimiter = ratelimit.New(100000, 100000)
	d.AuthLimiter = ratelimit.New(100000, 100000) // vários testes cadastram dezenas de usuários
	d.Presence = presence.Config{OfflineGrace: testGrace}
}

// ---------- helpers ----------

// presence lê até chegar PRESENCE_UPDATE de user com o status; outros eventos e usuários são ignorados.
func (c *wsClient) presence(user, status string) {
	c.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			break
		}
		if isEvent(f, "PRESENCE_UPDATE") {
			p := payload(c.t, f)
			if str(p, "user_id") == user && str(p, "status") == status {
				return
			}
		}
	}
	c.t.Fatalf("PRESENCE_UPDATE %s=%s não chegou", user, status)
}

// noPresence falha se chegar PRESENCE_UPDATE de user (qualquer status) durante d.
func (c *wsClient) noPresence(user string, d time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			return
		}
		if isEvent(f, "PRESENCE_UPDATE") && str(payload(c.t, f), "user_id") == user {
			c.t.Fatalf("não deveria receber a presença de %s: %s", user, f.D)
		}
	}
}

// noEvent falha se chegar algum evento de um dos tipos durante d.
func (c *wsClient) noEvent(d time.Duration, names ...string) {
	c.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			return
		}
		for _, n := range names {
			if isEvent(f, n) {
				c.t.Fatalf("não deveria receber %s: %s", n, f.D)
			}
		}
	}
}

// channelEvent lê até chegar o evento name cujo payload tem id == channelID.
func (c *wsClient) channelEvent(name, channelID string) J {
	c.t.Helper()
	for {
		f := c.must()
		if isEvent(f, name) {
			if p := payload(c.t, f); str(p, "id") == channelID {
				return p
			}
		}
	}
}

func (c *wsClient) setStatus(status string) {
	c.t.Helper()
	c.send(gateway.OpPresence, gateway.SetPresence{Status: status})
}

func (a *actor) connectReady(t *testing.T) (*wsClient, J) {
	t.Helper()
	c := a.connect(t)
	_, ready := c.identify()
	return c, ready
}

func (a *actor) openDM(t *testing.T, recipientID string, want int) J {
	t.Helper()
	return obj(t, a.call(t, "POST", "/api/users/@me/channels", J{"recipient_id": recipientID}, want))
}

func (a *actor) newGroup(t *testing.T, want int, ids ...string) J {
	t.Helper()
	return obj(t, a.call(t, "POST", "/api/users/@me/channels", J{"recipient_ids": ids}, want))
}

func (a *actor) say(t *testing.T, channelID, text string, want int) J {
	t.Helper()
	return obj(t, a.call(t, "POST", "/api/channels/"+channelID+"/messages", J{"content": text}, want))
}

func recipientIDs(ch J) []string {
	var out []string
	for _, r := range list(ch, "recipients") {
		out = append(out, str(r, "id"))
	}
	sort.Strings(out)
	return out
}

func sameIDs(got []string, want ...string) bool {
	sort.Strings(want)
	return strings.Join(got, ",") == strings.Join(want, ",")
}

// friends faz todos entrarem num servidor do primeiro (o primeiro é o dono).
func friends(t *testing.T, name string, as ...*actor) guildFixture {
	t.Helper()
	g := as[0].createGuild(t, name)
	for _, a := range as[1:] {
		a.join(t, as[0], g.id)
	}
	return g
}

// ---------- presença ----------

func TestPresenceOnlineIdleOfflineAndVisibility(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b, stranger := e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "estranho")
	friends(t, "Presença", a, b)
	stranger.createGuild(t, "Outro")

	bc, _ := b.connectReady(t)
	sc, _ := stranger.connectReady(t)

	// A conecta: B (mesmo servidor) vê online; o estranho não vê nada
	ac, _ := a.connectReady(t)
	bc.presence(a.id, "online")
	sc.noPresence(a.id, 300*time.Millisecond)

	// idle via op 12 e de volta
	ac.setStatus("idle")
	bc.presence(a.id, "idle")
	ac.setStatus("online")
	bc.presence(a.id, "online")

	// queda: offline só depois da tolerância
	_ = ac.ws.CloseNow()
	bc.noPresence(a.id, testGrace*6/10)
	bc.presence(a.id, "offline")
	sc.noPresence(a.id, 100*time.Millisecond)
}

func TestPresenceQuickReconnectDoesNotFlap(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b := e.newActor(t, "a"), e.newActor(t, "b")
	friends(t, "Flap", a, b)
	bc, _ := b.connectReady(t)

	ac, _ := a.connectReady(t)
	bc.presence(a.id, "online")
	_ = ac.ws.CloseNow()
	time.Sleep(testGrace / 4)
	a.connectReady(t) // reconexão (sessão nova) dentro da tolerância
	bc.noPresence(a.id, testGrace*3)
}

func TestPresenceMultipleSessionsOfflineOnlyWhenAllDrop(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b := e.newActor(t, "a"), e.newActor(t, "b")
	friends(t, "Multi", a, b)
	bc, _ := b.connectReady(t)

	tab1, _ := a.connectReady(t)
	bc.presence(a.id, "online")
	tab2, _ := a.connectReady(t)
	bc.noPresence(a.id, 100*time.Millisecond) // segunda aba não gera transição

	tab1.setStatus("idle") // a outra aba segue ativa: continua online
	bc.noPresence(a.id, 150*time.Millisecond)
	tab2.setStatus("idle")
	bc.presence(a.id, "idle")

	_ = tab1.ws.CloseNow()
	bc.noPresence(a.id, testGrace*2) // sobra uma sessão: nem offline nem mudança
	_ = tab2.ws.CloseNow()
	bc.presence(a.id, "offline")
}

func TestReadyHasPresencesAndPrivateChannels(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b, c, stranger := e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "c"), e.newActor(t, "estranho")
	friends(t, "Ready", a, b, c)
	stranger.createGuild(t, "Outro")
	dmAB := a.openDM(t, b.id, 201)

	ac, _ := a.connectReady(t)
	cc, _ := c.connectReady(t)
	cc.setStatus("idle")
	ac.presence(c.id, "online")
	ac.presence(c.id, "idle")
	waitUntil(t, "c idle", func() bool { return e.app.presence.Status(mustInt(t, c.id)) == presence.StatusIdle })

	_, ready := b.connectReady(t)
	got := map[string]string{}
	for _, p := range list(ready, "presences") {
		got[str(p, "user_id")] = str(p, "status")
	}
	if len(got) != 2 || got[a.id] != "online" || got[c.id] != "idle" {
		t.Fatalf("presences = %v", got)
	}
	pcs := list(ready, "private_channels")
	if len(pcs) != 1 || str(pcs[0], "id") != str(dmAB, "id") || !sameIDs(recipientIDs(pcs[0]), a.id, b.id) {
		t.Fatalf("private_channels = %v", pcs)
	}

	// o estranho não compartilha nada: READY sem presença de ninguém
	_, sready := stranger.connectReady(t)
	if n := len(list(sready, "presences")); n != 0 {
		t.Fatalf("estranho não deveria ver presenças: %v", sready["presences"])
	}
	if sready["private_channels"] == nil || len(list(sready, "private_channels")) != 0 {
		t.Fatalf("private_channels deve ser [] : %v", sready["private_channels"])
	}
}

func TestPresenceVisibleThroughGroupDMWithoutSharedGuild(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	o, x, y := e.newActor(t, "dono"), e.newActor(t, "x"), e.newActor(t, "y")
	friends(t, "G1", o, x)
	friends(t, "G2", o, y) // x e y não compartilham servidor; só vão se ver pela DM em grupo
	xc, _ := x.connectReady(t)
	yc, _ := y.connectReady(t)
	xc.noPresence(y.id, 150*time.Millisecond)

	g := o.newGroup(t, 201, x.id, y.id)
	// ao criar a DM os online passam a se ver
	xc.presence(y.id, "online")
	yc.presence(x.id, "online")

	yc.setStatus("idle")
	xc.presence(y.id, "idle") // e as transições seguintes chegam por user:<par>
	_ = yc.ws.CloseNow()
	xc.presence(y.id, "offline")

	// READY de quem conecta depois traz a presença do par de DM
	z, _ := y.connectReady(t)
	xc.presence(y.id, "online")
	_ = z
	_, ready := x.connectReady(t)
	found := false
	for _, p := range list(ready, "presences") {
		if str(p, "user_id") == y.id && str(p, "status") == "online" {
			found = true
		}
	}
	if !found {
		t.Fatalf("READY de x deveria trazer y online (via DM %s): %v", str(g, "id"), ready["presences"])
	}
}

func TestPresenceOnGuildJoin(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	owner, newbie := e.newActor(t, "dono"), e.newActor(t, "novato")
	g := owner.createGuild(t, "Entrada")
	oc, _ := owner.connectReady(t)
	nc, _ := newbie.connectReady(t)
	oc.noPresence(newbie.id, 100*time.Millisecond) // ainda não compartilham nada

	newbie.join(t, owner, g.id)
	oc.presence(newbie.id, "online") // quem já estava vê o novo membro online
	nc.presence(owner.id, "online")  // e o novo membro vê quem está online no servidor
}

// ---------- digitando ----------

func TestTyping(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b, stranger := e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "estranho")
	g := friends(t, "Digitando", a, b)
	bc, _ := b.connectReady(t)
	sc, _ := stranger.connectReady(t)

	typing := func(who *actor, ch string, want int) { who.call(t, "POST", "/api/channels/"+ch+"/typing", nil, want) }
	typing(a, g.textID, 204)
	f := bc.event("TYPING_START")
	p := payload(t, f)
	if str(p, "channel_id") != g.textID || str(p, "guild_id") != g.id || str(p, "user_id") != a.id || num(p, "timestamp") < time.Now().Unix()-5 {
		t.Fatalf("TYPING_START = %v", p)
	}

	// throttle: o excedente é ignorado (204) e não gera evento; outro usuário no mesmo canal vale
	typing(a, g.textID, 204)
	typing(a, g.textID, 204)
	bc.noEvent(200*time.Millisecond, "TYPING_START")

	// depois da janela de ~3 s volta a publicar
	time.Sleep(3200 * time.Millisecond)
	typing(a, g.textID, 204)
	bc.event("TYPING_START")

	typing(b, g.textID, 204)
	if str(payload(t, bc.event("TYPING_START")), "user_id") != b.id {
		t.Fatal("typing de outro usuário no mesmo canal tem balde próprio")
	}

	// quem não vê o canal: 404, sem evento; voz não aceita; sem sessão: 401
	typing(stranger, g.textID, 404)
	typing(a, g.voiceID, 422)
	typing(a, "999999999", 404)
	sc.noEvent(150*time.Millisecond, "TYPING_START")
	resp, body := e.do(t, "POST", "/api/channels/"+g.textID+"/typing", nil, nil)
	status(t, resp, body, http.StatusUnauthorized)

	// sem VIEW_CHANNEL/SEND_MESSAGES: o dono tira SEND_MESSAGES do @everyone e b não pode mais "digitar"
	a.call(t, "PATCH", "/api/guilds/"+g.id+"/roles/"+g.id, J{"permissions": int64(perm.ViewChannel)}, 200)
	typing(b, g.textID, 403)
}

func TestTypingInDM(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b, c := e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "c")
	friends(t, "DMTyping", a, b, c)
	dm := a.openDM(t, b.id, 201)
	bc, _ := b.connectReady(t)
	cc, _ := c.connectReady(t)

	a.call(t, "POST", "/api/channels/"+str(dm, "id")+"/typing", nil, 204)
	p := payload(t, bc.event("TYPING_START"))
	if str(p, "channel_id") != str(dm, "id") || p["guild_id"] != nil || str(p, "user_id") != a.id {
		t.Fatalf("TYPING_START da DM = %v", p)
	}
	c.call(t, "POST", "/api/channels/"+str(dm, "id")+"/typing", nil, 404)
	cc.noEvent(150*time.Millisecond, "TYPING_START")
}

// ---------- DM 1:1 ----------

func TestDMRequiresSharedGuildAndIsUniquePerPair(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b, loner := e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "solitario")
	friends(t, "Par", a, b)

	loner.createGuild(t, "Só")
	a.call(t, "POST", "/api/users/@me/channels", J{"recipient_id": loner.id}, 403)
	a.call(t, "POST", "/api/users/@me/channels", J{"recipient_id": a.id}, 422)
	a.call(t, "POST", "/api/users/@me/channels", J{"recipient_id": "999999999"}, 403)
	a.call(t, "POST", "/api/users/@me/channels", J{}, 422)
	a.call(t, "POST", "/api/users/@me/channels", J{"recipient_id": b.id, "recipient_ids": []string{b.id}}, 422)
	a.call(t, "POST", "/api/users/@me/channels", J{"recipient_id": "abc"}, 422)

	dm := a.openDM(t, b.id, 201)
	if num(dm, "type") != 3 || dm["guild_id"] != nil || !sameIDs(recipientIDs(dm), a.id, b.id) {
		t.Fatalf("DM = %v", dm)
	}
	again := a.openDM(t, b.id, 200) // reabrir devolve a existente
	back := b.openDM(t, a.id, 200)  // e o outro lado também
	if str(again, "id") != str(dm, "id") || str(back, "id") != str(dm, "id") {
		t.Fatalf("par único: %v %v %v", dm["id"], again["id"], back["id"])
	}
	// sem sessão
	resp, body := e.do(t, "POST", "/api/users/@me/channels", J{"recipient_id": b.id}, nil)
	status(t, resp, body, 401)
}

func TestDMConcurrentCreationYieldsOneChannel(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b := e.newActor(t, "a"), e.newActor(t, "b")
	friends(t, "Corrida", a, b)

	const n = 12
	var wg sync.WaitGroup
	var mu sync.Mutex
	ids, created, ok := map[string]bool{}, 0, 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			who, other := a, b
			if i%2 == 1 {
				who, other = b, a
			}
			resp, body := who.do(t, "POST", "/api/users/@me/channels", J{"recipient_id": other.id})
			if resp.StatusCode != 200 && resp.StatusCode != 201 {
				t.Errorf("status %d: %s", resp.StatusCode, body)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			ids[str(obj(t, body), "id")] = true
			ok++
			if resp.StatusCode == 201 {
				created++
			}
		}()
	}
	wg.Wait()
	if len(ids) != 1 || created != 1 || ok != n {
		t.Fatalf("canais=%v criados(201)=%d ok=%d", ids, created, ok)
	}
	var count int
	if err := e.pool.QueryRow(t.Context(), `SELECT count(*) FROM channel_recipients r JOIN channels c ON c.id = r.channel_id
		WHERE c.type = 3 AND r.user_id IN ($1::bigint, $2::bigint)`, a.id, b.id).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("o banco tem %d participações de DM 1:1 (esperado 2: um canal)", count)
	}
}

func TestDMMessagesRealtimeAndAccess(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) { p4Cfg(d); d.MsgLimiter = nil })
	a, b, c := e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "c")
	friends(t, "Msgs", a, b, c)
	bc, _ := b.connectReady(t)
	cc, _ := c.connectReady(t)

	dm := a.openDM(t, b.id, 201)
	id := str(dm, "id")
	created := payload(t, bc.event("CHANNEL_CREATE")) // B recebe o canal sem recarregar
	if str(created, "id") != id || num(created, "type") != 3 || !sameIDs(recipientIDs(created), a.id, b.id) {
		t.Fatalf("CHANNEL_CREATE = %v", created)
	}
	cc.noEvent(100*time.Millisecond, "CHANNEL_CREATE", "MESSAGE_CREATE")

	// mensagem em tempo real para o outro participante, sem vazar para terceiros
	m := a.say(t, id, "oi, b", 201)
	got := payload(t, bc.event("MESSAGE_CREATE"))
	if str(got, "content") != "oi, b" || str(got, "channel_id") != id || str(obj2(got, "author"), "id") != a.id {
		t.Fatalf("MESSAGE_CREATE = %v", got)
	}
	cc.noEvent(150*time.Millisecond, "MESSAGE_CREATE")

	// B responde; edição e exclusão só do autor (nada de MANAGE_MESSAGES em DM)
	rep := b.say(t, id, "oi, a", 201)
	a.call(t, "PATCH", "/api/channels/"+id+"/messages/"+str(m, "id"), J{"content": "oi, b (editada)"}, 200)
	if str(payload(t, bc.event("MESSAGE_UPDATE")), "content") != "oi, b (editada)" {
		t.Fatal("MESSAGE_UPDATE")
	}
	b.call(t, "PATCH", "/api/channels/"+id+"/messages/"+str(m, "id"), J{"content": "x"}, 403)
	b.call(t, "DELETE", "/api/channels/"+id+"/messages/"+str(m, "id"), nil, 403)
	a.call(t, "DELETE", "/api/channels/"+id+"/messages/"+str(rep, "id"), nil, 403)
	a.call(t, "DELETE", "/api/channels/"+id+"/messages/"+str(m, "id"), nil, 204)
	del := payload(t, bc.event("MESSAGE_DELETE"))
	if str(del, "id") != str(m, "id") || str(del, "channel_id") != id {
		t.Fatalf("MESSAGE_DELETE = %v", del)
	}
	if _, has := del["guild_id"]; has {
		t.Fatalf("DM não tem guild_id: %v", del)
	}

	// quem não participa recebe 404 em tudo, inclusive no histórico
	c.call(t, "GET", "/api/channels/"+id+"/messages", nil, 404)
	c.call(t, "POST", "/api/channels/"+id+"/messages", J{"content": "intruso"}, 404)
	c.call(t, "PATCH", "/api/channels/"+id+"/messages/"+str(rep, "id"), J{"content": "x"}, 404)
	c.call(t, "DELETE", "/api/channels/"+id+"/messages/"+str(rep, "id"), nil, 404)
	c.call(t, "PATCH", "/api/channels/"+id, J{"name": "x"}, 404)
	c.call(t, "DELETE", "/api/channels/"+id, nil, 404)

	// histórico para os participantes
	hist := obj(t, b.call(t, "GET", "/api/channels/"+id+"/messages", nil, 200))
	if ms := list(hist, "messages"); len(ms) != 1 || str(ms[0], "content") != "oi, a" {
		t.Fatalf("histórico = %v", hist)
	}

	// limite de 5 mensagens a cada 5 s também vale em DM
	var limited int
	for i := 0; i < 8; i++ {
		resp, _ := a.do(t, "POST", "/api/channels/"+id+"/messages", J{"content": "spam"})
		if resp.StatusCode == 429 {
			limited++
			if resp.Header.Get("Retry-After") == "" {
				t.Fatal("429 sem Retry-After")
			}
		}
	}
	if limited == 0 {
		t.Fatal("deveria haver 429 depois de 5 mensagens rápidas")
	}
}

func TestDMListOrderedByActivityWithLastMessage(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b, c := e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "c")
	friends(t, "Lista", a, b, c)
	first := a.openDM(t, b.id, 201)
	second := a.openDM(t, c.id, 201)
	grp := a.newGroup(t, 201, b.id, c.id)

	ids := func() []string {
		var out []string
		for _, ch := range arr(t, a.call(t, "GET", "/api/users/@me/channels", nil, 200)) {
			out = append(out, str(ch, "id"))
		}
		return out
	}
	want := []string{str(grp, "id"), str(second, "id"), str(first, "id")} // sem mensagens: pela criação
	if strings.Join(ids(), ",") != strings.Join(want, ",") {
		t.Fatalf("ordem inicial = %v, esperado %v", ids(), want)
	}
	msg := a.say(t, str(first, "id"), "acordei a mais antiga", 201)
	got := arr(t, a.call(t, "GET", "/api/users/@me/channels", nil, 200))
	if str(got[0], "id") != str(first, "id") || str(got[0], "last_message_id") != str(msg, "id") {
		t.Fatalf("a DM com atividade recente vem primeiro: %v", got)
	}
	for _, ch := range got {
		if len(list(ch, "recipients")) < 2 {
			t.Fatalf("a lista traz os participantes: %v", ch)
		}
	}
	// B só vê as DMs de que participa
	if n := len(arr(t, b.call(t, "GET", "/api/users/@me/channels", nil, 200))); n != 2 {
		t.Fatalf("b participa de 2 DMs, listou %d", n)
	}
	// o canal de DM não aparece em /guilds nem a lista mistura canais de servidor
	for _, ch := range got {
		if ch["guild_id"] != nil {
			t.Fatalf("DM com guild_id: %v", ch)
		}
	}
}

func TestDMCreationRateLimit(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		p4Cfg(d)
		d.DMLimiter = ratelimit.New(1.0/60, 3) // 3 criações por minuto, para o teste ser curto
	})
	a := e.newActor(t, "a")
	guest := make([]*actor, 4)
	for i := range guest {
		guest[i] = e.newActor(t, "g")
	}
	friends(t, "Limite", append([]*actor{a}, guest...)...)
	for i := 0; i < 3; i++ {
		a.openDM(t, guest[i].id, 201)
	}
	resp, body := a.do(t, "POST", "/api/users/@me/channels", J{"recipient_id": guest[3].id})
	status(t, resp, body, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}
	// outro usuário tem balde próprio
	guest[0].openDM(t, guest[1].id, 201)
}

// ---------- DM em grupo ----------

func TestGroupDMLifecycle(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	o, b, c, d, outsider := e.newActor(t, "dono"), e.newActor(t, "b"), e.newActor(t, "c"), e.newActor(t, "d"), e.newActor(t, "fora")
	friends(t, "Grupo", o, b, c, d)
	outsider.createGuild(t, "Sem relação")
	oc, _ := o.connectReady(t)
	bc, _ := b.connectReady(t)
	cc, _ := c.connectReady(t)
	dc, _ := d.connectReady(t)

	// criar: o criador é o dono; todos os participantes recebem CHANNEL_CREATE
	o.call(t, "POST", "/api/users/@me/channels", J{"recipient_ids": []string{outsider.id, b.id}}, 403) // sem servidor em comum
	grp := o.newGroup(t, 201, b.id, c.id)
	id := str(grp, "id")
	if num(grp, "type") != 4 || str(grp, "owner_id") != o.id || !sameIDs(recipientIDs(grp), o.id, b.id, c.id) {
		t.Fatalf("grupo = %v", grp)
	}
	for _, cl := range []*wsClient{oc, bc, cc} {
		if p := cl.channelEvent("CHANNEL_CREATE", id); !sameIDs(recipientIDs(p), o.id, b.id, c.id) {
			t.Fatalf("CHANNEL_CREATE = %v", p)
		}
	}
	dc.noEvent(100*time.Millisecond, "CHANNEL_CREATE")

	// mensagens em tempo real para todos (e só para eles)
	o.say(t, id, "bem-vindos", 201)
	for _, cl := range []*wsClient{oc, bc, cc} {
		if str(payload(t, cl.event("MESSAGE_CREATE")), "content") != "bem-vindos" {
			t.Fatal("MESSAGE_CREATE do grupo")
		}
	}
	dc.noEvent(100*time.Millisecond, "MESSAGE_CREATE")
	d.call(t, "GET", "/api/channels/"+id+"/messages", nil, 404)

	// só o dono adiciona; convidado sem servidor em comum com o dono é recusado
	b.call(t, "PUT", "/api/channels/"+id+"/recipients/"+d.id, nil, 403)
	o.call(t, "PUT", "/api/channels/"+id+"/recipients/"+outsider.id, nil, 403)
	o.call(t, "PUT", "/api/channels/"+id+"/recipients/abc", nil, 404)
	outsider.call(t, "PUT", "/api/channels/"+id+"/recipients/"+d.id, nil, 404)
	added := obj(t, o.call(t, "PUT", "/api/channels/"+id+"/recipients/"+d.id, nil, 200))
	if !sameIDs(recipientIDs(added), o.id, b.id, c.id, d.id) {
		t.Fatalf("depois de adicionar: %v", added)
	}
	if p := dc.channelEvent("CHANNEL_CREATE", id); len(list(p, "recipients")) != 4 { // o novo recebe o canal
		t.Fatalf("CHANNEL_CREATE do novo participante = %v", p)
	}
	for _, cl := range []*wsClient{oc, bc, cc} { // os demais, a lista nova
		if p := cl.channelEvent("CHANNEL_UPDATE", id); !sameIDs(recipientIDs(p), o.id, b.id, c.id, d.id) {
			t.Fatalf("CHANNEL_UPDATE = %v", p)
		}
	}
	// o histórico inteiro fica visível ao novo participante e ele recebe o que vier
	if ms := list(obj(t, d.call(t, "GET", "/api/channels/"+id+"/messages", nil, 200)), "messages"); len(ms) != 1 {
		t.Fatalf("histórico do novo participante = %v", ms)
	}
	b.say(t, id, "oi, d", 201)
	dc.event("MESSAGE_CREATE")
	o.call(t, "PUT", "/api/channels/"+id+"/recipients/"+d.id, nil, 200) // idempotente, sem eventos
	oc.noEvent(150*time.Millisecond, "CHANNEL_UPDATE")

	// renomear: só o dono
	b.call(t, "PATCH", "/api/channels/"+id, J{"name": "Hackers"}, 403)
	o.call(t, "PATCH", "/api/channels/"+id, J{"name": ""}, 422)
	o.call(t, "PATCH", "/api/channels/"+id, J{"position": 2}, 422)
	renamed := obj(t, o.call(t, "PATCH", "/api/channels/"+id, J{"name": "  Estudo de Go  "}, 200))
	if str(renamed, "name") != "Estudo de Go" {
		t.Fatalf("renomear: %v", renamed)
	}
	for _, cl := range []*wsClient{oc, bc, cc, dc} {
		if p := cl.channelEvent("CHANNEL_UPDATE", id); str(p, "name") != "Estudo de Go" {
			t.Fatalf("CHANNEL_UPDATE do nome = %v", p)
		}
	}

	// remover: só o dono; o removido perde o canal e NÃO recebe mais mensagens
	b.call(t, "DELETE", "/api/channels/"+id+"/recipients/"+c.id, nil, 403)
	o.call(t, "DELETE", "/api/channels/"+id+"/recipients/"+o.id, nil, 409) // o dono não é removível
	b.call(t, "DELETE", "/api/channels/"+id+"/recipients/"+o.id, nil, 409)
	o.call(t, "DELETE", "/api/channels/"+id+"/recipients/@me", nil, 409) // nem sai
	o.call(t, "DELETE", "/api/channels/"+id+"/recipients/"+c.id, nil, 204)
	cc.channelEvent("CHANNEL_DELETE", id)
	for _, cl := range []*wsClient{oc, bc, dc} {
		if p := cl.channelEvent("CHANNEL_UPDATE", id); !sameIDs(recipientIDs(p), o.id, b.id, d.id) {
			t.Fatalf("CHANNEL_UPDATE depois de remover = %v", p)
		}
	}
	o.call(t, "DELETE", "/api/channels/"+id+"/recipients/"+c.id, nil, 404) // já removido
	o.say(t, id, "c não vê isto", 201)
	for _, cl := range []*wsClient{oc, bc, dc} {
		cl.event("MESSAGE_CREATE")
	}
	cc.noEvent(200*time.Millisecond, "MESSAGE_CREATE")
	c.call(t, "GET", "/api/channels/"+id+"/messages", nil, 404)
	c.call(t, "POST", "/api/channels/"+id+"/messages", J{"content": "ainda aqui?"}, 404)
	if n := len(arr(t, c.call(t, "GET", "/api/users/@me/channels", nil, 200))); n != 0 {
		t.Fatalf("c não deveria mais listar o grupo (%d)", n)
	}

	// sair: participante comum pode (@me); recebe CHANNEL_DELETE e deixa de receber mensagens
	b.call(t, "DELETE", "/api/channels/"+id+"/recipients/@me", nil, 204)
	bc.channelEvent("CHANNEL_DELETE", id)
	for _, cl := range []*wsClient{oc, dc} {
		if p := cl.channelEvent("CHANNEL_UPDATE", id); !sameIDs(recipientIDs(p), o.id, d.id) {
			t.Fatalf("CHANNEL_UPDATE depois da saída = %v", p)
		}
	}
	d.say(t, id, "só nós dois", 201)
	oc.event("MESSAGE_CREATE")
	bc.noEvent(200*time.Millisecond, "MESSAGE_CREATE")
	b.call(t, "DELETE", "/api/channels/"+id+"/recipients/@me", nil, 404) // já saiu
}

func TestGroupDMLimits(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	owner := e.newActor(t, "dono")
	guests := make([]*actor, 10)
	all := []*actor{owner}
	for i := range guests {
		guests[i] = e.newActor(t, "g")
		all = append(all, guests[i])
	}
	friends(t, "Lotado", all...)
	ids := func(from, to int) []string {
		var out []string
		for _, g := range guests[from:to] {
			out = append(out, g.id)
		}
		return out
	}

	owner.call(t, "POST", "/api/users/@me/channels", J{"recipient_ids": ids(0, 10)}, 422) // 11 participantes
	owner.call(t, "POST", "/api/users/@me/channels", J{"recipient_ids": []string{owner.id, guests[0].id}}, 422)
	owner.call(t, "POST", "/api/users/@me/channels", J{"recipient_ids": []string{"abc"}}, 422)
	grp := owner.newGroup(t, 201, ids(0, 9)...) // dono + 9 = 10: no limite
	if n := len(list(grp, "recipients")); n != 10 {
		t.Fatalf("participantes = %d", n)
	}
	owner.call(t, "PUT", "/api/channels/"+str(grp, "id")+"/recipients/"+guests[9].id, nil, 409) // o 11º
	// abrir vaga e entrar
	owner.call(t, "DELETE", "/api/channels/"+str(grp, "id")+"/recipients/"+guests[0].id, nil, 204)
	owner.call(t, "PUT", "/api/channels/"+str(grp, "id")+"/recipients/"+guests[9].id, nil, 200)

	// DM 1:1 não aceita participantes nem nome
	dm := owner.openDM(t, guests[0].id, 201)
	owner.call(t, "PUT", "/api/channels/"+str(dm, "id")+"/recipients/"+guests[1].id, nil, 422)
	owner.call(t, "DELETE", "/api/channels/"+str(dm, "id")+"/recipients/@me", nil, 422)
	owner.call(t, "PATCH", "/api/channels/"+str(dm, "id"), J{"name": "x"}, 422)
}

func TestGroupDMAddRaceRespectsLimit(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	owner := e.newActor(t, "dono")
	all := []*actor{owner}
	for i := 0; i < 8; i++ {
		all = append(all, e.newActor(t, "g"))
	}
	friends(t, "Corrida", all...)
	grp := owner.newGroup(t, 201, all[1].id, all[2].id, all[3].id, all[4].id, all[5].id, all[6].id) // 7 participantes
	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	for _, g := range all[7:] { // 2 candidatos a mais; só cabem 3 vagas, então ambos entram
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, _ := owner.do(t, "PUT", "/api/channels/"+str(grp, "id")+"/recipients/"+g.id, nil)
			mu.Lock()
			codes[resp.StatusCode]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if codes[200] != 2 {
		t.Fatalf("códigos = %v", codes)
	}
	// agora com 9: três tentativas simultâneas para 1 vaga
	extra := []*actor{e.newActor(t, "x1"), e.newActor(t, "x2"), e.newActor(t, "x3")}
	for _, x := range extra {
		x.join(t, owner, owner.createGuild(t, "extra").id)
	}
	codes = map[int]int{}
	for _, x := range extra {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, _ := owner.do(t, "PUT", "/api/channels/"+str(grp, "id")+"/recipients/"+x.id, nil)
			mu.Lock()
			codes[resp.StatusCode]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if codes[200] != 1 || codes[409] != 2 {
		t.Fatalf("1 vaga para 3 concorrentes: %v", codes)
	}
	var n int
	if err := e.pool.QueryRow(t.Context(), `SELECT count(*) FROM channel_recipients WHERE channel_id = $1::bigint`, str(grp, "id")).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 10 {
		t.Fatalf("o grupo tem %d participantes, esperado 10", n)
	}
}

// Mensagens de servidor continuam funcionando ao lado das DMs (regressão).
func TestServerMessagesStillWorkNextToDMs(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, b := e.newActor(t, "a"), e.newActor(t, "b")
	g := friends(t, "Regressão", a, b)
	bc, ready := b.connectReady(t)
	if len(list(ready, "guilds")) != 1 {
		t.Fatalf("READY = %v", ready)
	}
	dm := a.openDM(t, b.id, 201)
	a.say(t, g.textID, "no servidor", 201)
	a.say(t, str(dm, "id"), "na DM", 201)
	got := map[string]string{}
	for len(got) < 2 {
		f := bc.event("MESSAGE_CREATE")
		p := payload(t, f)
		got[str(p, "channel_id")] = str(p, "content")
	}
	if got[g.textID] != "no servidor" || got[str(dm, "id")] != "na DM" {
		t.Fatalf("mensagens = %v", got)
	}
	// moderação em canal de servidor segue valendo: o dono apaga mensagem alheia
	m := b.say(t, g.textID, "apague-me", 201)
	a.call(t, "DELETE", "/api/channels/"+g.textID+"/messages/"+str(m, "id"), nil, 204)
	// canal de servidor não vira "DM": participantes/rename só existem para DMs
	a.call(t, "PUT", "/api/channels/"+g.textID+"/recipients/"+b.id, nil, 404)
	a.call(t, "PATCH", "/api/channels/"+g.textID, J{"name": "geral2"}, 200)
}

func mustInt(t *testing.T, s string) int64 {
	t.Helper()
	var n int64
	for _, r := range s {
		n = n*10 + int64(r-'0')
	}
	return n
}
