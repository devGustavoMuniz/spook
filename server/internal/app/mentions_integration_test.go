//go:build integration

package app

import (
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/limits"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

func mentionsCfg(d *Deps) {
	gwCfg(d)
	d.AuthLimiter = ratelimit.New(100000, 100000)
	d.PasswordLimiter = ratelimit.New(100000, 100000)
	d.ModLimiter = ratelimit.New(100000, 100000)
}

func (a *actor) messages(t *testing.T, channelID string) []J {
	t.Helper()
	return list(obj(t, a.call(t, "GET", "/api/channels/"+channelID+"/messages?limit=100", nil, 200)), "messages")
}

func countKind(ms []J, kind string) int {
	n := 0
	for _, m := range ms {
		if str(m, "kind") == kind {
			n++
		}
	}
	return n
}

// ---------- mensagem de sistema "fulano entrou" ----------

func TestMemberJoinSystemMessage(t *testing.T) {
	e := newEnvWith(t, mentionsCfg)
	owner, u1, u2, u3 := e.newActor(t, "dono"), e.newActor(t, "novo"), e.newActor(t, "novo"), e.newActor(t, "novo")
	g := owner.createGuild(t, "Boas-vindas")
	ws := owner.connect(t)
	ws.identify()

	u1.join(t, owner, g.id)
	f := ws.event("MESSAGE_CREATE")
	if p := payload(t, f); str(p, "kind") != "member_join" || str(obj2(p, "author"), "id") != u1.id || str(p, "content") != "" {
		t.Fatalf("MESSAGE_CREATE da entrada: %s", f.D)
	}
	ms := owner.messages(t, g.textID)
	if countKind(ms, "member_join") != 1 || ms[0]["kind"] != "member_join" {
		t.Fatalf("mensagens: %v", ms)
	}
	// não conta como não lida nem como menção, e o dono (que ficou "lendo") não é avisado
	if u, m := owner.counts(t, g.textID); u != 0 || m != 0 {
		t.Fatalf("contadores do dono: unread=%d mentions=%d", u, m)
	}
	sysID := str(ms[0], "id")

	// não editável nem respondível; só quem gerencia mensagens apaga
	u1.call(t, "PATCH", "/api/channels/"+g.textID+"/messages/"+sysID, J{"content": "x"}, 422)
	u1.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "oi", "reply_to": sysID}, 422)
	u1.call(t, "DELETE", "/api/channels/"+g.textID+"/messages/"+sysID, nil, 403)

	// sair e entrar de novo no mesmo minuto não duplica
	u1.call(t, "DELETE", "/api/guilds/"+g.id+"/members/@me", nil, 204)
	u1.join(t, owner, g.id)
	if n := countKind(owner.messages(t, g.textID), "member_join"); n != 1 {
		t.Fatalf("reentrada no mesmo minuto duplicou: %d", n)
	}

	// canal de sistema configurável: precisa ser canal de texto do servidor
	other := obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "chegadas"}, 201))
	owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"system_channel_id": g.voiceID}, 422)
	owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"system_channel_id": "abc"}, 422)
	u1.call(t, "PATCH", "/api/guilds/"+g.id, J{"system_join_enabled": false}, 403)
	d := obj(t, owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"system_channel_id": str(other, "id")}, 200))
	if str(d, "system_channel_id") != str(other, "id") || d["system_join_enabled"] != true {
		t.Fatalf("guild: %v", d)
	}
	u2.join(t, owner, g.id)
	if n := countKind(owner.messages(t, str(other, "id")), "member_join"); n != 1 {
		t.Fatalf("mensagem no canal de sistema: %d", n)
	}
	if n := countKind(owner.messages(t, g.textID), "member_join"); n != 1 {
		t.Fatalf("o canal antigo não recebe mais: %d", n)
	}

	// interruptor
	owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"system_join_enabled": false}, 200)
	u3.join(t, owner, g.id)
	if n := countKind(owner.messages(t, str(other, "id")), "member_join"); n != 1 {
		t.Fatalf("desligado não deveria enviar: %d", n)
	}
	// o canal de sistema apagado volta ao padrão (primeiro canal de texto)
	owner.call(t, "PATCH", "/api/guilds/"+g.id, J{"system_join_enabled": true}, 200)
	owner.call(t, "DELETE", "/api/channels/"+str(other, "id"), nil, 204)
	if d := obj(t, owner.call(t, "GET", "/api/guilds/"+g.id, nil, 200)); d["system_channel_id"] != nil {
		t.Fatalf("system_channel_id deveria zerar: %v", d["system_channel_id"])
	}
}

// ---------- @everyone, @here e cargos ----------

func TestEveryoneHereAndRoleMentions(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		mentionsCfg(d)
		d.EveryoneLimiter = ratelimit.New(0.5, 1) // como o real (1 por 30 s), mas com janela de 2 s para o teste esperar
	})
	owner, poster, u2, u3 := e.newActor(t, "dono"), e.newActor(t, "autor"), e.newActor(t, "membro"), e.newActor(t, "offline")
	g := owner.createGuild(t, "Menções")
	for _, u := range []*actor{poster, u2, u3} {
		u.join(t, owner, g.id)
	}
	// deixa a mensagem de entrada para trás: todos leem o canal
	last := str(owner.messages(t, g.textID)[0], "id")
	for _, u := range []*actor{owner, poster, u2, u3} {
		u.ack(t, g.textID, last, 200)
	}

	// 1) sem MENTION_EVERYONE: vira texto, ninguém é notificado
	m := poster.say(t, g.textID, "oi @everyone e @here", 201)
	if m["mention_everyone"] != false || m["mention_here"] != false {
		t.Fatalf("sem permissão: %v", m)
	}
	u2.waitCounts(t, g.textID, 1, 0)
	if _, mc := owner.counts(t, g.textID); mc != 0 {
		t.Fatalf("sem permissão não notifica: %d", mc)
	}

	// 2) com a permissão: notifica todos que veem o canal, menos o autor; e o rate limit vale
	owner.grantRole(t, g.id, poster, "anunciante", 5, perm.MentionEveryone)
	m = poster.say(t, g.textID, "reunião @everyone", 201)
	if m["mention_everyone"] != true {
		t.Fatalf("com permissão: %v", m)
	}
	u2.waitCounts(t, g.textID, 2, 1)
	u3.waitCounts(t, g.textID, 2, 1)
	owner.waitCounts(t, g.textID, 2, 1)
	if _, mc := poster.counts(t, g.textID); mc != 0 {
		t.Fatalf("o autor não se notifica: %d", mc)
	}
	resp, b := poster.do(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "@here de novo"})
	status(t, resp, b, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}
	poster.say(t, g.textID, "texto comum continua livre", 201)

	// 3) @everyone só atinge quem VÊ o canal (overwrites): canal privado
	priv := obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "privado"}, 201))
	pid := str(priv, "id")
	owner.call(t, "PUT", "/api/channels/"+pid+"/overwrites/role/"+g.id, J{"allow": 0, "deny": int64(perm.ViewChannel)}, 200)
	owner.call(t, "PUT", "/api/channels/"+pid+"/overwrites/member/"+u2.id, J{"allow": int64(perm.ViewChannel), "deny": 0}, 200)
	owner.call(t, "PUT", "/api/channels/"+pid+"/overwrites/member/"+poster.id, J{"allow": int64(perm.ViewChannel | perm.SendMessages), "deny": 0}, 200)
	time.Sleep(2200 * time.Millisecond)
	poster.say(t, pid, "segredo @everyone", 201)
	u2.waitCounts(t, pid, 1, 1)
	u3.call(t, "GET", "/api/channels/"+pid+"/messages", nil, 403)
	for _, rs := range list(obj(t, u3.call(t, "GET", "/api/users/@me/read-states", nil, 200)), "read_states") {
		if str(rs, "channel_id") == pid {
			t.Fatalf("u3 não vê o canal privado: %v", rs)
		}
	}

	// 4) @here: só quem está online (u2 conectado; u3 e o dono, não)
	ws := u2.connect(t)
	ws.identify()
	time.Sleep(400 * time.Millisecond) // a presença é publicada de forma assíncrona
	time.Sleep(2200 * time.Millisecond)
	for _, u := range []*actor{owner, u2, u3} {
		u.ack(t, g.textID, str(poster.messages(t, g.textID)[0], "id"), 200)
	}
	poster.say(t, g.textID, "alguém aí? @here", 201)
	u2.waitCounts(t, g.textID, 1, 1)
	time.Sleep(300 * time.Millisecond)
	if _, mc := u3.counts(t, g.textID); mc != 0 {
		t.Fatalf("@here não atinge quem está offline: %d", mc)
	}

	// 5) "Suprimir @everyone e @here" no servidor
	u2.putSetting(t, "guild", g.id, J{"suppress_everyone": true}, 200)
	if s := u2.settings(t); len(s) != 1 || s[0]["suppress_everyone"] != true {
		t.Fatalf("settings: %v", s)
	}
	u2.call(t, "PUT", "/api/users/@me/notification-settings/channel/"+g.textID, J{"suppress_everyone": true}, 422)
	time.Sleep(2200 * time.Millisecond)
	for _, u := range []*actor{owner, u2, u3} {
		u.ack(t, g.textID, str(poster.messages(t, g.textID)[0], "id"), 200)
	}
	poster.say(t, g.textID, "@everyone fim", 201)
	u3.waitCounts(t, g.textID, 1, 1)
	time.Sleep(300 * time.Millisecond)
	if _, mc := u2.counts(t, g.textID); mc != 0 {
		t.Fatalf("quem suprime não é notificado: %d", mc)
	}
}

func TestRoleMentions(t *testing.T) {
	e := newEnvWith(t, mentionsCfg)
	owner, member, other := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "outro")
	g := owner.createGuild(t, "Cargos")
	member.join(t, owner, g.id)
	other.join(t, owner, g.id)
	role := owner.role(t, g.id, J{"name": "Equipe Azul", "position": 1})
	if role["mentionable"] != false {
		t.Fatalf("padrão deveria ser não mencionável: %v", role)
	}
	rid := str(role, "id")
	owner.giveRole(t, g.id, member.id, rid)
	owner.call(t, "POST", "/api/guilds/"+g.id+"/roles", J{"name": "Everyone"}, 422) // reservado
	owner.call(t, "POST", "/api/guilds/"+g.id+"/roles", J{"name": "@here"}, 422)
	last := str(owner.messages(t, g.textID)[0], "id")
	for _, u := range []*actor{owner, member, other} {
		u.ack(t, g.textID, last, 200)
	}

	// cargo não mencionável: quem não tem MENTION_EVERYONE só escreve o texto
	m := other.say(t, g.textID, "chamando @Equipe Azul", 201)
	if len(list2(m, "mention_roles")) != 0 {
		t.Fatalf("não mencionável: %v", m)
	}
	member.waitCounts(t, g.textID, 1, 0)

	// o gestor liga "mencionável": qualquer um pode mencionar
	owner.call(t, "PATCH", "/api/guilds/"+g.id+"/roles/"+rid, J{"mentionable": true}, 200)
	m = other.say(t, g.textID, "agora sim @equipe azul!", 201)
	if mr := list2(m, "mention_roles"); len(mr) != 1 || mr[0] != rid {
		t.Fatalf("mencionável: %v", m)
	}
	member.waitCounts(t, g.textID, 2, 1)
	if _, mc := owner.counts(t, g.textID); mc != 0 {
		t.Fatalf("o dono não tem o cargo: %d", mc)
	}
	if _, mc := other.counts(t, g.textID); mc != 0 {
		t.Fatalf("o autor não se notifica: %d", mc)
	}
	l := obj(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/audit-logs?action=role.update", nil, 200))
	if hasAudit(list(l, "entries"), string(audit.RoleUpdate), rid) == nil {
		t.Fatalf("auditoria da mudança de mentionable: %v", l)
	}
	// o cargo também aparece no GUILD/roles
	for _, r := range list(obj(t, owner.call(t, "GET", "/api/guilds/"+g.id, nil, 200)), "roles") {
		if str(r, "id") == rid && r["mentionable"] != true {
			t.Fatalf("roles: %v", r)
		}
	}
}

// ---------- tópico do canal ----------

func TestChannelTopic(t *testing.T) {
	e := newEnvWith(t, mentionsCfg)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := owner.createGuild(t, "Tópicos")
	member.join(t, owner, g.id)
	ws := member.connect(t)
	ws.identify()
	url := "/api/channels/" + g.textID

	member.call(t, "PATCH", url, J{"topic": "x"}, 403)
	c := obj(t, owner.call(t, "PATCH", url, J{"topic": "  Regras: sem spam  "}, 200))
	if str(c, "topic") != "Regras: sem spam" || str(c, "name") != "geral" {
		t.Fatalf("canal: %v", c)
	}
	if p := payload(t, ws.event("CHANNEL_UPDATE")); str(p, "topic") != "Regras: sem spam" {
		t.Fatalf("CHANNEL_UPDATE: %v", p)
	}
	owner.call(t, "PATCH", url, J{"topic": strings.Repeat("a", 1025)}, 422)
	owner.call(t, "PATCH", "/api/channels/"+g.voiceID, J{"topic": "x"}, 422)
	if c = obj(t, owner.call(t, "PATCH", url, J{"name": "novo-nome"}, 200)); str(c, "topic") != "Regras: sem spam" {
		t.Fatalf("renomear não apaga o tópico: %v", c)
	}
	var found bool
	for _, ch := range list(obj(t, member.call(t, "GET", "/api/guilds/"+g.id, nil, 200)), "channels") {
		if str(ch, "id") == g.textID {
			found = str(ch, "topic") == "Regras: sem spam"
		}
	}
	if !found {
		t.Fatal("o tópico deveria vir no detalhe do servidor")
	}
	l := obj(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/audit-logs?action=channel.update", nil, 200))
	if hasAudit(list(l, "entries"), string(audit.ChannelUpdate), g.textID) == nil {
		t.Fatalf("auditoria: %v", l)
	}
	if c = obj(t, owner.call(t, "PATCH", url, J{"topic": ""}, 200)); c["topic"] != nil {
		t.Fatalf("vazio remove: %v", c)
	}
}

// ---------- limites configuráveis ----------

func TestConfigurableLimits(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		mentionsCfg(d)
		d.Cfg.Limits = limits.Limits{GuildsPerUser: 2, ChannelsPerGuild: 5, MembersPerGuild: 3, RolesPerGuild: 3, InvitesPerGuild: 2, AttachmentBytes: 1 << 20}
	})
	owner, a, b, c := e.newActor(t, "dono"), e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "c")
	g := owner.createGuild(t, "Um")
	owner.createGuild(t, "Dois")
	resp, body := owner.do(t, "POST", "/api/guilds", J{"name": "Três"})
	status(t, resp, body, 409)
	if !strings.Contains(string(body), "2 servidores") {
		t.Fatalf("mensagem: %s", body)
	}

	// canais: 3 iniciais + 2
	for i := 0; i < 2; i++ {
		owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "extra"}, 201)
	}
	owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "extra"}, 409)

	// cargos: @everyone + 2
	owner.role(t, g.id, J{"name": "r1"})
	owner.role(t, g.id, J{"name": "r2"})
	owner.call(t, "POST", "/api/guilds/"+g.id+"/roles", J{"name": "r3"}, 409)

	// convites ativos: 2
	owner.invite(t, g.id)
	owner.invite(t, g.id)
	owner.call(t, "POST", "/api/guilds/"+g.id+"/invites", J{}, 409)

	// membros: dono + 2 (cada convite acima serve a quem entrar)
	code := str(arr(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/invites", nil, 200))[0], "code")
	a.call(t, "POST", "/api/invites/"+code, nil, 200)
	b.call(t, "POST", "/api/invites/"+code, nil, 200)
	resp, body = c.do(t, "POST", "/api/invites/"+code, nil)
	status(t, resp, body, 409)
	if !strings.Contains(string(body), "3 membros") {
		t.Fatalf("mensagem: %s", body)
	}

	// anexo: 1 MB
	resp, body = owner.do(t, "POST", "/api/channels/"+g.textID+"/uploads", J{"filename": "a.zip", "content_type": "application/zip", "size": 2 << 20})
	if resp.StatusCode != 422 && resp.StatusCode != 503 {
		t.Fatalf("anexo acima do limite: %d %s", resp.StatusCode, body)
	}
	if resp.StatusCode == 422 && !strings.Contains(string(body), "1 MB") {
		t.Fatalf("mensagem: %s", body)
	}
}
