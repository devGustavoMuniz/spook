//go:build integration

package app

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func (a *actor) setPresence(t *testing.T, body J, want int) J {
	t.Helper()
	return obj(t, a.call(t, "PATCH", "/api/users/@me/presence", body, want))
}

func (a *actor) putSetting(t *testing.T, scope, target string, body J, want int) J {
	t.Helper()
	return obj(t, a.call(t, "PUT", "/api/users/@me/notification-settings/"+scope+"/"+target, body, want))
}

func (a *actor) settings(t *testing.T) []J {
	t.Helper()
	return list(obj(t, a.call(t, "GET", "/api/users/@me/notification-settings", nil, 200)), "settings")
}

// presenceCustom lê até chegar PRESENCE_UPDATE de user com o status e devolve o payload.
func (c *wsClient) presenceFull(user, status string) J {
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
				return p
			}
		}
	}
	c.t.Fatalf("PRESENCE_UPDATE %s=%s não chegou", user, status)
	return nil
}

func asJ(v any) J {
	m, _ := v.(map[string]any)
	return m
}

func TestStatusRoutesRequireAuth(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/users/@me/presence"}, {"PATCH", "/api/users/@me/presence"},
		{"GET", "/api/users/@me/notification-settings"},
		{"PUT", "/api/users/@me/notification-settings/guild/1"}, {"DELETE", "/api/users/@me/notification-settings/guild/1"},
	} {
		resp, b := e.do(t, r.method, r.path, J{}, nil)
		status(t, resp, b, 401)
	}
}

func TestDNDInvisibleAndCustomStatusReachOthersAndSyncSessions(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	a, b := e.newActor(t, "ana"), e.newActor(t, "beto")
	g := friends(t, "Status", a, b)
	bc, _ := b.connectReady(t)
	ac, ready := a.connectReady(t)
	bc.presence(a.id, "online")
	if sp := asJ(ready["self_presence"]); str(sp, "status_pref") != "online" {
		t.Fatalf("self_presence no READY: %v", ready["self_presence"])
	}
	ac2, _ := a.connectReady(t) // segunda aba da Ana

	// Não perturbar + status personalizado: Beto vê dnd com o status; a outra aba da Ana é avisada.
	exp := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	out := a.setPresence(t, J{"status_pref": "dnd", "custom_status": J{"text": "em foco", "emoji": "🎧", "expires_at": exp}}, 200)
	if str(out, "status_pref") != "dnd" {
		t.Fatalf("resposta: %v", out)
	}
	p := bc.presenceFull(a.id, "dnd")
	cs, _ := p["custom_status"].(map[string]any)
	if cs == nil || str(cs, "text") != "em foco" || str(cs, "emoji") != "🎧" {
		t.Fatalf("custom_status: %v", p)
	}
	self := payload(t, ac2.event("PRESENCE_SELF_UPDATE"))
	if str(self, "status_pref") != "dnd" {
		t.Fatalf("PRESENCE_SELF_UPDATE: %v", self)
	}
	_ = ac

	// Quem entra depois recebe o status no snapshot do READY.
	c := e.newActor(t, "carla")
	c.join(t, a, g.id)
	_, cr := c.connectReady(t)
	found := false
	for _, p := range list(cr, "presences") {
		if str(p, "user_id") == a.id && str(p, "status") == "dnd" {
			found = true
		}
	}
	if !found {
		t.Fatalf("snapshot sem o dnd: %v", cr["presences"])
	}

	// Invisível: os outros veem offline, mesmo com a sessão conectada.
	a.setPresence(t, J{"status_pref": "invisible", "clear_custom_status": true}, 200)
	bc.presenceFull(a.id, "offline")
	d, dr := c.connectReady(t) // outro cliente conecta depois: não vê a Ana
	_ = d
	for _, p := range list(dr, "presences") {
		if str(p, "user_id") == a.id {
			t.Fatalf("invisível apareceu no snapshot: %v", p)
		}
	}
	// Persistência: nova sessão da Ana volta invisível e sem status personalizado.
	_, ar := a.connectReady(t)
	if sp := asJ(ar["self_presence"]); str(sp, "status_pref") != "invisible" || sp["custom_status"] != nil {
		t.Fatalf("self_presence persistido: %v", ar["self_presence"])
	}

	// Validação.
	a.setPresence(t, J{"status_pref": "away"}, 422)
	a.setPresence(t, J{"custom_status": J{"text": "x", "expires_at": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)}}, 422)
	a.setPresence(t, J{"custom_status": J{}}, 422)
}

func TestNotificationSettingsCRUDAuthorizationAndSync(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member, stranger := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "estranho")
	g := friends(t, "Silêncio", owner, member)

	mc, ready := member.connectReady(t)
	if n := len(list(ready, "notification_settings")); n != 0 {
		t.Fatalf("READY inicial: %v", ready["notification_settings"])
	}
	mc2, _ := member.connectReady(t)

	until := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	p := member.putSetting(t, "guild", g.id, J{"muted": true, "muted_until": until, "level": "mentions"}, 200)
	if p["muted"] != true || str(p, "level") != "mentions" || p["muted_until"] == nil {
		t.Fatalf("put guild: %v", p)
	}
	ev := payload(t, mc2.event("NOTIFICATION_SETTINGS_UPDATE"))
	if str(ev, "scope") != "guild" || str(ev, "target_id") != g.id || ev["muted"] != true {
		t.Fatalf("evento: %v", ev)
	}
	member.putSetting(t, "channel", g.textID, J{"muted": true}, 200) // até reativar
	if s := member.settings(t); len(s) != 2 {
		t.Fatalf("lista: %v", s)
	}
	_, ready2 := member.connectReady(t)
	if n := len(list(ready2, "notification_settings")); n != 2 {
		t.Fatalf("READY: %v", ready2["notification_settings"])
	}
	_ = mc

	// Autorização e validação.
	stranger.putSetting(t, "guild", g.id, J{"muted": true}, 404)
	stranger.putSetting(t, "channel", g.textID, J{"muted": true}, 404)
	member.putSetting(t, "guild", g.id, J{"muted": true, "muted_until": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)}, 422)
	member.putSetting(t, "guild", g.id, J{"level": "tudo"}, 422)
	member.putSetting(t, "guild", "abc", J{"muted": true}, 404)

	// Voltar ao padrão.
	member.call(t, "DELETE", "/api/users/@me/notification-settings/channel/"+g.textID, nil, 204)
	member.call(t, "DELETE", "/api/users/@me/notification-settings/channel/"+g.textID, nil, 204) // idempotente
	member.putSetting(t, "guild", g.id, J{}, 200)                                                // sem nada = padrão
	if s := member.settings(t); len(s) != 0 {
		t.Fatalf("depois de resetar: %v", s)
	}
}

func TestPushHonorsDNDMuteAndLevelButCountsStillGrow(t *testing.T) {
	fp := newFakePush(t)
	e := pushEnv(t, fp)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Push filtrado", owner, member)
	member.subscribe(t, fp.endpoint("membro"), 204)
	mention := fmt.Sprintf("@%s oi", member.name)

	// Não perturbar (sem sessão aberta): nada de push, mas a menção conta.
	member.setPresence(t, J{"status_pref": "dnd"}, 200)
	owner.say(t, g.textID, mention, 201)
	member.waitCounts(t, g.textID, 1, 1)
	fp.quiet(t, 1200*time.Millisecond)
	member.setPresence(t, J{"status_pref": "online"}, 200)

	// Canal silenciado.
	member.putSetting(t, "channel", g.textID, J{"muted": true}, 200)
	owner.say(t, g.textID, mention, 201)
	member.waitCounts(t, g.textID, 2, 2)
	fp.quiet(t, 1200*time.Millisecond)
	member.call(t, "DELETE", "/api/users/@me/notification-settings/channel/"+g.textID, nil, 204)

	// Servidor em "nada".
	member.putSetting(t, "guild", g.id, J{"level": "none"}, 200)
	owner.say(t, g.textID, mention, 201)
	member.waitCounts(t, g.textID, 3, 3)
	fp.quiet(t, 1200*time.Millisecond)

	// O canal sobrepõe o servidor: "só menções" no canal volta a avisar quem foi citado.
	member.putSetting(t, "channel", g.textID, J{"level": "mentions"}, 200)
	owner.say(t, g.textID, mention, 201)
	fp.waitHits(t, 1)

	// Silêncio com prazo vale agora; vencido, não vale mais (sem job) — o prazo mínimo aceito é futuro, então
	// o vencimento é conferido com uma linha gravada direto no banco.
	if _, err := e.pool.Exec(context.Background(), `UPDATE notification_settings SET muted = true, muted_until = now() - interval '1 minute' WHERE user_id = $1 AND scope = 'channel'`, mustInt(t, member.id)); err != nil {
		t.Fatal(err)
	}
	owner.say(t, g.textID, mention, 201)
	waitUntil(t, "push com silêncio vencido", func() bool { return fp.count() == 2 })
}
