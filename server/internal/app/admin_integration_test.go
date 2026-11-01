//go:build integration

package app

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	lk "github.com/livekit/protocol/livekit"

	"github.com/devGustavoMuniz/spook/server/internal/admin"
	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/auth"
	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/dm"
	"github.com/devGustavoMuniz/spook/server/internal/gateway"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/invite"
	"github.com/devGustavoMuniz/spook/server/internal/message"
	"github.com/devGustavoMuniz/spook/server/internal/notification"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
	"github.com/devGustavoMuniz/spook/server/internal/typing"
	"github.com/devGustavoMuniz/spook/server/internal/user"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

func (e *testEnv) makeAdmin(t *testing.T, a *actor) {
	t.Helper()
	if _, err := e.pool.Exec(context.Background(), "UPDATE users SET is_admin = true WHERE id = $1", a.id); err != nil {
		t.Fatal(err)
	}
}

var adminRoutes = []string{
	"/api/admin/overview", "/api/admin/live", "/api/admin/system",
	"/api/admin/users", "/api/admin/servers", "/api/admin/calls",
}

func TestAdminRoutesRequireAdmin(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	plain, adm := e.newActor(t, "comum"), e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	for _, p := range adminRoutes {
		resp, b := e.do(t, "GET", p, nil, nil)
		status(t, resp, b, 401)
		b = plain.call(t, "GET", p, nil, 403)
		if !strings.Contains(string(b), "administradores") || strings.Contains(string(b), "overview") {
			t.Fatalf("403 deve ser genérico: %s", b)
		}
		adm.call(t, "GET", p, nil, 200)
	}
	if v := obj(t, plain.call(t, "GET", "/api/users/me", nil, 200)); v["is_admin"] != false {
		t.Fatalf("is_admin do usuário comum: %v", v["is_admin"])
	}
	if v := obj(t, adm.call(t, "GET", "/api/users/me", nil, 200)); v["is_admin"] != true {
		t.Fatalf("is_admin do admin: %v", v["is_admin"])
	}
}

func TestAdminDemotionTakesEffectImmediately(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	adm.call(t, "GET", "/api/admin/overview", nil, 200)
	if _, err := e.pool.Exec(context.Background(), "UPDATE users SET is_admin = false WHERE id = $1", adm.id); err != nil {
		t.Fatal(err)
	}
	adm.call(t, "GET", "/api/admin/overview", nil, 403)
}

func TestAdminBootstrapPromotesIdempotently(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	a, b := e.newActor(t, "boot"), e.newActor(t, "outro")
	for i := 0; i < 2; i++ { // sobe duas vezes: idempotente
		newEnvWith(t, func(d *Deps) {
			notifCfg(d)
			d.Cfg.AdminUsernames = []string{strings.ToUpper(a.name)} // usernames são citext
		})
	}
	a.call(t, "GET", "/api/admin/overview", nil, 200)
	b.call(t, "GET", "/api/admin/overview", nil, 403)
}

func TestAdminOverviewSeriesCacheAndNoSensitiveData(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	adm, u := e.newActor(t, "adm"), e.newActor(t, "membro")
	e.makeAdmin(t, adm)
	g := u.createGuild(t, "Painel")
	u.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "oi painel"}, 201)

	raw := adm.call(t, "GET", "/api/admin/overview", nil, 200)
	o := obj(t, raw)
	users, msgs := list(o, "new_users_per_day"), list(o, "messages_per_day")
	if len(users) != 14 || len(msgs) != 14 {
		t.Fatalf("séries = %d e %d dias", len(users), len(msgs))
	}
	today := time.Now().UTC().Format("2006-01-02")
	if str(users[13], "date") != today || num(users[13], "count") < 2 || num(msgs[13], "count") < 1 {
		t.Fatalf("hoje: %v / %v", users[13], msgs[13])
	}
	for i := 1; i < 14; i++ {
		if str(users[i-1], "date") >= str(users[i], "date") {
			t.Fatalf("dias fora de ordem: %v", users)
		}
	}
	if num(asJ(o["users"]), "total") < 2 || num(asJ(o["servers"]), "total") < 1 || num(asJ(o["messages"]), "total") < 1 {
		t.Fatalf("contagens: %v", o)
	}
	// Segundo pedido dentro do TTL: mesmo retrato do cache.
	o2 := obj(t, adm.call(t, "GET", "/api/admin/overview", nil, 200))
	if str(o, "generated_at") != str(o2, "generated_at") {
		t.Fatalf("o cache deveria servir o mesmo retrato: %s != %s", str(o, "generated_at"), str(o2, "generated_at"))
	}
	for _, bad := range []string{"password", "hash", "token", "@teste.spook"} {
		if strings.Contains(strings.ToLower(string(raw)), bad) {
			t.Fatalf("a visão geral não pode conter %q: %s", bad, raw)
		}
	}
}

func TestAdminUsersListSearchSortAndPaging(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	prefix := "zz" + strings.ToLower(strings.ReplaceAll(time.Now().Format("150405.000"), ".", ""))
	var names []string
	for i := 0; i < 3; i++ {
		a := e.newActor(t, prefix)
		names = append(names, a.name)
		for j := 0; j <= i; j++ { // i+1 mensagens para ordenar por mensagens
			g := a.createGuild(t, "Srv "+a.name+string(rune('a'+j)))
			a.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "m"}, 201)
		}
	}
	raw := adm.call(t, "GET", "/api/admin/users?q="+prefix+"&sort=messages_sent&order=desc", nil, 200)
	p := obj(t, raw)
	items := list(p, "items")
	if len(items) != 3 || num(p, "total") != 3 || num(p, "page_size") != 25 || str(p, "sort") != "messages_sent" {
		t.Fatalf("página = %s", raw)
	}
	if num(items[0], "messages_sent") != 3 || num(items[0], "guilds_owned") != 3 || num(items[2], "messages_sent") != 1 || items[0]["last_active_at"] == nil {
		t.Fatalf("linhas = %v", items)
	}
	asc := list(obj(t, adm.call(t, "GET", "/api/admin/users?q="+prefix+"&sort=username&order=asc", nil, 200)), "items")
	if str(asc[0], "username") > str(asc[1], "username") {
		t.Fatalf("ordem por username: %v", asc)
	}
	// busca por e-mail e sem resultado
	if n := num(obj(t, adm.call(t, "GET", "/api/admin/users?q="+prefix+"-", nil, 200)), "total"); n != 3 {
		t.Fatalf("busca por e-mail = %d", n)
	}
	if n := num(obj(t, adm.call(t, "GET", "/api/admin/users?q=nao-existe-"+prefix+"zzz", nil, 200)), "total"); n != 0 {
		t.Fatalf("sem resultado = %d", n)
	}
	// página além do fim vem vazia; coluna inválida é 422
	if it := list(obj(t, adm.call(t, "GET", "/api/admin/users?q="+prefix+"&page=9", nil, 200)), "items"); len(it) != 0 {
		t.Fatalf("página 9 = %v", it)
	}
	adm.call(t, "GET", "/api/admin/users?sort=password_hash", nil, 422)
	adm.call(t, "GET", "/api/admin/users?page=0", nil, 422)
	// nada além das colunas combinadas
	for _, bad := range []string{"password", "hash", "token", "avatar"} {
		if strings.Contains(strings.ToLower(string(raw)), bad) {
			t.Fatalf("a lista não pode conter %q: %s", bad, raw)
		}
	}
	// a paginação de 25: 30 usuários -> 2 páginas
	for i := 0; i < 27; i++ {
		e.newActor(t, prefix)
	}
	pg := obj(t, adm.call(t, "GET", "/api/admin/users?q="+prefix+"&sort=username&order=asc&page=2", nil, 200))
	if len(list(pg, "items")) != 5 || num(pg, "total") != 30 {
		t.Fatalf("página 2 = %d itens, total %d", len(list(pg, "items")), num(pg, "total"))
	}
}

func TestAdminServersList(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	adm, owner, m := e.newActor(t, "adm"), e.newActor(t, "dono"), e.newActor(t, "membro")
	e.makeAdmin(t, adm)
	name := "Srv" + strings.ReplaceAll(time.Now().Format("150405.000"), ".", "")
	g := owner.createGuild(t, name)
	m.join(t, owner, g.id)
	owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "um"}, 201)
	p := obj(t, adm.call(t, "GET", "/api/admin/servers?q="+strings.ToLower(name)+"&sort=members", nil, 200))
	items := list(p, "items")
	if len(items) != 1 || num(p, "total") != 1 {
		t.Fatalf("servidores = %v", p)
	}
	it := items[0]
	if str(it, "owner") != owner.name || num(it, "members") != 2 || num(it, "messages") != 1 || num(it, "channels") < 2 || num(it, "invites_active") < 1 {
		t.Fatalf("linha = %v", it)
	}
	// busca pelo dono também funciona
	if n := num(obj(t, adm.call(t, "GET", "/api/admin/servers?q="+owner.name, nil, 200)), "total"); n < 1 {
		t.Fatalf("busca por dono = %d", n)
	}
	adm.call(t, "GET", "/api/admin/servers?sort=email", nil, 422)
}

func TestAdminCallsWithoutLiveKit(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	c := obj(t, adm.call(t, "GET", "/api/admin/calls", nil, 200))
	s := asJ(c["summary"])
	if s["available"] != false || str(s, "reason") == "" || len(list(c, "rooms")) != 0 {
		t.Fatalf("voz desligada: %v", c)
	}
	l := obj(t, adm.call(t, "GET", "/api/admin/live", nil, 200))
	if asJ(l["livekit"])["available"] != false || str(asJ(l["livekit"]), "reason") == "" {
		t.Fatalf("Prometheus ausente deve explicar: %v", l["livekit"])
	}
}

func TestAdminCallsFromLiveKit(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, func(d *Deps) {
		voiceCfg(lkf)(d)
		d.Cfg.LiveKit.MetricsURL = "" // sem Prometheus
	})
	adm, ana, beto := e.newActor(t, "adm"), e.newActor(t, "ana"), e.newActor(t, "beto")
	e.makeAdmin(t, adm)
	g := ana.createGuild(t, "Call")
	beto.join(t, ana, g.id)
	ana.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, ana)
	lkf.mu.Lock()
	lkf.rooms = []*lk.Room{{Name: g.voiceID, NumParticipants: 2}}
	lkf.parts[g.voiceID] = []*lk.ParticipantInfo{
		{Identity: ana.id, Sid: "PA_a", Tracks: []*lk.TrackInfo{{Source: lk.TrackSource_CAMERA}, {Source: lk.TrackSource_MICROPHONE}}},
		{Identity: beto.id, Sid: "PA_b", Tracks: []*lk.TrackInfo{{Source: lk.TrackSource_SCREEN_SHARE}}},
	}
	lkf.mu.Unlock()

	var c J
	waitUntil(t, "sala ativa no painel", func() bool {
		c = obj(t, adm.call(t, "GET", "/api/admin/calls", nil, 200))
		return len(list(c, "rooms")) == 1
	})
	s, r := asJ(c["summary"]), list(c, "rooms")[0]
	if s["available"] != true || num(s, "ongoing") != 1 || num(s, "people") != 2 || num(s, "cameras") != 1 || num(s, "screens") != 1 {
		t.Fatalf("resumo = %v", s)
	}
	if str(r, "server") != "Call" || str(r, "channel") == "" || num(r, "cameras") != 1 {
		t.Fatalf("sala = %v", r)
	}
	people, _ := r["people"].([]any)
	if len(people) != 2 {
		t.Fatalf("pessoas = %v", people)
	}
	if n := len(list(obj(t, adm.call(t, "GET", "/api/admin/calls?q=inexistente-zz", nil, 200)), "rooms")); n != 0 {
		t.Fatalf("filtro sem resultado = %d", n)
	}
	l := obj(t, adm.call(t, "GET", "/api/admin/live", nil, 200))
	if cs := asJ(l["calls"]); num(cs, "ongoing") != 1 || num(cs, "people") != 2 {
		t.Fatalf("live = %v", l)
	}
}

func TestAdminSystem(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		notifCfg(d)
		d.Cfg.Env = "teste"
	})
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	adm.connectReady(t) // uma conexão aberta no gateway
	s := obj(t, adm.call(t, "GET", "/api/admin/system", nil, 200))
	app, db, gw := asJ(s["app"]), asJ(s["database"]), asJ(s["gateway"])
	if str(app, "environment") != "teste" || num(app, "goroutines") < 1 || str(app, "go_version") == "" || num(app, "uptime_seconds") < 0 {
		t.Fatalf("app = %v", app)
	}
	if num(db, "size_bytes") <= 0 || len(list(db, "tables")) == 0 || asJ(db["pool"]) == nil {
		t.Fatalf("db = %v", db)
	}
	if gw["available"] != true || num(gw, "connections") < 1 || num(gw, "online_users") < 1 {
		t.Fatalf("gateway = %v", gw)
	}
	if jobs := asJ(s["jobs"]); jobs["available"] != true {
		t.Fatalf("jobs = %v", jobs)
	}
}

func TestAdminCLIGrantRevokeList(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	a := e.newActor(t, "cli")
	run := func(args ...string) (string, error) {
		var out bytes.Buffer
		err := admin.RunCLI(context.Background(), e.pool, args, &out)
		return out.String(), err
	}
	a.call(t, "GET", "/api/admin/overview", nil, 403)
	if out, err := run("grant", "@"+strings.ToUpper(a.name)); err != nil || !strings.Contains(out, "agora é administrador") {
		t.Fatalf("grant = %q, %v", out, err)
	}
	a.call(t, "GET", "/api/admin/overview", nil, 200)
	if out, err := run("list"); err != nil || !strings.Contains(out, a.name) {
		t.Fatalf("list = %q, %v", out, err)
	}
	if _, err := run("revoke", a.name); err != nil {
		t.Fatal(err)
	}
	a.call(t, "GET", "/api/admin/overview", nil, 403)
	if _, err := run("grant", "nao_existe_xyz"); err == nil {
		t.Fatal("conta inexistente deveria falhar")
	}
	if _, err := run("grant"); err == nil {
		t.Fatal("sem username deveria falhar")
	}
}

// ---------- segurança: cobertura por construção de /api/admin/** ----------

// adminOps enumera, a partir do OpenAPI gerado pelo mesmo registerAPI do app, cada (método, caminho) sob
// /api/admin. Nada de lista manual: uma rota nova entra aqui sozinha e passa a ser testada.
func adminOps(t *testing.T) (ops []struct{ method, path string }) {
	t.Helper()
	api := registerAPI(chi.NewRouter(), false, auth.NewHandler(nil, true, nil), user.NewHandler(nil, nil),
		guild.NewHandler(nil, nil), channel.NewHandler(nil, nil), message.NewHandler(nil, nil), attachment.NewHandler(nil, nil), invite.NewHandler(nil, nil),
		dm.NewHandler(nil, nil), typing.NewHandler(nil, nil), voice.NewHandler(nil, nil), notification.NewHandler(nil, nil), presence.NewHandler(nil, nil), gateway.NewHandler(nil, nil, nil), admin.NewHandler(nil, nil))
	for path, item := range api.OpenAPI().Paths {
		for method, op := range map[string]*huma.Operation{
			"GET": item.Get, "POST": item.Post, "PUT": item.Put, "PATCH": item.Patch,
			"DELETE": item.Delete, "HEAD": item.Head, "OPTIONS": item.Options, "TRACE": item.Trace,
		} {
			if op == nil {
				continue
			}
			isAdminPath := path == "/api/admin" || strings.HasPrefix(path, "/api/admin/")
			tagged := false
			for _, tag := range op.Tags {
				tagged = tagged || tag == "admin"
			}
			if isAdminPath != tagged {
				t.Fatalf("%s %s: caminho sob /api/admin e tag \"admin\" devem andar juntos (caminho=%v, tag=%v)", method, path, isAdminPath, tagged)
			}
			if !isAdminPath {
				continue
			}
			if len(op.Security) == 0 {
				t.Fatalf("%s %s: sem esquema de segurança no contrato", method, path)
			}
			ops = append(ops, struct{ method, path string }{method, path})
		}
	}
	return ops
}

func TestAdminEveryRouteIsGuarded(t *testing.T) {
	ops := adminOps(t)
	if len(ops) < len(adminRoutes) {
		t.Fatalf("a enumeração achou %d rotas /api/admin; a lista conhecida tem %d (a enumeração quebrou?)", len(ops), len(adminRoutes))
	}
	found := map[string]bool{}
	for _, o := range ops {
		if o.method == "GET" {
			found[o.path] = true
		}
	}
	for _, p := range adminRoutes { // rede de segurança: uma rota conhecida não pode sumir da enumeração
		if !found[p] {
			t.Fatalf("rota conhecida %s ausente da enumeração do OpenAPI", p)
		}
	}

	e := newEnvWith(t, notifCfg)
	plain, adm := e.newActor(t, "comum"), e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	for _, o := range ops {
		path := strings.NewReplacer("{id}", "1", "{userId}", "1", "{guildId}", "1", "{channelId}", "1").Replace(o.path)
		if strings.Contains(path, "{") {
			t.Fatalf("%s %s tem parâmetro de caminho sem valor de teste: ajuste o substituidor", o.method, o.path)
		}
		var body any
		if o.method != "GET" && o.method != "HEAD" && o.method != "DELETE" && o.method != "OPTIONS" && o.method != "TRACE" {
			body = J{}
		}
		// sem sessão: 401
		resp, b := e.do(t, o.method, path, body, nil)
		status(t, resp, b, 401)
		// usuário comum: 403 com corpo genérico
		resp, b = plain.do(t, o.method, path, body)
		status(t, resp, b, 403)
		if o.method != "HEAD" && (!strings.Contains(string(b), "administradores") || strings.Contains(string(b), "overview")) {
			t.Fatalf("%s %s: 403 deve ser genérico: %s", o.method, o.path, b)
		}
		// admin: 2xx
		resp, b = adm.do(t, o.method, path, body)
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			t.Fatalf("%s %s como admin = %d: %s", o.method, o.path, resp.StatusCode, b)
		}
	}
}

func TestAdminDesktopBearerAndSessionKinds(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	email, username := uniq("desk")
	resp, b := e.do(t, "POST", "/api/auth/register", J{"email": email, "username": username, "password": "senha-forte-123"}, nil)
	status(t, resp, b, 201)
	bare := &testEnv{srv: e.srv, client: &http.Client{}} // sem cookie
	resp, b = bare.do(t, "POST", "/api/auth/login", J{"email": email, "password": "senha-forte-123"}, map[string]string{"X-Spook-Client": "desktop"})
	status(t, resp, b, 200)
	token := str(obj(t, b), "token")
	if token == "" {
		t.Fatalf("desktop deveria receber o token: %s", b)
	}
	for _, p := range adminRoutes {
		// X-Spook-Client: desktop sozinho não autentica nada
		resp, b = bare.do(t, "GET", p, nil, map[string]string{"X-Spook-Client": "desktop"})
		status(t, resp, b, 401)
		// Bearer de usuário comum: 403
		resp, b = bare.do(t, "GET", p, nil, map[string]string{"Authorization": "Bearer " + token})
		status(t, resp, b, 403)
		// Bearer inválido: 401
		resp, b = bare.do(t, "GET", p, nil, map[string]string{"Authorization": "Bearer " + token + "x"})
		status(t, resp, b, 401)
		// cookie de sessão de usuário comum (o register acima deixou o cookie no jar de e.client)
		resp, b = e.do(t, "GET", p, nil, nil)
		status(t, resp, b, 403)
	}
	// o mesmo Bearer, depois de promovido, passa na hora (e perde ao ser rebaixado)
	var id int64
	if err := e.pool.QueryRow(context.Background(), "SELECT id FROM users WHERE username = $1", username).Scan(&id); err != nil {
		t.Fatal(err)
	}
	hdr := map[string]string{"Authorization": "Bearer " + token}
	if _, err := e.pool.Exec(context.Background(), "UPDATE users SET is_admin = true WHERE id = $1", id); err != nil {
		t.Fatal(err)
	}
	resp, b = bare.do(t, "GET", "/api/admin/overview", nil, hdr)
	status(t, resp, b, 200)
	if _, err := e.pool.Exec(context.Background(), "UPDATE users SET is_admin = false WHERE id = $1", id); err != nil {
		t.Fatal(err)
	}
	resp, b = bare.do(t, "GET", "/api/admin/overview", nil, hdr)
	status(t, resp, b, 403)
}

func TestAdminDemotedUserLosesEveryRouteAtOnce(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	adm := e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	for _, p := range adminRoutes {
		adm.call(t, "GET", p, nil, 200)
	}
	if _, err := e.pool.Exec(context.Background(), "UPDATE users SET is_admin = false WHERE id = $1", adm.id); err != nil {
		t.Fatal(err)
	}
	for _, p := range adminRoutes { // mesma sessão, sem novo login e sem esperar cache
		adm.call(t, "GET", p, nil, 403)
	}
}

// O painel é polling HTTP: nenhum dado de administração passa pelo gateway WebSocket.
func TestAdminDataNeverTravelsThroughGateway(t *testing.T) {
	// 1) o catálogo de eventos do barramento (que o gateway converte em frames) não tem nada de admin.
	src, err := os.ReadFile("../platform/events/events.go")
	if err != nil {
		t.Fatal(err)
	}
	names := regexp.MustCompile(`=\s*"([A-Z_]+)"`).FindAllStringSubmatch(string(src), -1)
	if len(names) < 15 {
		t.Fatalf("catálogo de eventos não lido (%d nomes)", len(names))
	}
	for _, n := range names {
		if strings.Contains(n[1], "ADMIN") {
			t.Fatalf("evento de admin no catálogo: %s", n[1])
		}
	}
	// 2) na prática: um usuário comum conectado não recebe nada enquanto o admin usa o painel.
	e := newEnvWith(t, notifCfg)
	plain, adm := e.newActor(t, "comum"), e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	c, _ := plain.connectReady(t)
	ac, _ := adm.connectReady(t)
	for _, p := range adminRoutes {
		adm.call(t, "GET", p, nil, 200)
	}
	c.none(700 * time.Millisecond)
	// 3) nem o admin recebe dados do painel pelo socket: só chegam eventos do catálogo normal.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		f, err := ac.read(time.Until(deadline))
		if err != nil {
			break
		}
		if f.T != nil && strings.Contains(strings.ToUpper(*f.T), "ADMIN") {
			t.Fatalf("evento de admin no gateway: %s", *f.T)
		}
	}
}
