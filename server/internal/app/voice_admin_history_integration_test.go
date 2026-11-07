//go:build integration

package app

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	lk "github.com/livekit/protocol/livekit"

	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

// ---------- espectadores da transmissão ----------

func TestScreenWatchViewersEndToEnd(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, voiceCfg(lkf))
	alice, bob, carol := e.newActor(t, "alice"), e.newActor(t, "bob"), e.newActor(t, "carol")
	g := alice.createGuild(t, "Assistir")
	bob.join(t, alice, g.id)
	carol.join(t, alice, g.id)
	watch := func(a *actor, target *actor, method string, want int) {
		t.Helper()
		a.call(t, method, "/api/channels/"+g.voiceID+"/voice/screen-watch/"+target.id, nil, want)
	}
	pathFor := "/api/channels/" + g.voiceID + "/voice/screen-watch/" + alice.id

	// Sem sessão: 401. Fora da chamada: 403.
	resp, b := e.do(t, "PUT", pathFor, nil, nil)
	status(t, resp, b, 401)
	watch(bob, alice, "PUT", 403)

	alice.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, alice)
	bob.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, bob)
	carol.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, carol)
	watch(bob, alice, "PUT", 404) // ainda não transmite
	if s := e.lkEvent(t, "track_published", g.voiceID, alice, func(ev *lk.WebhookEvent) { ev.Track = &lk.TrackInfo{Sid: "TR_S", Source: lk.TrackSource_SCREEN_SHARE} }); s != 200 {
		t.Fatal(s)
	}
	watch(alice, alice, "PUT", 422)
	call404 := e.newActor(t, "forasteiro")
	call404.call(t, "PUT", pathFor, nil, 404) // não vê o canal: nem sabe que ele existe

	ac, _ := alice.connectReady(t)
	defer ac.ws.CloseNow()
	cc, _ := carol.connectReady(t)
	defer cc.ws.CloseNow()
	watch(bob, alice, "PUT", 204)

	// O transmissor recebe a lista; os demais, só a contagem.
	var p J
	waitUntil(t, "evento do transmissor com espectador", func() bool {
		p = ac.voiceUpdateFor(alice.id)
		return num(p, "viewer_count") == 1
	})
	if v, _ := p["viewers"].([]any); len(v) != 1 || v[0] != bob.id {
		t.Fatalf("o transmissor deveria ver bob: %v", p)
	}
	waitUntil(t, "evento do outro membro", func() bool {
		q := cc.voiceUpdateFor(alice.id)
		return num(q, "viewer_count") == 1 && q["viewers"] == nil
	})

	// Snapshot por REST: o transmissor vê a lista; o espectador, só a contagem.
	findAlice := func(a *actor) J {
		for _, s := range arr(t, a.call(t, "GET", "/api/guilds/"+g.id+"/voice-states", nil, 200)) {
			if str(s, "user_id") == alice.id {
				return s
			}
		}
		t.Fatal("alice não está no snapshot")
		return nil
	}
	if s := findAlice(alice); num(s, "viewer_count") != 1 || len(s["viewers"].([]any)) != 1 {
		t.Fatalf("snapshot do transmissor = %v", s)
	}
	if s := findAlice(bob); num(s, "viewer_count") != 1 || s["viewers"] != nil {
		t.Fatalf("snapshot do espectador = %v", s)
	}

	// Heartbeat idempotente, parar de assistir e idempotência do DELETE.
	watch(bob, alice, "PUT", 204)
	watch(carol, alice, "PUT", 204)
	waitUntil(t, "dois espectadores", func() bool { return num(findAlice(alice), "viewer_count") == 2 })
	watch(bob, alice, "DELETE", 204)
	watch(bob, alice, "DELETE", 204)
	waitUntil(t, "um espectador", func() bool { return num(findAlice(alice), "viewer_count") == 1 })

	// Quem sai da chamada deixa de contar.
	carol.call(t, "POST", "/api/voice/leave", nil, 204)
	waitUntil(t, "zero espectadores", func() bool { return num(findAlice(alice), "viewer_count") == 0 })
}

// ---------- reconciliação por webhooks e por job ----------

func TestVoiceReconcileClearsStaleScreenFlag(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, func(d *Deps) {
		voiceCfg(lkf)(d)
		d.VoiceReconcileEvery = 50 * time.Millisecond
	})
	alice := e.newActor(t, "alice")
	g := alice.createGuild(t, "Reconciliar")
	alice.voiceToken(t, g.voiceID, 200)
	// O reconciliador roda a cada 50 ms: o LiveKit falso precisa dizer a verdade (ela está na sala, com tela) desde
	// o início, senão ele a remove como "órfã" antes de o teste publicar a faixa (corrida que derrubava o CI).
	lkf.mu.Lock()
	lkf.rooms = []*lk.Room{{Name: g.voiceID, NumParticipants: 1}}
	lkf.parts[g.voiceID] = []*lk.ParticipantInfo{{Identity: alice.id, Sid: "PA_" + alice.id, Tracks: []*lk.TrackInfo{{Sid: "TR_S", Source: lk.TrackSource_SCREEN_SHARE}}}}
	lkf.mu.Unlock()
	e.lkJoin(t, g.voiceID, alice)
	if s := e.lkEvent(t, "track_published", g.voiceID, alice, func(ev *lk.WebhookEvent) { ev.Track = &lk.TrackInfo{Sid: "TR_S", Source: lk.TrackSource_SCREEN_SHARE} }); s != 200 {
		t.Fatal(s)
	}
	waitUntil(t, "tela ligada", func() bool {
		for _, s := range arr(t, alice.call(t, "GET", "/api/guilds/"+g.id+"/voice-states", nil, 200)) {
			if str(s, "user_id") == alice.id && s["self_screen"] == true {
				return true
			}
		}
		return false
	})
	// O LiveKit diz que ela segue na sala, mas sem tela (o unpublish se perdeu): o reconciliador corrige.
	lkf.mu.Lock()
	lkf.rooms = []*lk.Room{{Name: g.voiceID, NumParticipants: 1}}
	lkf.parts[g.voiceID] = []*lk.ParticipantInfo{{Identity: alice.id, Sid: "PA_" + alice.id, Tracks: []*lk.TrackInfo{{Source: lk.TrackSource_MICROPHONE}}}}
	lkf.mu.Unlock()
	time.Sleep(150 * time.Millisecond)
	waitUntil(t, "tela desligada pelo reconciliador", func() bool {
		for _, s := range arr(t, alice.call(t, "GET", "/api/guilds/"+g.id+"/voice-states", nil, 200)) {
			if str(s, "user_id") == alice.id {
				return s["self_screen"] == false
			}
		}
		return false
	})
}

// Em produção (sem laço local) quem reconcilia é o job `voice_reconcile` do River; o boot também agenda a
// amostra por minuto do histórico, que roda logo na partida (RunOnStart).
func TestAdminSampleJobRunsOnStartWithoutLocalReconciler(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, func(d *Deps) {
		voiceCfg(lkf)(d)
		d.VoiceReconcileEvery = 0 // produção: sem laço local, quem reconcilia é o job
	})
	waitUntil(t, "job de amostragem rodou (RunOnStart)", func() bool {
		var n int
		_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM river_job WHERE kind = 'livekit_sample'`).Scan(&n)
		return n > 0
	})
}

// ---------- admin: histórico, atividade, disco ----------

var newAdminRoutes = []string{
	"/api/admin/livekit/history", "/api/admin/livekit/usage", "/api/admin/gateway/history",
	"/api/admin/activity/heatmap", "/api/admin/servers/top",
}

func TestAdminNewRoutesRequireAdmin(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	plain, adm := e.newActor(t, "comum"), e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	for _, p := range newAdminRoutes {
		resp, b := e.do(t, "GET", p, nil, nil)
		status(t, resp, b, 401)
		b = plain.call(t, "GET", p, nil, 403)
		if !strings.Contains(string(b), "administradores") {
			t.Fatalf("%s: 403 deve ser genérico: %s", p, b)
		}
		adm.call(t, "GET", p, nil, 200)
	}
	adm.call(t, "GET", "/api/admin/livekit/history?range=1y", nil, 422)
}

func insertSample(t *testing.T, e *testEnv, at time.Time, bytesOut, bytesIn float64, participants, users int) {
	t.Helper()
	_, err := e.pool.Exec(context.Background(), `
		INSERT INTO livekit_samples (ts, media, rooms, participants, tracks_published, tracks_subscribed, bytes_in, bytes_out,
		                             packets_in, packets_out, loss_pct, jitter_ms, rtt_ms, online_users, connections)
		VALUES ($1, true, 1, $2, 2, 3, $3, $4, 10, 20, 0.5, 3, 40, $5, $5)`, at.Truncate(time.Minute), participants, bytesIn, bytesOut, users)
	if err != nil {
		t.Fatal(err)
	}
}

func TestAdminLiveKitHistoryUsageAndGatewayHistory(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		notifCfg(d)
		d.Cfg.LiveKit.MonthlyTrafficGB = 0.000004 // 4000 bytes
	})
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	if _, err := e.pool.Exec(context.Background(), `DELETE FROM livekit_samples`); err != nil {
		t.Fatal(err)
	}

	// Sem dados (a amostra do boot pode já existir sem mídia): o painel mostra "coletando" no uso.
	u := obj(t, adm.call(t, "GET", "/api/admin/livekit/usage", nil, 200))
	if u["monthly_limit_bytes"] == nil || num(u, "monthly_limit_bytes") != 4000 {
		t.Fatalf("limite do plano = %v", u["monthly_limit_bytes"])
	}

	// Com amostras: o contador reinicia no meio (3000 → 500): 2000 + 500 + 300 = 2800 bytes de saída.
	// Usa o início do dia corrente para o mês e as últimas 24 h garantirem as amostras.
	now := time.Now().UTC().Truncate(time.Minute)
	base := now.Add(-4 * time.Minute)
	if base.Day() != now.Day() { // virada de dia/mês durante o teste: recua para ficar dentro do mês
		base = now
	}
	insertSample(t, e, base.Add(0*time.Minute), 1000, 100, 2, 4)
	insertSample(t, e, base.Add(1*time.Minute), 3000, 200, 3, 6)
	insertSample(t, e, base.Add(2*time.Minute), 500, 50, 2, 5) // reinício do LiveKit
	insertSample(t, e, base.Add(3*time.Minute), 800, 80, 1, 3)
	// Evita o cache de 1 min do usage: o ambiente é novo, a primeira leitura abaixo é fresca.
	e2 := newEnvWith(t, func(d *Deps) {
		notifCfg(d)
		d.Cfg.LiveKit.MonthlyTrafficGB = 0.000004
	})
	adm2 := e2.newActor(t, "adm")
	e2.makeAdmin(t, adm2)
	u = obj(t, adm2.call(t, "GET", "/api/admin/livekit/usage", nil, 200))
	if got := num(u, "month_bytes_out"); got != 2800 {
		t.Fatalf("tráfego do mês = %v (queria 2800, com o reinício do contador)", got)
	}
	if pct := u["month_pct"]; pct == nil || pct.(float64) != 70 {
		t.Fatalf("month_pct = %v", pct)
	}
	if peak, _ := u["peak_out_24h_per_sec"].(float64); peak < 30 || peak > 40 { // 2000 bytes em 60 s ≈ 33,3 B/s
		t.Fatalf("pico de saída = %v", u["peak_out_24h_per_sec"])
	}

	for _, rng := range []string{"24h", "7d", "30d"} {
		h := obj(t, adm2.call(t, "GET", "/api/admin/livekit/history?range="+rng, nil, 200))
		pts := list(h, "points")
		if len(pts) == 0 || len(pts) > 300 || h["collecting"] != false {
			t.Fatalf("%s: %d pontos, collecting=%v", rng, len(pts), h["collecting"])
		}
		var out int64
		for _, p := range pts {
			out += num(p, "bytes_out")
		}
		if out != 2800 {
			t.Fatalf("%s: soma de saída = %v", rng, out)
		}
		if num(h, "bucket_seconds") <= 0 {
			t.Fatalf("%s: balde = %v", rng, h["bucket_seconds"])
		}
	}
	gh := obj(t, adm2.call(t, "GET", "/api/admin/gateway/history", nil, 200))
	var maxUsers int64
	for _, p := range list(gh, "points") {
		maxUsers = max(maxUsers, num(p, "online_users"))
	}
	if maxUsers < 6 || len(list(gh, "points")) > 300 {
		t.Fatalf("gateway: máximo de usuários %v", maxUsers)
	}
}

func TestAdminHeatmapAndTopServers(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	adm, a := e.newActor(t, "adm"), e.newActor(t, "autor")
	e.makeAdmin(t, adm)
	big, small := a.createGuild(t, "Movimentado"), a.createGuild(t, "Quieto")
	for i := 0; i < 3; i++ {
		a.call(t, "POST", "/api/channels/"+big.textID+"/messages", J{"content": "m"}, 201)
	}
	a.call(t, "POST", "/api/channels/"+small.textID+"/messages", J{"content": "m"}, 201)

	h := obj(t, adm.call(t, "GET", "/api/admin/activity/heatmap", nil, 200))
	rows := h["cells"].([]any)
	if len(rows) != 7 || num(h, "days") != 28 || num(h, "total") < 4 {
		t.Fatalf("heatmap = %v", h)
	}
	now := time.Now().UTC()
	cell := rows[int(now.Weekday())].([]any)
	if len(cell) != 24 || cell[now.Hour()].(float64) < 4 { // domingo = 0, como time.Weekday
		// a hora pode ter virado durante o teste: aceita a anterior
		prev := now.Add(-time.Hour)
		pc := rows[int(prev.Weekday())].([]any)
		if cell[now.Hour()].(float64)+pc[prev.Hour()].(float64) < 4 {
			t.Fatalf("mensagens recém-enviadas deveriam estar na hora atual: %v", cell)
		}
	}
	// Cache de 10 min: o mesmo retrato.
	if h2 := obj(t, adm.call(t, "GET", "/api/admin/activity/heatmap", nil, 200)); str(h, "generated_at") != str(h2, "generated_at") {
		t.Fatal("o heatmap deveria vir do cache")
	}

	// O banco de testes é compartilhado e guarda mensagens de outros testes: insere um volume que garante o 1º lugar
	// (ids Snowflake de 30 min atrás, para não colidir com os de agora).
	t.Cleanup(func() { _, _ = e.pool.Exec(context.Background(), `DELETE FROM messages WHERE content = 'volume'`) })
	if _, err := e.pool.Exec(context.Background(), `
		INSERT INTO messages (id, channel_id, author_id, content)
		SELECT (((extract(epoch FROM now() - interval '30 minutes') * 1000)::bigint - 1767225600000) << 22) + g, $1::bigint, $2::bigint, 'volume'
		FROM generate_series(1, 20000) AS g`, atoi(t, big.textID), atoi(t, a.id)); err != nil {
		t.Fatal(err)
	}
	e2 := newEnvWith(t, notifCfg) // cache novo
	adm2 := e2.newActor(t, "adm")
	e2.makeAdmin(t, adm2)
	top := obj(t, adm2.call(t, "GET", "/api/admin/servers/top", nil, 200))
	items := list(top, "items")
	if len(items) == 0 || len(items) > 10 || num(top, "days") != 7 {
		t.Fatalf("top = %v", top)
	}
	if str(items[0], "id") != big.id || num(items[0], "messages") < 20003 || num(items[0], "members") != 1 || str(items[0], "name") != "Movimentado" {
		t.Fatalf("o servidor movimentado deveria liderar: %v", items[0])
	}
	for i := 1; i < len(items); i++ {
		if num(items[i-1], "messages") < num(items[i], "messages") {
			t.Fatalf("ranking fora de ordem: %v", items)
		}
	}
	for _, it := range items { // sem dados sensíveis
		for k := range it {
			if k != "id" && k != "name" && k != "messages" && k != "members" {
				t.Fatalf("campo inesperado %q no ranking", k)
			}
		}
	}
}

func atoi(t *testing.T, s string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAdminSystemDiskAndObjectSizes(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	s := obj(t, adm.call(t, "GET", "/api/admin/system", nil, 200))
	disk := asJ(s["disk"])
	if disk == nil || num(disk, "total_bytes") <= 0 || str(disk, "path") != "/" || num(disk, "used_pct") <= 0 || num(disk, "used_pct") > 100 {
		t.Fatalf("disco = %v", s["disk"])
	}
	o := asJ(asJ(s["storage"])["objects"])
	if o == nil || o["avatars_bytes"] == nil || num(o, "avatars_bytes") < 0 {
		t.Fatalf("tamanhos do storage = %v", asJ(s["storage"]))
	}
}

// ---------- rate limits por ação ----------

func TestActionRateLimitsAnswer429WithRetryAfter(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		notifCfg(d)
		d.ActionLimiters = nil // padrões de produção
	})
	a := e.newActor(t, "limite")
	for i := 0; i < 5; i++ { // servers.create: rajada de 5
		a.call(t, "POST", "/api/guilds", J{"name": "S" + string(rune('a'+i))}, 201)
	}
	resp, b := a.do(t, "POST", "/api/guilds", J{"name": "Sexto"})
	status(t, resp, b, 429)
	if resp.Header.Get("Retry-After") == "" || strings.Contains(string(b), "interno") {
		t.Fatalf("429 sem Retry-After ou com texto interno: %s %v", b, resp.Header)
	}
	// Outro usuário não é afetado.
	e.newActor(t, "outro").createGuild(t, "Livre")
}

func TestRateLimitEnvOverrideReplacesDefault(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		notifCfg(d)
		d.ActionLimiters = nil
		d.Cfg.RateLimitPerMin = map[string]int{"servers_create": 1}
	})
	a := e.newActor(t, "env")
	a.createGuild(t, "Primeiro")
	resp, b := a.do(t, "POST", "/api/guilds", J{"name": "Segundo"})
	status(t, resp, b, 429)
}

var _ = ratelimit.New

// Desconectar da voz (limite dentro do service) divide o balde "moderation" com banir e mutar: 20 de rajada por usuário.
func TestVoiceDisconnectSharesTheModerationLimit(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, func(d *Deps) {
		voiceCfg(lkf)(d)
		d.ActionLimiters = nil // padrões de produção
	})
	mod, victim := e.newActor(t, "mod"), e.newActor(t, "alvo")
	g := mod.createGuild(t, "Limite")
	victim.join(t, mod, g.id)
	dc := "/api/channels/" + g.voiceID + "/voice/" + victim.id + "/disconnect"
	for i := 0; i < 20; i++ { // a vítima não está na chamada: 409, mas conta no limite
		resp, b := mod.do(t, "POST", dc, nil)
		if resp.StatusCode == 429 {
			t.Fatalf("a chamada %d não deveria ser limitada: %s", i+1, b)
		}
	}
	resp, b := mod.do(t, "POST", dc, nil)
	status(t, resp, b, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}
	// Banir usa o mesmo balde: já esgotado.
	resp, b = mod.do(t, "PUT", "/api/guilds/"+g.id+"/bans/"+victim.id, J{})
	status(t, resp, b, 429)
}
