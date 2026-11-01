//go:build integration

package app

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/gateway"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

// Invisível não pode aparecer online para ninguém, por nenhum caminho (gateway, REST, voz, painel).
// Decisões registradas aqui (ver o relatório da tarefa): digitar e estar em chamada são ações públicas e
// continuam visíveis; o push segue a regra de "tem sessão ativa" (Status() de conexão), não a visão pública.

// presenceKeys são chaves de JSON que revelariam presença/estado de um usuário.
var presenceKeys = map[string]bool{
	"status": true, "presence": true, "presences": true, "custom_status": true, "status_pref": true,
	"last_seen": true, "last_seen_at": true, "online": true, "is_online": true, "idle": true,
}

// noPresenceKeys falha se o JSON tiver alguma chave de presença em qualquer nível.
func noPresenceKeys(t *testing.T, label string, raw []byte) {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%s: JSON inválido: %v", label, err)
	}
	var walk func(path string, v any)
	walk = func(path string, v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, c := range x {
				if presenceKeys[k] {
					t.Fatalf("%s: campo de presença %q em %s: %s", label, k, path, raw)
				}
				walk(path+"."+k, c)
			}
		case []any:
			for _, c := range x {
				walk(path+"[]", c)
			}
		}
	}
	walk("$", v)
}

// readyHas diz se o READY lista presença do usuário.
func readyHas(ready J, user string) (J, bool) {
	for _, p := range list(ready, "presences") {
		if str(p, "user_id") == user {
			return p, true
		}
	}
	return nil, false
}

// finalView lê durante d e devolve o status mais recente de user (começando por init, "" = ausente do READY).
func (c *wsClient) finalView(user, init string, d time.Duration) string {
	c.t.Helper()
	cur := init
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			break
		}
		if isEvent(f, "PRESENCE_UPDATE") {
			if p := payload(c.t, f); str(p, "user_id") == user {
				cur = str(p, "status")
			}
		}
	}
	return cur
}

// invFixture: inv e a dividem servidor e DM; b tem outro servidor sem relação.
type invFixture struct {
	e         *testEnv
	inv, a, b *actor
	g, gb     guildFixture
	dm        string
}

func newInvFixture(t *testing.T, e *testEnv) *invFixture {
	t.Helper()
	f := &invFixture{e: e, inv: e.newActor(t, "inv"), a: e.newActor(t, "obsa"), b: e.newActor(t, "obsb")}
	f.g = friends(t, "Invisível", f.a, f.inv)
	f.gb = f.b.createGuild(t, "Outro")
	f.dm = str(f.a.openDM(t, f.inv.id, 201), "id")
	return f
}

func TestInvisibleNeverLooksOnlineToOthers(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	f := newInvFixture(t, e)
	inv, a, b := f.inv, f.a, f.b

	// Invisível ANTES de conectar, com status personalizado (não pode vazar).
	out := inv.setPresence(t, J{"status_pref": "invisible", "custom_status": J{"text": "segredo", "emoji": "🙈"}}, 200)
	if str(out, "status_pref") != "invisible" {
		t.Fatalf("PATCH: %v", out)
	}
	ac, _ := a.connectReady(t)
	bc, _ := b.connectReady(t)

	ic, ir := inv.connectReady(t)
	if sp := asJ(ir["self_presence"]); str(sp, "status_pref") != "invisible" {
		t.Fatalf("self_presence do próprio: %v", ir["self_presence"])
	}
	// Idle, volta de ausente, mensagem em servidor e DM, digitação: nada revela presença.
	ic.setStatus("idle")
	ic.setStatus("online")
	inv.say(t, f.g.textID, "oi servidor", 201)
	inv.say(t, f.dm, "oi dm", 201)
	inv.call(t, "POST", "/api/channels/"+f.g.textID+"/typing", nil, 204)
	ac.noPresence(inv.id, 800*time.Millisecond)
	bc.noPresence(inv.id, 100*time.Millisecond)

	// Nova aba e reconexão do invisível: ainda nada (e nenhum custom_status vaza em outro evento).
	ic2, _ := inv.connectReady(t)
	_ = ic.ws.CloseNow()
	ic2.setStatus("idle")
	ac.noPresence(inv.id, 600*time.Millisecond)

	// READY de terceiros: nem inv, nem com status personalizado.
	_, ar := a.connectReady(t)
	if p, ok := readyHas(ar, inv.id); ok {
		t.Fatalf("invisível no READY do observador: %v", p)
	}
	_, br := b.connectReady(t)
	if p, ok := readyHas(br, inv.id); ok {
		t.Fatalf("invisível no READY do estranho: %v", p)
	}

	// Queda além da tolerância e reconexão: não pisca online (Self antes do Connect).
	_ = ic2.ws.CloseNow()
	time.Sleep(testGrace + 400*time.Millisecond)
	ic3, _ := inv.connectReady(t)
	ac.noPresence(inv.id, 600*time.Millisecond)

	// RESUME depois que a presença já expirou (Connect sem READY): também não pode piscar online.
	rcA := inv.connect(t)
	sid, _ := rcA.identify()
	_ = ic3.ws.CloseNow()
	_ = rcA.ws.CloseNow()
	time.Sleep(testGrace + 600*time.Millisecond) // a presença do inv expira (sem sessão viva)
	rc := inv.connect(t)
	rc.must() // HELLO
	rc.send(gateway.OpResume, gateway.Resume{SessionID: sid, Seq: 1})
	_ = rc.must() // RESUMED (ou INVALID_SESSION; em ambos o Connect não pode pintar online)
	ac.noPresence(inv.id, 700*time.Millisecond)

	// O próprio inv recebe o estado real: visível de novo publica online; invisível publica offline.
	self := inv.connect(t)
	self.identify()
	inv.setPresence(t, J{"status_pref": "online"}, 200)
	if got := payload(t, self.event("PRESENCE_SELF_UPDATE")); str(got, "status_pref") != "online" {
		t.Fatalf("PRESENCE_SELF_UPDATE: %v", got)
	}
	ac.presenceFull(inv.id, "online")
	inv.setPresence(t, J{"status_pref": "invisible"}, 200)
	if got := payload(t, self.event("PRESENCE_SELF_UPDATE")); str(got, "status_pref") != "invisible" || got["custom_status"] == nil {
		// o custom_status foi gravado antes e segue valendo para o próprio (só os outros não veem)
		t.Fatalf("PRESENCE_SELF_UPDATE: %v", got)
	}
	p := ac.presenceFull(inv.id, "offline")
	if p["custom_status"] != nil {
		t.Fatalf("custom_status vazou no offline: %v", p)
	}
	bc.noPresence(inv.id, 200*time.Millisecond)
}

func TestVisibleToInvisibleTransitionAndSnapshotRace(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	f := newInvFixture(t, e)
	inv, a := f.inv, f.a
	ac, _ := a.connectReady(t)
	ic, _ := inv.connectReady(t)
	ac.presenceFull(inv.id, "online")
	inv.setPresence(t, J{"custom_status": J{"text": "visível"}}, 200)
	ac.presenceFull(inv.id, "online")

	// online -> invisível: o observador recebe offline sem custom_status e nenhum online depois.
	inv.setPresence(t, J{"status_pref": "invisible"}, 200)
	p := ac.presenceFull(inv.id, "offline")
	if p["custom_status"] != nil {
		t.Fatalf("custom_status vazou: %v", p)
	}
	ic.setStatus("idle")
	ic.setStatus("online")
	inv.say(t, f.dm, "ainda invisível", 201)
	ac.noPresence(inv.id, 700*time.Millisecond)

	// Corrida: o inv fica invisível enquanto o observador abre o READY. A visão final tem que ser offline.
	for i := 0; i < 12; i++ {
		inv.setPresence(t, J{"status_pref": "online"}, 200)
		ac.presenceFull(inv.id, "online")
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			inv.setPresence(t, J{"status_pref": "invisible"}, 200)
		}()
		oc := a.connect(t)
		_, ready := oc.identify()
		init := ""
		if p, ok := readyHas(ready, inv.id); ok {
			init = str(p, "status")
		}
		wg.Wait()
		if got := oc.finalView(inv.id, init, 500*time.Millisecond); got != "offline" && got != "" {
			t.Fatalf("iteração %d: o observador ficou vendo %q depois de o inv ficar invisível", i, got)
		}
		_ = oc.ws.CloseNow()
	}
}

func TestInvisibleTypingIsAnExplicitActionAndDoesNotCreatePresence(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	f := newInvFixture(t, e)
	inv, a := f.inv, f.a
	inv.setPresence(t, J{"status_pref": "invisible"}, 200)
	ac, _ := a.connectReady(t)
	inv.connectReady(t)

	// Decisão: o indicador de digitação continua (como no Discord); é uma ação explícita na conversa.
	inv.call(t, "POST", "/api/channels/"+f.g.textID+"/typing", nil, 204)
	ev := payload(t, ac.event("TYPING_START"))
	if str(ev, "user_id") != inv.id || str(ev, "channel_id") != f.g.textID {
		t.Fatalf("TYPING_START: %v", ev)
	}
	noPresenceKeys(t, "TYPING_START", mustJSON(t, ev))
	inv.call(t, "POST", "/api/channels/"+f.dm+"/typing", nil, 204)
	ac.event("TYPING_START")
	ac.noPresence(inv.id, 600*time.Millisecond) // digitar não cria presença online
	// e a visão pública segue offline para quem entra agora
	_, ar := a.connectReady(t)
	if p, ok := readyHas(ar, inv.id); ok {
		t.Fatalf("READY depois de digitar: %v", p)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestInvisibleLeaksNothingThroughRESTPayloads(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	f := newInvFixture(t, e)
	inv, a := f.inv, f.a
	inv.setPresence(t, J{"status_pref": "invisible", "custom_status": J{"text": "segredo", "emoji": "🙈"}}, 200)
	inv.connectReady(t)
	a.connectReady(t)

	check := func(label string, raw []byte) {
		t.Helper()
		noPresenceKeys(t, label, raw)
		if s := string(raw); strings.Contains(s, "segredo") || strings.Contains(s, "🙈") || strings.Contains(s, "invisible") {
			t.Fatalf("%s: vazou o status personalizado/preferência: %s", label, raw)
		}
	}
	check("membros", a.call(t, "GET", "/api/guilds/"+f.g.id+"/members", nil, 200))
	check("detalhe do servidor", a.call(t, "GET", "/api/guilds/"+f.g.id, nil, 200))
	check("lista de servidores", a.call(t, "GET", "/api/guilds", nil, 200))
	check("DMs", a.call(t, "GET", "/api/users/@me/channels", nil, 200))
	check("abrir DM", a.call(t, "POST", "/api/users/@me/channels", J{"recipient_id": inv.id}, 200))
	inv.say(t, f.g.textID, "mensagem do invisível", 201)
	check("mensagens do servidor", a.call(t, "GET", "/api/channels/"+f.g.textID+"/messages", nil, 200))
	check("mensagens da DM", a.call(t, "GET", "/api/channels/"+f.dm+"/messages", nil, 200))
	code := a.invite(t, f.g.id)
	check("convite", f.b.call(t, "GET", "/api/invites/"+code, nil, 200))
	// Nenhuma rota de perfil de terceiros existe (não há /users/{id}).
	resp, bb := a.do(t, "GET", "/api/users/"+inv.id, nil)
	if resp.StatusCode == 200 {
		check("/users/{id}", bb)
	}
	// O que é do próprio usuário (PATCH/GET de presença) só responde para ele.
	if got := obj(t, inv.call(t, "GET", "/api/users/@me/presence", nil, 200)); str(got, "status_pref") != "invisible" {
		t.Fatalf("presença do próprio: %v", got)
	}
	if got := obj(t, a.call(t, "GET", "/api/users/@me/presence", nil, 200)); str(got, "status_pref") != "online" {
		t.Fatalf("a presença de a não pode refletir a de inv: %v", got)
	}
}

func TestInvisibleStaysVisibleInVoiceAndVoiceIsNotPresence(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, func(d *Deps) {
		voiceCfg(lkf)(d)
		d.Presence = presence.Config{OfflineGrace: testGrace}
	})
	f := newInvFixture(t, e)
	inv, a := f.inv, f.a
	inv.setPresence(t, J{"status_pref": "invisible"}, 200)
	ac, _ := a.connectReady(t)
	inv.connectReady(t)

	// Decisão: estar em chamada é público (como no Discord). Entrar na voz publica o estado de voz...
	inv.voiceToken(t, f.g.voiceID, 200)
	e.lkJoin(t, f.g.voiceID, inv)
	p := ac.voiceUpdateFor(inv.id)
	if str(p, "channel_id") != f.g.voiceID {
		t.Fatalf("VOICE_STATE_UPDATE: %v", p)
	}
	noPresenceKeys(t, "VOICE_STATE_UPDATE", mustJSON(t, p))
	// ...mas isso não vira presença online.
	ac.noPresence(inv.id, 600*time.Millisecond)
	states := a.call(t, "GET", "/api/guilds/"+f.g.id+"/voice-states", nil, 200)
	noPresenceKeys(t, "voice-states", states)
	if got := arr(t, states); len(got) != 1 || str(got[0], "user_id") != inv.id {
		t.Fatalf("o invisível segue na lista de participantes: %v", got)
	}
	// Ficar invisível DENTRO da chamada também não tira nem esconde o participante.
	inv.setPresence(t, J{"status_pref": "online"}, 200)
	ac.presenceFull(inv.id, "online")
	inv.setPresence(t, J{"status_pref": "invisible"}, 200)
	ac.presenceFull(inv.id, "offline")
	if got := arr(t, a.call(t, "GET", "/api/guilds/"+f.g.id+"/voice-states", nil, 200)); len(got) != 1 || str(got[0], "user_id") != inv.id {
		t.Fatalf("participante sumiu ao ficar invisível: %v", got)
	}
	_, ar := a.connectReady(t)
	if _, ok := readyHas(ar, inv.id); ok {
		t.Fatalf("voz virou presença no READY: %v", ar["presences"])
	}
	vs := list(ar, "voice_states")
	if len(vs) != 1 || str(vs[0], "user_id") != inv.id {
		t.Fatalf("READY.voice_states: %v", ar["voice_states"])
	}
	// Sair da chamada: o evento de saída chega e não há presença.
	e.lkEvent(t, "participant_left", f.g.voiceID, inv, nil)
	if p := ac.voiceUpdateFor(inv.id); p["channel_id"] != nil {
		t.Fatalf("saída da voz: %v", p)
	}
	ac.noPresence(inv.id, 400*time.Millisecond)
}

func TestInvisiblePushFollowsTheConnectionRuleNotThePublicView(t *testing.T) {
	fp := newFakePush(t)
	e := pushEnv(t, fp, p4Cfg)
	f := newInvFixture(t, e)
	inv, a := f.inv, f.a
	inv.subscribe(t, fp.endpoint("inv"), 204)
	inv.setPresence(t, J{"status_pref": "invisible"}, 200)

	// (a) Com sessão aberta: aviso in-app pelo gateway e NENHUM push (igual a qualquer usuário online).
	ic, _ := inv.connectReady(t)
	a.say(t, f.dm, "oi, tem alguém?", 201)
	ic.event("READ_STATE_UPDATE")
	fp.quiet(t, 1500*time.Millisecond)

	// (b) Sem sessão (app fechado): o push chega normalmente — invisível não suprime push.
	_ = ic.ws.CloseNow()
	time.Sleep(testGrace + 400*time.Millisecond)
	a.say(t, f.dm, "voltou?", 201)
	fp.waitHits(t, 1)

	// (c) Não perturbar substitui invisível (a preferência é uma só): sem push.
	inv.setPresence(t, J{"status_pref": "dnd"}, 200)
	a.say(t, f.dm, "ainda aí?", 201)
	time.Sleep(1200 * time.Millisecond)
	if n := fp.count(); n != 1 {
		t.Fatalf("com DND não deveria haver push novo (total %d)", n)
	}
	// De volta a invisível: o push volta.
	inv.setPresence(t, J{"status_pref": "invisible"}, 200)
	a.say(t, f.dm, "agora sim", 201)
	fp.waitHits(t, 2)
	time.Sleep(500 * time.Millisecond)
	if n := fp.count(); n != 2 {
		t.Fatalf("esperava 2 pushes, houve %d", n)
	}
}

func TestInvisibleAdminPanelIsAdminOnlyAndCountsConnections(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	f := newInvFixture(t, e)
	inv, adm := f.inv, e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	inv.setPresence(t, J{"status_pref": "invisible", "custom_status": J{"text": "segredo"}}, 200)
	inv.connectReady(t)

	for _, p := range adminRoutes {
		f.a.call(t, "GET", p, nil, 403) // quem não é admin não vê nada, nem a contagem
		raw := adm.call(t, "GET", p, nil, 200)
		// O painel só agrega: nem a preferência nem o status personalizado de ninguém aparecem.
		for _, bad := range []string{"invisible", "status_pref", "custom_status", "segredo"} {
			if strings.Contains(string(raw), bad) {
				t.Fatalf("%s expõe %q: %s", p, bad, raw)
			}
		}
	}
	// Decisão: o painel conta conexões vivas (inclui invisíveis, é uma contagem de infraestrutura).
	s := obj(t, adm.call(t, "GET", "/api/admin/system", nil, 200))
	if gw := asJ(s["gateway"]); num(gw, "online_users") < 1 {
		t.Fatalf("gateway = %v", gw)
	}
}
