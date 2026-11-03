//go:build integration

package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

// ---------- helpers ----------

type J = map[string]any

// actor é um usuário cadastrado, com sessão própria no mesmo servidor de teste.
type actor struct {
	e      *testEnv
	client *http.Client
	id     string
	name   string
}

func (e *testEnv) newActor(t *testing.T, prefix string) *actor {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	a := &actor{e: e, client: &http.Client{Jar: jar}}
	email, username := uniq(prefix)
	a.name = username
	resp, b := a.do(t, "POST", "/api/auth/register", J{"email": email, "username": username, "password": "senha-forte-123"})
	status(t, resp, b, 201)
	resp, b = a.do(t, "GET", "/api/users/me", nil)
	status(t, resp, b, 200)
	a.id = str(obj(t, b), "id")
	return a
}

func (a *actor) do(t *testing.T, method, path string, body any) (*http.Response, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, a.e.srv.URL+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client.Do(req)
	if err != nil {
		t.Error(err) // Error (não Fatal): também é chamado de goroutines
		return &http.Response{StatusCode: 0, Request: req}, nil
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

// call faz a requisição, exige o status e devolve o corpo.
func (a *actor) call(t *testing.T, method, path string, body any, want int) []byte {
	t.Helper()
	resp, b := a.do(t, method, path, body)
	status(t, resp, b, want)
	return b
}

func obj(t *testing.T, b []byte) J {
	t.Helper()
	var m J
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("JSON inválido: %v: %s", err, b)
	}
	return m
}

func arr(t *testing.T, b []byte) []J {
	t.Helper()
	var m []J
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("JSON inválido: %v: %s", err, b)
	}
	return m
}

func str(m J, k string) string {
	s, _ := m[k].(string)
	return s
}

func list(m J, k string) []J {
	var out []J
	items, _ := m[k].([]any)
	for _, it := range items {
		out = append(out, it.(J))
	}
	return out
}

func num(m J, k string) int64 {
	f, _ := m[k].(float64)
	return int64(f)
}

// guildFixture é um servidor com seus ids principais.
type guildFixture struct {
	id, textID, voiceID, categoryID string
	detail                          J
}

func (a *actor) createGuild(t *testing.T, name string) guildFixture {
	t.Helper()
	d := obj(t, a.call(t, "POST", "/api/guilds", J{"name": name}, 201))
	f := guildFixture{id: str(d, "id"), detail: d}
	for _, c := range list(d, "channels") {
		switch num(c, "type") {
		case 0:
			f.textID = str(c, "id")
		case 1:
			f.voiceID = str(c, "id")
		case 2:
			f.categoryID = str(c, "id")
		}
	}
	return f
}

// invite cria um convite e faz o outro usuário entrar.
func (a *actor) invite(t *testing.T, guildID string) string {
	t.Helper()
	return str(obj(t, a.call(t, "POST", "/api/guilds/"+guildID+"/invites", J{}, 201)), "code")
}

func (a *actor) join(t *testing.T, owner *actor, guildID string) {
	t.Helper()
	a.call(t, "POST", "/api/invites/"+owner.invite(t, guildID), nil, 200)
}

func (a *actor) role(t *testing.T, guildID string, body J) J {
	t.Helper()
	return obj(t, a.call(t, "POST", "/api/guilds/"+guildID+"/roles", body, 201))
}

func (a *actor) giveRole(t *testing.T, guildID, userID, roleID string) {
	t.Helper()
	a.call(t, "PUT", "/api/guilds/"+guildID+"/members/"+userID+"/roles/"+roleID, nil, 200)
}

func bigLimits(d *Deps) {
	d.APILimiter = ratelimit.New(100000, 100000)
	d.MsgLimiter = ratelimit.New(100000, 100000)
	d.EveryoneLimiter = ratelimit.New(100000, 100000)
}

// ---------- 401 ----------

func TestGuildRoutesReturn401WithoutSession(t *testing.T) {
	e := newEnv(t)
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/guilds"}, {"POST", "/api/guilds"}, {"GET", "/api/guilds/1"}, {"PATCH", "/api/guilds/1"},
		{"DELETE", "/api/guilds/1"}, {"POST", "/api/guilds/1/transfer"}, {"POST", "/api/guilds/1/icon"},
		{"GET", "/api/guilds/1/members"}, {"DELETE", "/api/guilds/1/members/2"},
		{"GET", "/api/guilds/1/roles"}, {"POST", "/api/guilds/1/roles"}, {"PATCH", "/api/guilds/1/roles/2"},
		{"DELETE", "/api/guilds/1/roles/2"}, {"PUT", "/api/guilds/1/members/2/roles/3"}, {"DELETE", "/api/guilds/1/members/2/roles/3"},
		{"GET", "/api/guilds/1/channels"}, {"POST", "/api/guilds/1/channels"}, {"PATCH", "/api/guilds/1/channels/positions"},
		{"PATCH", "/api/channels/1"}, {"DELETE", "/api/channels/1"},
		{"GET", "/api/guilds/1/invites"}, {"POST", "/api/guilds/1/invites"},
		{"GET", "/api/invites/abcdefgh"}, {"POST", "/api/invites/abcdefgh"}, {"DELETE", "/api/invites/abcdefgh"},
		{"GET", "/api/channels/1/messages"}, {"POST", "/api/channels/1/messages"},
		{"PATCH", "/api/channels/1/messages/2"}, {"DELETE", "/api/channels/1/messages/2"},
	} {
		var body any
		if c.method == "POST" || c.method == "PATCH" || c.method == "PUT" {
			body = J{}
		}
		resp, b := e.do(t, c.method, c.path, body, nil)
		status(t, resp, b, 401)
	}
}

// ---------- servidores ----------

func TestGuildLifecycle(t *testing.T) {
	e := newEnvWith(t, bigLimits)
	owner, member, stranger := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "forasteiro")

	g := e.createGuildChecked(t, owner)
	d := g.detail
	if str(d, "owner_id") != owner.id || d["is_owner"] != true || num(d, "permissions") != int64(perm.All) {
		t.Fatalf("dono mal montado: %v", d)
	}
	// @everyone tem id = guild_id e as permissões padrão
	roles := list(d, "roles")
	if len(roles) != 1 || str(roles[0], "id") != g.id || roles[0]["is_everyone"] != true ||
		num(roles[0], "permissions") != int64(perm.DefaultEveryone) || num(roles[0], "position") != 0 {
		t.Fatalf("@everyone inesperado: %v", roles)
	}

	// listagem e detalhe trazem o suficiente para montar a tela
	gs := arr(t, owner.call(t, "GET", "/api/guilds", nil, 200))
	if len(gs) != 1 || str(gs[0], "id") != g.id || len(list(gs[0], "channels")) != 3 || len(list(gs[0], "roles")) != 1 {
		t.Fatalf("GET /guilds = %v", gs)
	}
	if num(gs[0], "permissions") != int64(perm.All) {
		t.Fatalf("permissões na lista: %v", gs[0]["permissions"])
	}

	// não-membro: servidor inexistente (404) em tudo (a confirmação de senha vem antes da checagem de acesso)
	stranger.confirm(t, pw, 200)
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/guilds/" + g.id}, {"PATCH", "/api/guilds/" + g.id}, {"DELETE", "/api/guilds/" + g.id},
		{"GET", "/api/guilds/" + g.id + "/members"}, {"GET", "/api/guilds/" + g.id + "/roles"},
		{"GET", "/api/guilds/" + g.id + "/channels"}, {"POST", "/api/guilds/" + g.id + "/invites"},
	} {
		var body any
		if c.method == "PATCH" {
			body = J{"name": "x-novo"}
		}
		if c.method == "POST" {
			body = J{}
		}
		stranger.call(t, c.method, c.path, body, 404)
	}
	stranger.call(t, "GET", "/api/guilds/abc", nil, 404)
	if gs := arr(t, stranger.call(t, "GET", "/api/guilds", nil, 200)); len(gs) != 0 {
		t.Fatalf("forasteiro vê servidores: %v", gs)
	}

	member.join(t, owner, g.id)

	// renomear: dono ou MANAGE_GUILD
	upd := obj(t, owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"name": "Renomeado"}, 200))
	if str(upd, "name") != "Renomeado" {
		t.Fatalf("nome: %v", upd)
	}
	member.call(t, "PATCH", "/api/guilds/"+g.id, J{"name": "Hack"}, 403)
	owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"name": "x"}, 422)
	// ícone: só chaves geradas para o servidor
	owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"icon_key": "guild-icons/999/x.png"}, 422)
	up := obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/icon", J{"content_type": "image/png", "size": 1000}, 200))
	if !strings.HasPrefix(str(up, "key"), "guild-icons/"+g.id+"/") || str(up, "upload_url") == "" {
		t.Fatalf("upload de ícone: %v", up)
	}
	withIcon := obj(t, owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"icon_key": str(up, "key")}, 200))
	if str(withIcon, "icon_key") != str(up, "key") || str(withIcon, "icon_url") == "" {
		t.Fatalf("ícone: %v", withIcon)
	}
	member.call(t, "POST", "/api/guilds/"+g.id+"/icon", J{"content_type": "image/png", "size": 1000}, 403)
	cleared := obj(t, owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"icon_key": ""}, 200))
	if cleared["icon_key"] != nil {
		t.Fatalf("ícone deveria ter sido removido: %v", cleared)
	}
	// membro com MANAGE_GUILD também renomeia
	mg := owner.role(t, g.id, J{"name": "gestor", "permissions": int64(perm.ManageGuild)})
	owner.giveRole(t, g.id, member.id, str(mg, "id"))
	member.call(t, "PATCH", "/api/guilds/"+g.id, J{"name": "Pelo gestor"}, 200)

	// membros listados com o cargo
	ms := obj(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/members", nil, 200))
	if len(list(ms, "members")) != 2 || ms["has_more"] != false {
		t.Fatalf("membros: %v", ms)
	}
	page := obj(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/members?limit=1", nil, 200))
	if len(list(page, "members")) != 1 || page["has_more"] != true {
		t.Fatalf("paginação de membros: %v", page)
	}

	// dono não sai sem transferir; só o dono exclui e transfere
	owner.call(t, "DELETE", "/api/guilds/"+g.id+"/members/@me", nil, 409)
	// excluir e transferir exigem a senha confirmada há pouco (403 password_confirmation_required)
	for _, c := range []struct {
		method, path string
		body         any
	}{{"DELETE", "/api/guilds/" + g.id, nil}, {"POST", "/api/guilds/" + g.id + "/transfer", J{"user_id": member.id}}} {
		resp, b := owner.do(t, c.method, c.path, c.body)
		status(t, resp, b, 403)
		if obj(t, b)["code"] != "password_confirmation_required" {
			t.Fatalf("%s %s sem confirmação: %s", c.method, c.path, b)
		}
	}
	owner.confirm(t, pw, 200)
	member.confirm(t, pw, 200)
	member.call(t, "DELETE", "/api/guilds/"+g.id, nil, 403)
	member.call(t, "POST", "/api/guilds/"+g.id+"/transfer", J{"user_id": member.id}, 403)
	owner.call(t, "POST", "/api/guilds/"+g.id+"/transfer", J{"user_id": stranger.id}, 422) // não é membro
	owner.call(t, "POST", "/api/guilds/"+g.id+"/transfer", J{"user_id": owner.id}, 422)
	tr := obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/transfer", J{"user_id": member.id}, 200))
	if str(tr, "owner_id") != member.id {
		t.Fatalf("posse: %v", tr)
	}
	// o antigo dono agora é membro comum: pode sair
	owner.call(t, "DELETE", "/api/guilds/"+g.id+"/members/@me", nil, 204)
	owner.call(t, "GET", "/api/guilds/"+g.id, nil, 404)
	// o novo dono exclui
	member.confirm(t, pw, 200)
	member.call(t, "DELETE", "/api/guilds/"+g.id, nil, 204)
	member.call(t, "GET", "/api/guilds/"+g.id, nil, 404)
}

func (e *testEnv) createGuildChecked(t *testing.T, owner *actor) guildFixture {
	t.Helper()
	g := owner.createGuild(t, "Servidor de teste")
	cs := list(g.detail, "channels")
	if len(cs) != 3 || g.textID == "" || g.voiceID == "" || g.categoryID == "" {
		t.Fatalf("canais iniciais: %v", cs)
	}
	for _, c := range cs {
		switch num(c, "type") {
		case 0:
			if str(c, "name") != "geral" || str(c, "parent_id") != g.categoryID {
				t.Fatalf("canal de texto: %v", c)
			}
		case 1:
			if str(c, "name") != "Geral" || str(c, "parent_id") != g.categoryID {
				t.Fatalf("canal de voz: %v", c)
			}
		}
	}
	return g
}

func TestCreateGuildValidationAndLimit(t *testing.T) {
	e := newEnvWith(t, bigLimits)
	u := e.newActor(t, "limite")
	u.call(t, "POST", "/api/guilds", J{"name": "a"}, 422)
	u.call(t, "POST", "/api/guilds", J{"name": " a "}, 422)
	u.call(t, "POST", "/api/guilds", J{"name": strings.Repeat("a", 101)}, 422)
	for i := 0; i < 100; i++ {
		u.call(t, "POST", "/api/guilds", J{"name": fmt.Sprintf("Servidor %d", i)}, 201)
	}
	u.call(t, "POST", "/api/guilds", J{"name": "O 101"}, 409)

	// entrar por convite também respeita o limite de 100
	other := e.newActor(t, "outro")
	g := other.createGuild(t, "Outro servidor")
	u.call(t, "POST", "/api/invites/"+other.invite(t, g.id), nil, 409)
	// sair libera uma vaga
	gs := arr(t, u.call(t, "GET", "/api/guilds", nil, 200))
	u.confirm(t, pw, 200)
	u.call(t, "DELETE", "/api/guilds/"+str(gs[0], "id"), nil, 204)
	u.call(t, "POST", "/api/invites/"+other.invite(t, g.id), nil, 200)
}

// ---------- cargos e hierarquia ----------

func TestRolesAndHierarchy(t *testing.T) {
	e := newEnvWith(t, bigLimits)
	owner, mod, low, plain, stranger := e.newActor(t, "dono"), e.newActor(t, "mod"), e.newActor(t, "baixo"), e.newActor(t, "comum"), e.newActor(t, "fora")
	g := owner.createGuild(t, "Hierarquia")
	for _, u := range []*actor{mod, low, plain} {
		u.join(t, owner, g.id)
	}
	base := "/api/guilds/" + g.id

	modRole := owner.role(t, g.id, J{"name": "mod", "position": 5, "permissions": int64(perm.ManageRoles | perm.KickMembers), "color": 0xFF0000})
	lowRole := owner.role(t, g.id, J{"name": "baixo", "position": 2, "permissions": int64(perm.KickMembers)})
	if num(modRole, "position") != 5 || num(modRole, "color") != 0xFF0000 {
		t.Fatalf("cargo: %v", modRole)
	}
	owner.giveRole(t, g.id, mod.id, str(modRole, "id"))
	owner.giveRole(t, g.id, low.id, str(lowRole, "id"))

	// cargos listados do mais alto ao mais baixo
	rs := arr(t, owner.call(t, "GET", base+"/roles", nil, 200))
	if len(rs) != 3 || str(rs[0], "name") != "mod" || str(rs[2], "id") != g.id {
		t.Fatalf("ordem dos cargos: %v", rs)
	}
	stranger.call(t, "GET", base+"/roles", nil, 404)

	// MANAGE_ROLES + hierarquia
	plain.call(t, "POST", base+"/roles", J{"name": "x"}, 403)
	mod.call(t, "POST", base+"/roles", J{"name": "igual", "position": 5}, 403)                                        // não abaixo do seu
	mod.call(t, "POST", base+"/roles", J{"name": "acima", "position": 9}, 403)                                        // acima
	mod.call(t, "POST", base+"/roles", J{"name": "sobe", "position": 4, "permissions": int64(perm.ManageGuild)}, 403) // permissão que não tem
	made := mod.role(t, g.id, J{"name": "criado-pelo-mod", "position": 4, "permissions": int64(perm.ViewChannel | perm.KickMembers)})
	owner.call(t, "POST", base+"/roles", J{"name": "ruim", "permissions": int64(1) << 20}, 422)
	owner.call(t, "POST", base+"/roles", J{"name": "ruim", "position": 0}, 422)

	// editar: abaixo ok; o próprio cargo mais alto, não; mover para cima do seu, não
	mod.call(t, "PATCH", base+"/roles/"+str(made, "id"), J{"name": "renomeado", "color": 255}, 200)
	mod.call(t, "PATCH", base+"/roles/"+str(modRole, "id"), J{"name": "golpe"}, 403)
	mod.call(t, "PATCH", base+"/roles/"+str(made, "id"), J{"position": 5}, 403)
	mod.call(t, "PATCH", base+"/roles/"+str(made, "id"), J{"permissions": int64(perm.ManageGuild)}, 403)
	removed := obj(t, mod.call(t, "PATCH", base+"/roles/"+str(made, "id"), J{"remove_color": true}, 200))
	if removed["color"] != nil {
		t.Fatalf("cor deveria ter sido removida: %v", removed)
	}
	low.call(t, "PATCH", base+"/roles/"+str(made, "id"), J{"name": "x"}, 403)

	// atribuir/remover cargos
	mod.call(t, "PUT", base+"/members/"+plain.id+"/roles/"+str(made, "id"), nil, 200)
	mod.call(t, "PUT", base+"/members/"+plain.id+"/roles/"+str(modRole, "id"), nil, 403) // cargo do mesmo nível
	mod.call(t, "PUT", base+"/members/"+plain.id+"/roles/"+g.id, nil, 422)               // @everyone
	mod.call(t, "PUT", base+"/members/"+stranger.id+"/roles/"+str(made, "id"), nil, 404) // não é membro
	mod.call(t, "PUT", base+"/members/"+plain.id+"/roles/999", nil, 404)
	low.call(t, "PUT", base+"/members/"+plain.id+"/roles/"+str(made, "id"), nil, 403) // sem MANAGE_ROLES
	m := obj(t, mod.call(t, "DELETE", base+"/members/"+plain.id+"/roles/"+str(made, "id"), nil, 200))
	if len(list2(m, "role_ids")) != 0 {
		t.Fatalf("cargo deveria ter saído: %v", m)
	}

	// @everyone: não exclui nem renomeia; permissões podem mudar
	owner.call(t, "DELETE", base+"/roles/"+g.id, nil, 422)
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"name": "todos"}, 422)
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"position": 3}, 422)
	ev := obj(t, owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.DefaultEveryone | perm.ManageMessages)}, 200))
	if num(ev, "permissions") != int64(perm.DefaultEveryone|perm.ManageMessages) {
		t.Fatalf("@everyone: %v", ev)
	}
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.DefaultEveryone)}, 200)

	// excluir cargo: hierarquia
	low.call(t, "DELETE", base+"/roles/"+str(made, "id"), nil, 403)
	mod.call(t, "DELETE", base+"/roles/"+str(modRole, "id"), nil, 403)
	mod.call(t, "DELETE", base+"/roles/"+str(made, "id"), nil, 204)
	owner.call(t, "DELETE", base+"/roles/"+str(made, "id"), nil, 404)

	// expulsar: KICK_MEMBERS + hierarquia; o dono nunca
	plain.call(t, "DELETE", base+"/members/"+low.id, nil, 403)    // sem KICK_MEMBERS
	low.call(t, "DELETE", base+"/members/"+mod.id, nil, 403)      // cargo mais alto
	mod.call(t, "DELETE", base+"/members/"+owner.id, nil, 403)    // o dono nunca
	mod.call(t, "DELETE", base+"/members/"+stranger.id, nil, 404) // não é membro
	owner.call(t, "DELETE", base+"/members/"+owner.id, nil, 409)  // dono não sai
	mod.call(t, "DELETE", base+"/members/"+low.id, nil, 204)      // mod (5) > baixo (2)
	low.call(t, "GET", base, nil, 404)                            // expulso não vê mais
	mod.call(t, "DELETE", base+"/members/"+plain.id, nil, 204)    // só @everyone
	owner.call(t, "DELETE", base+"/members/"+mod.id, nil, 204)    // dono expulsa quem quiser
	ms := obj(t, owner.call(t, "GET", base+"/members", nil, 200))
	if len(list(ms, "members")) != 1 {
		t.Fatalf("restou mais que o dono: %v", ms)
	}
}

func list2(m J, k string) []any { l, _ := m[k].([]any); return l }

func TestAdministratorBypassesPermissionsButNotHierarchy(t *testing.T) {
	e := newEnvWith(t, bigLimits)
	owner, admin, peer := e.newActor(t, "dono"), e.newActor(t, "admin"), e.newActor(t, "par")
	g := owner.createGuild(t, "Admins")
	admin.join(t, owner, g.id)
	peer.join(t, owner, g.id)
	base := "/api/guilds/" + g.id
	ar := owner.role(t, g.id, J{"name": "admin", "position": 3, "permissions": int64(perm.Administrator)})
	pr := owner.role(t, g.id, J{"name": "par", "position": 3, "permissions": int64(perm.Administrator)})
	owner.giveRole(t, g.id, admin.id, str(ar, "id"))
	owner.giveRole(t, g.id, peer.id, str(pr, "id"))

	d := obj(t, admin.call(t, "GET", base, nil, 200))
	if num(d, "permissions") != int64(perm.All) || d["is_owner"] != false {
		t.Fatalf("admin: %v", d)
	}
	admin.call(t, "PATCH", base, J{"name": "Admin renomeou"}, 200)
	admin.call(t, "DELETE", base+"/members/"+peer.id, nil, 403) // mesmo nível
	admin.call(t, "DELETE", base+"/members/"+owner.id, nil, 403)
	admin.call(t, "DELETE", base, nil, 403) // só o dono exclui
}

// ---------- canais ----------

func TestChannels(t *testing.T) {
	e := newEnvWith(t, bigLimits)
	owner, member, stranger := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "fora")
	g := owner.createGuild(t, "Canais")
	member.join(t, owner, g.id)
	base := "/api/guilds/" + g.id

	member.call(t, "POST", base+"/channels", J{"type": 0, "name": "x"}, 403)
	stranger.call(t, "POST", base+"/channels", J{"type": 0, "name": "x"}, 404)
	owner.call(t, "POST", base+"/channels", J{"type": 3, "name": "dm"}, 422) // DM não entra aqui
	owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "  "}, 422)
	owner.call(t, "POST", base+"/channels", J{"type": 0, "name": strings.Repeat("a", 101)}, 422)

	cat := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 2, "name": "Jogos"}, 201))
	txt := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "lol", "parent_id": str(cat, "id")}, 201))
	voice := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 1, "name": "Sala", "parent_id": str(cat, "id")}, 201))
	if str(txt, "parent_id") != str(cat, "id") || num(voice, "type") != 1 || str(txt, "guild_id") != g.id {
		t.Fatalf("canais: %v %v", txt, voice)
	}
	// só categoria é pai
	owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "filho", "parent_id": str(txt, "id")}, 422)
	owner.call(t, "POST", base+"/channels", J{"type": 2, "name": "sub", "parent_id": str(cat, "id")}, 422)
	owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "órfão", "parent_id": "999"}, 422)
	// categoria de outro servidor não vale
	g2 := owner.createGuild(t, "Outro")
	owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "x", "parent_id": g2.categoryID}, 422)

	// renomear
	up := obj(t, owner.call(t, "PATCH", "/api/channels/"+str(txt, "id"), J{"name": "league"}, 200))
	if str(up, "name") != "league" {
		t.Fatalf("renomear: %v", up)
	}
	member.call(t, "PATCH", "/api/channels/"+str(txt, "id"), J{"name": "x"}, 403)
	stranger.call(t, "PATCH", "/api/channels/"+str(txt, "id"), J{"name": "x"}, 404)
	owner.call(t, "PATCH", "/api/channels/999", J{"name": "x"}, 404)

	// listagem ordenada por posição
	cs := arr(t, member.call(t, "GET", base+"/channels", nil, 200))
	if len(cs) != 6 {
		t.Fatalf("esperava 6 canais, veio %d", len(cs))
	}

	// reordenar em lote: move "league" para fora da categoria e inverte posições
	re := arr(t, owner.call(t, "PATCH", base+"/channels/positions", J{"channels": []J{
		{"id": str(txt, "id"), "position": 0, "parent_id": nil},
		{"id": str(voice, "id"), "position": 1, "parent_id": str(cat, "id")},
		{"id": g.textID, "position": 7, "parent_id": g.categoryID},
	}}, 200))
	got := map[string]J{}
	for _, c := range re {
		got[str(c, "id")] = c
	}
	if got[str(txt, "id")]["parent_id"] != nil || num(got[g.textID], "position") != 7 {
		t.Fatalf("reordenação não aplicada: %v", re)
	}
	for i := 1; i < len(re); i++ { // ordenado por posição
		if num(re[i-1], "position") > num(re[i], "position") {
			t.Fatalf("lista fora de ordem: %v", re)
		}
	}
	// validações do lote
	owner.call(t, "PATCH", base+"/channels/positions", J{"channels": []J{{"id": g2.textID, "position": 0, "parent_id": nil}}}, 422)
	owner.call(t, "PATCH", base+"/channels/positions", J{"channels": []J{{"id": str(txt, "id"), "position": 0, "parent_id": str(txt, "id")}}}, 422)
	owner.call(t, "PATCH", base+"/channels/positions", J{"channels": []J{{"id": str(cat, "id"), "position": 0, "parent_id": g.categoryID}}}, 422)
	owner.call(t, "PATCH", base+"/channels/positions", J{"channels": []J{{"id": str(txt, "id"), "position": 0, "parent_id": nil}, {"id": str(txt, "id"), "position": 1, "parent_id": nil}}}, 422)
	member.call(t, "PATCH", base+"/channels/positions", J{"channels": []J{}}, 403)

	// excluir categoria solta os filhos
	member.call(t, "DELETE", "/api/channels/"+str(cat, "id"), nil, 403)
	owner.call(t, "DELETE", "/api/channels/"+str(cat, "id"), nil, 204)
	owner.call(t, "DELETE", "/api/channels/"+str(cat, "id"), nil, 404)
	for _, c := range arr(t, owner.call(t, "GET", base+"/channels", nil, 200)) {
		if str(c, "id") == str(voice, "id") && c["parent_id"] != nil {
			t.Fatalf("filho deveria ter ficado sem categoria: %v", c)
		}
	}
	owner.call(t, "DELETE", "/api/channels/"+str(voice, "id"), nil, 204)
}

// ---------- convites ----------

func TestInvites(t *testing.T) {
	e := newEnvWith(t, bigLimits)
	owner, a, b, member := e.newActor(t, "dono"), e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "membro")
	g := owner.createGuild(t, "Convites")
	member.join(t, owner, g.id)
	base := "/api/guilds/" + g.id

	// código de 8 caracteres; convite padrão sem limites
	inv := obj(t, owner.call(t, "POST", base+"/invites", J{}, 201))
	code := str(inv, "code")
	if len(code) != 8 || inv["max_uses"] != nil || inv["expires_at"] != nil || num(inv, "uses") != 0 {
		t.Fatalf("convite: %v", inv)
	}
	// consultar mostra nome e nº de membros
	pv := obj(t, a.call(t, "GET", "/api/invites/"+code, nil, 200))
	if str(pv, "guild_name") != "Convites" || num(pv, "member_count") != 2 || str(pv, "guild_id") != g.id {
		t.Fatalf("prévia: %v", pv)
	}
	a.call(t, "GET", "/api/invites/naoexiste", nil, 404)
	a.call(t, "GET", "/api/invites/abcdefgh", nil, 404)

	// entrar; reentrar não consome uso
	j := obj(t, a.call(t, "POST", "/api/invites/"+code, nil, 200))
	if str(j, "id") != g.id || len(list(j, "channels")) != 3 {
		t.Fatalf("entrada devolve o servidor completo: %v", j)
	}
	a.call(t, "POST", "/api/invites/"+code, nil, 200)
	owner.call(t, "POST", "/api/invites/"+code, nil, 200) // dono já é membro
	var used int64 = -1
	for _, i := range arr(t, owner.call(t, "GET", base+"/invites", nil, 200)) {
		if str(i, "code") == code {
			used = num(i, "uses")
		}
	}
	if used != 1 { // só a entrada de "a" consumiu; reentrada e dono não
		t.Fatalf("usos = %d, esperado 1", used)
	}
	ms := obj(t, owner.call(t, "GET", base+"/members", nil, 200))
	if len(list(ms, "members")) != 3 {
		t.Fatalf("membros: %v", ms)
	}

	// listar exige MANAGE_GUILD; membro comum pode criar (CREATE_INVITE) mas não listar
	member.call(t, "GET", base+"/invites", nil, 403)
	a.call(t, "GET", base+"/invites", nil, 403)
	b.call(t, "GET", base+"/invites", nil, 404)
	b.call(t, "POST", base+"/invites", J{}, 404)
	mine := obj(t, member.call(t, "POST", base+"/invites", J{}, 201))

	// validação
	owner.call(t, "POST", base+"/invites", J{"max_uses": 0}, 422)
	owner.call(t, "POST", base+"/invites", J{"expires_in": 0}, 422)

	// esgotado: max_uses=1
	one := str(obj(t, owner.call(t, "POST", base+"/invites", J{"max_uses": 1}, 201)), "code")
	b.call(t, "POST", "/api/invites/"+one, nil, 200)
	c := e.newActor(t, "c")
	c.call(t, "POST", "/api/invites/"+one, nil, 410)
	c.call(t, "GET", "/api/invites/"+one, nil, 410)
	b.call(t, "POST", "/api/invites/"+one, nil, 200) // membro: não consome nem falha
	c.call(t, "GET", base, nil, 404)

	// expirado
	exp := str(obj(t, owner.call(t, "POST", base+"/invites", J{"expires_in": 1}, 201)), "code")
	c.call(t, "GET", "/api/invites/"+exp, nil, 200)
	time.Sleep(1200 * time.Millisecond)
	c.call(t, "GET", "/api/invites/"+exp, nil, 410)
	c.call(t, "POST", "/api/invites/"+exp, nil, 410)

	// revogar: criador ou MANAGE_GUILD
	a.call(t, "DELETE", "/api/invites/"+str(mine, "code"), nil, 403)
	c.call(t, "DELETE", "/api/invites/"+str(mine, "code"), nil, 404)
	member.call(t, "DELETE", "/api/invites/"+str(mine, "code"), nil, 204)
	c.call(t, "POST", "/api/invites/"+str(mine, "code"), nil, 404)
	owner.call(t, "DELETE", "/api/invites/"+one, nil, 204) // MANAGE_GUILD (dono)
	owner.call(t, "DELETE", "/api/invites/"+one, nil, 404)
}

func TestInviteMaxUsesRace(t *testing.T) {
	e := newEnvWith(t, bigLimits)
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Corrida")
	const racers, uses = 8, 3
	code := str(obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/invites", J{"max_uses": uses}, 201)), "code")

	users := make([]*actor, racers)
	for i := range users {
		users[i] = e.newActor(t, fmt.Sprintf("r%d", i))
	}
	var wg sync.WaitGroup
	results := make([]int, racers)
	start := make(chan struct{})
	for i, u := range users {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			resp, _ := u.do(t, "POST", "/api/invites/"+code, nil)
			results[i] = resp.StatusCode
		}()
	}
	close(start)
	wg.Wait()
	ok, gone := 0, 0
	for _, s := range results {
		switch s {
		case 200:
			ok++
		case 410:
			gone++
		default:
			t.Fatalf("status inesperado na corrida: %v", results)
		}
	}
	if ok != uses || gone != racers-uses {
		invs := arr(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/invites", nil, 200))
		ms := obj(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/members", nil, 200))
		t.Fatalf("esperava %d entradas e %d recusas, veio %v (uses=%v, membros=%d)", uses, racers-uses, results, invs[0]["uses"], len(list(ms, "members")))
	}
	invs := arr(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/invites", nil, 200))
	if num(invs[0], "uses") != uses {
		t.Fatalf("uses = %d, esperado %d", num(invs[0], "uses"), uses)
	}
	ms := obj(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/members", nil, 200))
	if len(list(ms, "members")) != 1+uses {
		t.Fatalf("membros = %d", len(list(ms, "members")))
	}
}

// ---------- mensagens ----------

func TestMessages(t *testing.T) {
	e := newEnvWith(t, bigLimits)
	owner, member, stranger := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "fora")
	g := owner.createGuild(t, "Mensagens")
	member.join(t, owner, g.id)
	ch := "/api/channels/" + g.textID + "/messages"

	send := func(a *actor, content string, want int) J {
		t.Helper()
		b := a.call(t, "POST", ch, J{"content": content}, want)
		if want == 201 {
			return obj(t, b)
		}
		return nil
	}

	m1 := send(member, "olá, mundo", 201)
	author := m1["author"].(J)
	if str(m1, "content") != "olá, mundo" || str(author, "id") != member.id || str(author, "username") != member.name ||
		str(m1, "channel_id") != g.textID || m1["edited_at"] != nil || str(m1, "created_at") == "" {
		t.Fatalf("mensagem: %v", m1)
	}
	if ts, err := time.Parse(time.RFC3339Nano, str(m1, "created_at")); err != nil || time.Since(ts) > time.Minute || time.Until(ts) > time.Minute {
		t.Fatalf("created_at deve vir do snowflake: %v (%v)", m1["created_at"], err)
	}

	// validações: vazio, só espaços, 2000 runes ok, 2001 não, canal de voz, canal inexistente
	send(member, "", 422)
	send(member, "   \n\t ", 422)
	send(member, strings.Repeat("é", 2000), 201)
	send(member, strings.Repeat("é", 2001), 422)
	member.call(t, "POST", "/api/channels/"+g.voiceID+"/messages", J{"content": "oi"}, 422)
	member.call(t, "POST", "/api/channels/999/messages", J{"content": "oi"}, 404)
	member.call(t, "POST", "/api/channels/abc/messages", J{"content": "oi"}, 404)

	// não-membro: canal inexistente
	stranger.call(t, "POST", ch, J{"content": "oi"}, 404)
	stranger.call(t, "GET", ch, nil, 404)
	stranger.call(t, "PATCH", ch+"/"+str(m1, "id"), J{"content": "x"}, 404)
	stranger.call(t, "DELETE", ch+"/"+str(m1, "id"), nil, 404)

	// histórico: ordem decrescente, cursor e has_more
	var ids []string
	for i := 0; i < 7; i++ {
		ids = append(ids, str(send(owner, fmt.Sprintf("msg %d", i), 201), "id"))
	}
	p1 := obj(t, member.call(t, "GET", ch+"?limit=3", nil, 200))
	ms := list(p1, "messages")
	if len(ms) != 3 || p1["has_more"] != true || str(ms[0], "id") != ids[6] || str(ms[2], "id") != ids[4] {
		t.Fatalf("página 1: %v", p1)
	}
	p2 := obj(t, member.call(t, "GET", ch+"?limit=3&before="+str(ms[2], "id"), nil, 200))
	ms2 := list(p2, "messages")
	if len(ms2) != 3 || str(ms2[0], "id") != ids[3] || p2["has_more"] != true {
		t.Fatalf("página 2: %v", p2)
	}
	all := obj(t, member.call(t, "GET", ch+"?limit=100", nil, 200))
	if len(list(all, "messages")) != 10 || all["has_more"] != false {
		t.Fatalf("tudo: %d has_more=%v", len(list(all, "messages")), all["has_more"])
	}
	def := obj(t, member.call(t, "GET", ch, nil, 200)) // padrão 50
	if len(list(def, "messages")) != 10 {
		t.Fatalf("padrão: %v", def)
	}
	member.call(t, "GET", ch+"?limit=0", nil, 422)
	member.call(t, "GET", ch+"?limit=101", nil, 422)
	member.call(t, "GET", ch+"?before=xx", nil, 422)

	// last_message_id acompanha a última mensagem
	d := obj(t, owner.call(t, "GET", "/api/guilds/"+g.id, nil, 200))
	for _, c := range list(d, "channels") {
		if str(c, "id") == g.textID && str(c, "last_message_id") != ids[6] {
			t.Fatalf("last_message_id = %v, esperado %s", c["last_message_id"], ids[6])
		}
	}

	// editar: só o autor, seta edited_at
	ed := obj(t, member.call(t, "PATCH", ch+"/"+str(m1, "id"), J{"content": "editada"}, 200))
	if str(ed, "content") != "editada" || ed["edited_at"] == nil {
		t.Fatalf("edição: %v", ed)
	}
	owner.call(t, "PATCH", ch+"/"+str(m1, "id"), J{"content": "do dono"}, 403) // nem o dono edita a dos outros
	member.call(t, "PATCH", ch+"/"+str(m1, "id"), J{"content": "  "}, 422)
	member.call(t, "PATCH", ch+"/999", J{"content": "x"}, 404)

	// excluir: autor ou MANAGE_MESSAGES; some das listas na hora
	third := e.newActor(t, "terceiro")
	third.join(t, owner, g.id)
	third.call(t, "DELETE", ch+"/"+str(m1, "id"), nil, 403)
	member.call(t, "DELETE", ch+"/"+str(m1, "id"), nil, 204)
	member.call(t, "DELETE", ch+"/"+str(m1, "id"), nil, 404)
	member.call(t, "PATCH", ch+"/"+str(m1, "id"), J{"content": "ressuscitar"}, 404) // apagada = 404
	after := obj(t, member.call(t, "GET", ch+"?limit=100", nil, 200))
	for _, m := range list(after, "messages") {
		if str(m, "id") == str(m1, "id") {
			t.Fatal("mensagem apagada continua na lista")
		}
	}
	mm := owner.role(t, g.id, J{"name": "moderador", "permissions": int64(perm.ManageMessages)})
	owner.giveRole(t, g.id, third.id, str(mm, "id"))
	third.call(t, "DELETE", ch+"/"+ids[0], nil, 204) // MANAGE_MESSAGES apaga a dos outros
	owner.call(t, "DELETE", ch+"/"+ids[1], nil, 204) // o dono também

	// sem VIEW_CHANNEL / SEND_MESSAGES: 403 (é membro, mas sem permissão)
	owner.call(t, "PATCH", "/api/guilds/"+g.id+"/roles/"+g.id, J{"permissions": int64(perm.ViewChannel)}, 200)
	member.call(t, "POST", ch, J{"content": "mudo"}, 403)
	member.call(t, "GET", ch, nil, 200)
	owner.call(t, "PATCH", "/api/guilds/"+g.id+"/roles/"+g.id, J{"permissions": 0}, 200)
	member.call(t, "GET", ch, nil, 403)
	if d := obj(t, member.call(t, "GET", "/api/guilds/"+g.id, nil, 200)); len(list(d, "channels")) != 0 {
		t.Fatalf("sem VIEW_CHANNEL não deve listar canais: %v", d["channels"])
	}
}

func TestMessageRateLimit(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) { d.APILimiter = ratelimit.New(100000, 100000) }) // MsgLimiter padrão: 5 / 5 s
	owner, other := e.newActor(t, "dono"), e.newActor(t, "outro")
	g := owner.createGuild(t, "Limite")
	other.join(t, owner, g.id)
	second := obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "segundo"}, 201))
	ch := "/api/channels/" + g.textID + "/messages"

	for i := 0; i < 5; i++ {
		owner.call(t, "POST", ch, J{"content": fmt.Sprintf("m%d", i)}, 201)
	}
	resp, b := owner.do(t, "POST", ch, J{"content": "m6"})
	status(t, resp, b, 429)
	if ra := resp.Header.Get("Retry-After"); ra == "" || ra == "0" {
		t.Fatalf("Retry-After ausente: %q", ra)
	}
	// o limite é por usuário e por canal
	other.call(t, "POST", ch, J{"content": "outro usuário"}, 201)
	owner.call(t, "POST", "/api/channels/"+str(second, "id")+"/messages", J{"content": "outro canal"}, 201)
	// e a vaga volta com o tempo
	time.Sleep(1100 * time.Millisecond)
	owner.call(t, "POST", ch, J{"content": "de novo"}, 201)
}

// ---------- eventos ----------

type collector struct {
	mu  sync.Mutex
	got []events.Event
}

func (c *collector) add(ev events.Event) { c.mu.Lock(); c.got = append(c.got, ev); c.mu.Unlock() }

// find espera até 3 s por um evento do tipo typ que satisfaça ok.
func (c *collector) find(t *testing.T, typ string, ok func(events.Event) bool) events.Event {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		for _, ev := range c.got {
			if ev.Type == typ && (ok == nil || ok(ev)) {
				c.mu.Unlock()
				return ev
			}
		}
		c.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("evento %s não publicado; recebidos: %v", typ, c.types())
	return events.Event{}
}

func (c *collector) types() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, ev := range c.got {
		out = append(out, ev.Type)
	}
	return out
}

func toJ(t *testing.T, v any) J {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return obj(t, b)
}

func TestOperationsPublishEvents(t *testing.T) {
	bus := events.NewBus(1024)
	col := &collector{}
	cancel := bus.Subscribe(col.add)
	defer cancel()
	e := newEnvWith(t, func(d *Deps) { bigLimits(d); d.Bus = bus })

	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := owner.createGuild(t, "Eventos")
	gTopic, uTopic := "guild:"+g.id, "user:"+owner.id

	// GUILD_CREATE: tópico do usuário, payload completo
	ev := col.find(t, events.GuildCreate, func(ev events.Event) bool { return ev.Topics[0] == uTopic })
	if p := toJ(t, ev.Data); str(p, "id") != g.id || len(list(p, "channels")) != 3 || ev.Topics[0] != uTopic {
		t.Fatalf("GUILD_CREATE: %+v", ev)
	}

	// entrada por convite: GUILD_CREATE para o novo membro + GUILD_MEMBER_ADD na guilda
	member.join(t, owner, g.id)
	col.find(t, events.GuildCreate, func(ev events.Event) bool { return ev.Topics[0] == "user:"+member.id })
	ev = col.find(t, events.GuildMemberAdd, nil)
	if p := toJ(t, ev.Data); str(p, "user_id") != member.id || ev.Topics[0] != gTopic {
		t.Fatalf("GUILD_MEMBER_ADD: %+v", ev)
	}

	owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"name": "Eventos 2"}, 200)
	ev = col.find(t, events.GuildUpdate, nil)
	if toJ(t, ev.Data)["name"] != "Eventos 2" || ev.Topics[0] != gTopic || ev.GuildID == 0 {
		t.Fatalf("GUILD_UPDATE: %+v", ev)
	}

	// cargos
	r := owner.role(t, g.id, J{"name": "vip", "position": 1})
	col.find(t, events.RoleCreate, func(ev events.Event) bool { return str(toJ(t, ev.Data), "id") == str(r, "id") })
	owner.call(t, "PATCH", "/api/guilds/"+g.id+"/roles/"+str(r, "id"), J{"name": "vip2"}, 200)
	col.find(t, events.RoleUpdate, func(ev events.Event) bool { return toJ(t, ev.Data)["name"] == "vip2" })
	owner.giveRole(t, g.id, member.id, str(r, "id"))
	ev = col.find(t, events.GuildMemberUpdate, nil)
	if p := toJ(t, ev.Data); str(p, "user_id") != member.id || len(list2(p, "role_ids")) != 1 {
		t.Fatalf("GUILD_MEMBER_UPDATE: %+v", ev)
	}
	owner.call(t, "DELETE", "/api/guilds/"+g.id+"/roles/"+str(r, "id"), nil, 204)
	ev = col.find(t, events.RoleDelete, nil)
	if p := toJ(t, ev.Data); str(p, "role_id") != str(r, "id") || ev.Topics[0] != gTopic {
		t.Fatalf("ROLE_DELETE: %+v", ev)
	}

	// canais
	c := obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "novo"}, 201))
	ev = col.find(t, events.ChannelCreate, func(ev events.Event) bool { return ev.ChannelID != 0 })
	if ev.GuildID == 0 || ev.Topics[0] != gTopic || str(toJ(t, ev.Data), "id") != str(c, "id") {
		t.Fatalf("CHANNEL_CREATE: %+v", ev)
	}
	owner.call(t, "PATCH", "/api/channels/"+str(c, "id"), J{"name": "novo2"}, 200)
	col.find(t, events.ChannelUpdate, func(ev events.Event) bool { return toJ(t, ev.Data)["name"] == "novo2" })
	owner.call(t, "DELETE", "/api/channels/"+str(c, "id"), nil, 204)
	col.find(t, events.ChannelDelete, func(ev events.Event) bool { return str(toJ(t, ev.Data), "id") == str(c, "id") })

	// mensagens: tópico channel:<id>, com GuildID e ChannelID
	ch := "/api/channels/" + g.textID + "/messages"
	m := obj(t, member.call(t, "POST", ch, J{"content": "oi"}, 201))
	ev = col.find(t, events.MessageCreate, func(ev events.Event) bool { return str(toJ(t, ev.Data), "id") == str(m, "id") })
	if ev.Topics[0] != "channel:"+g.textID || fmt.Sprint(ev.ChannelID) != g.textID || fmt.Sprint(ev.GuildID) != g.id ||
		str(toJ(t, ev.Data), "id") != str(m, "id") {
		t.Fatalf("MESSAGE_CREATE: %+v", ev)
	}
	member.call(t, "PATCH", ch+"/"+str(m, "id"), J{"content": "oi!"}, 200)
	ev = col.find(t, events.MessageUpdate, nil)
	if toJ(t, ev.Data)["content"] != "oi!" || ev.Topics[0] != "channel:"+g.textID {
		t.Fatalf("MESSAGE_UPDATE: %+v", ev)
	}
	member.call(t, "DELETE", ch+"/"+str(m, "id"), nil, 204)
	ev = col.find(t, events.MessageDelete, nil)
	if p := toJ(t, ev.Data); str(p, "id") != str(m, "id") || str(p, "guild_id") != g.id || fmt.Sprint(ev.GuildID) != g.id {
		t.Fatalf("MESSAGE_DELETE: %+v", ev)
	}

	// sair e expulsar: GUILD_MEMBER_REMOVE na guilda + GUILD_DELETE para o ex-membro
	member.call(t, "DELETE", "/api/guilds/"+g.id+"/members/@me", nil, 204)
	col.find(t, events.GuildMemberRemove, func(ev events.Event) bool { return str(toJ(t, ev.Data), "user_id") == member.id })
	col.find(t, events.GuildDelete, func(ev events.Event) bool { return ev.Topics[0] == "user:"+member.id })

	// excluir o servidor
	owner.confirm(t, pw, 200)
	owner.call(t, "DELETE", "/api/guilds/"+g.id, nil, 204)
	ev = col.find(t, events.GuildDelete, func(ev events.Event) bool { return ev.Topics[0] == gTopic })
	if str(toJ(t, ev.Data), "id") != g.id {
		t.Fatalf("GUILD_DELETE: %+v", ev)
	}
}

func TestServerTimingHasDBMetric(t *testing.T) {
	e := newEnvWith(t, bigLimits)
	u := e.newActor(t, "tempo")
	u.createGuild(t, "Tempo")
	resp, b := u.do(t, "GET", "/api/guilds", nil)
	status(t, resp, b, 200)
	if st := resp.Header.Get("Server-Timing"); !strings.Contains(st, "db;dur=") {
		t.Fatalf("Server-Timing sem db: %q", st)
	}
}
