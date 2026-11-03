//go:build integration

package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

func socialCfg(d *Deps) {
	p4Cfg(d)
	d.FriendRequestLimiter = ratelimit.New(100000, 100000)
	d.SocialLimiter = ratelimit.New(100000, 100000)
	d.CallLimiter = ratelimit.New(100000, 100000)
	d.Cfg.PublicURL = "http://spook.test"
}

func (a *actor) befriend(t *testing.T, b *actor) {
	t.Helper()
	a.call(t, "POST", "/api/users/me/friends", J{"username": b.name}, 201)
	b.call(t, "PUT", "/api/users/me/friends/"+a.id, nil, 200)
}

func (a *actor) rel(t *testing.T, other *actor) string {
	t.Helper()
	return str(obj(t, a.call(t, "GET", "/api/users/"+other.id+"/relationship", nil, 200)), "type")
}

func (a *actor) relationships(t *testing.T, query string) []J {
	t.Helper()
	return list(obj(t, a.call(t, "GET", "/api/users/me/relationships"+query, nil, 200)), "items")
}

func hasUser(items []J, id string) bool {
	for _, it := range items {
		if str(obj2(it, "user"), "id") == id {
			return true
		}
	}
	return false
}

// relEvent lê até chegar o evento name sobre a pessoa user (RELATIONSHIP_ADD/UPDATE trazem user.id; REMOVE, user_id).
func (c *wsClient) relEvent(name, user string) J {
	c.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			break
		}
		if isEvent(f, name) {
			p := payload(c.t, f)
			if str(obj2(p, "user"), "id") == user || str(p, "user_id") == user {
				return p
			}
		}
	}
	c.t.Fatalf("%s sobre %s não chegou", name, user)
	return nil
}

var relEvents = []string{"RELATIONSHIP_ADD", "RELATIONSHIP_UPDATE", "RELATIONSHIP_REMOVE"}

func TestFriendshipFlow(t *testing.T) {
	e := newEnvWith(t, socialCfg)
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "beto"), e.newActor(t, "caio")
	ac, _ := a.connectReady(t)
	bc, _ := b.connectReady(t)
	cc, _ := c.connectReady(t)

	// 401 sem sessão; validações.
	resp, body := e.do(t, "GET", "/api/users/me/relationships", nil, nil)
	status(t, resp, body, 401)
	a.call(t, "POST", "/api/users/me/friends", J{"username": a.name}, 422)
	a.call(t, "POST", "/api/users/me/friends", J{"username": "nao_existe_xyz"}, 404)
	a.call(t, "POST", "/api/users/me/friends", J{"username": ""}, 422)
	a.call(t, "GET", "/api/users/me/relationships?type=lixo", nil, 422)
	a.call(t, "PUT", "/api/users/me/friends/"+b.id, nil, 404) // sem pedido
	a.call(t, "PUT", "/api/users/me/friends/abc", nil, 404)
	a.call(t, "GET", "/api/users/999999999999/relationship", nil, 404)

	// A pede (com @ e maiúsculas no username); A vê "outgoing" e B "incoming"; o terceiro não vê nada.
	p := obj(t, a.call(t, "POST", "/api/users/me/friends", J{"username": "@" + strings.ToUpper(b.name)}, 201))
	if str(p, "type") != "outgoing" || str(obj2(p, "user"), "id") != b.id {
		t.Fatalf("pedido = %v", p)
	}
	if ev := ac.relEvent("RELATIONSHIP_ADD", b.id); str(ev, "type") != "outgoing" {
		t.Fatalf("evento de A = %v", ev)
	}
	if ev := bc.relEvent("RELATIONSHIP_ADD", a.id); str(ev, "type") != "incoming" {
		t.Fatalf("evento de B = %v", ev)
	}
	cc.noEvent(300*time.Millisecond, relEvents...)
	if a.rel(t, b) != "outgoing" || b.rel(t, a) != "incoming" || c.rel(t, a) != "none" {
		t.Fatal("estado dos pedidos")
	}
	// Repetir o pedido é idempotente; A não pode aceitar o próprio pedido.
	a.call(t, "POST", "/api/users/me/friends", J{"username": b.name}, 201)
	a.call(t, "PUT", "/api/users/me/friends/"+b.id, nil, 404)
	if got := a.relationships(t, "?type=outgoing"); len(got) != 1 || !hasUser(got, b.id) {
		t.Fatalf("enviados = %v", got)
	}
	if got := b.relationships(t, "?type=incoming"); len(got) != 1 || !hasUser(got, a.id) {
		t.Fatalf("recebidos = %v", got)
	}

	// B aceita: os dois recebem RELATIONSHIP_UPDATE e viram amigos.
	b.call(t, "PUT", "/api/users/me/friends/"+a.id, nil, 200)
	if ev := ac.relEvent("RELATIONSHIP_UPDATE", b.id); str(ev, "type") != "friend" {
		t.Fatalf("update de A = %v", ev)
	}
	bc.relEvent("RELATIONSHIP_UPDATE", a.id)
	cc.noEvent(300*time.Millisecond, relEvents...)
	if a.rel(t, b) != "friend" || b.rel(t, a) != "friend" {
		t.Fatal("deveriam ser amigos")
	}
	// Pedir de novo a um amigo devolve o amigo, sem duplicar.
	if q := obj(t, a.call(t, "POST", "/api/users/me/friends", J{"username": b.name}, 201)); str(q, "type") != "friend" {
		t.Fatalf("pedido a amigo = %v", q)
	}

	// Pedido cruzado aceita sozinho: C pede a A e A pede a C.
	c.call(t, "POST", "/api/users/me/friends", J{"username": a.name}, 201)
	if q := obj(t, a.call(t, "POST", "/api/users/me/friends", J{"username": c.name}, 201)); str(q, "type") != "friend" {
		t.Fatalf("pedido cruzado = %v", q)
	}

	// Desfazer avisa os dois; é idempotente.
	a.call(t, "DELETE", "/api/users/me/friends/"+c.id, nil, 204)
	cc.relEvent("RELATIONSHIP_REMOVE", a.id)
	ac.relEvent("RELATIONSHIP_REMOVE", c.id)
	a.call(t, "DELETE", "/api/users/me/friends/"+c.id, nil, 204)
	if a.rel(t, c) != "none" {
		t.Fatal("amizade deveria ter acabado")
	}

	// Recusar NÃO avisa quem pediu; cancelar avisa.
	c.call(t, "POST", "/api/users/me/friends", J{"username": b.name}, 201)
	bc.relEvent("RELATIONSHIP_ADD", c.id)
	cc.relEvent("RELATIONSHIP_ADD", b.id)
	b.call(t, "DELETE", "/api/users/me/friends/"+c.id, nil, 204) // recusa
	bc.relEvent("RELATIONSHIP_REMOVE", c.id)
	cc.noEvent(300*time.Millisecond, "RELATIONSHIP_REMOVE")
	c.call(t, "POST", "/api/users/me/friends", J{"username": b.name}, 201)
	c.call(t, "DELETE", "/api/users/me/friends/"+b.id, nil, 204) // cancela
	cc.relEvent("RELATIONSHIP_REMOVE", b.id)
	bc.relEvent("RELATIONSHIP_REMOVE", c.id)

	// Paginação: A com 3 amigos, página de 2.
	d, f := e.newActor(t, "dani"), e.newActor(t, "edu")
	a.befriend(t, d)
	a.befriend(t, f)
	page1 := obj(t, a.call(t, "GET", "/api/users/me/relationships?type=friend&limit=2", nil, 200))
	if len(list(page1, "items")) != 2 || str(page1, "next_after") == "" {
		t.Fatalf("página 1 = %v", page1)
	}
	page2 := obj(t, a.call(t, "GET", "/api/users/me/relationships?type=friend&limit=2&after="+str(page1, "next_after"), nil, 200))
	if len(list(page2, "items")) != 1 || page2["next_after"] != nil {
		t.Fatalf("página 2 = %v", page2)
	}

	// READY de A traz o resumo.
	_, ready := a.connectReady(t)
	rel := obj2(ready, "relationships")
	if num(rel, "friend_count") != 3 || len(list(rel, "items")) != 3 {
		t.Fatalf("relationships do READY = %v", rel)
	}
}

func TestFriendshipLimits(t *testing.T) {
	e := newEnvWith(t, socialCfg)
	a, b := e.newActor(t, "lim"), e.newActor(t, "alvo")
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := e.pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	// IDs altos e únicos por execução (o banco de teste é reaproveitado entre execuções).
	pendBase := int64(5_000_000_000_000_000_000) + time.Now().UnixNano()/1000*1000
	friendBase := pendBase + 10_000

	// 200 pedidos pendentes enviados por A (usuários criados direto no banco).
	exec(fmt.Sprintf(`INSERT INTO users (id, email, username, password_hash)
		SELECT %d + g, 'lim' || g || '_' || %d || '@x.spook', 'lim_' || g || '_' || %d, '!' FROM generate_series(1, 200) g`, pendBase, pendBase, pendBase%1000000))
	exec(fmt.Sprintf(`INSERT INTO friendships (user_a, user_b, status, requested_by)
		SELECT LEAST($1::bigint, %d + g), GREATEST($1::bigint, %d + g), 'pending', $1::bigint FROM generate_series(1, 200) g`, pendBase, pendBase), mustInt(t, a.id))
	a.call(t, "POST", "/api/users/me/friends", J{"username": b.name}, 409)

	// O alvo com 1000 amigos não consegue aceitar mais um.
	exec(fmt.Sprintf(`INSERT INTO users (id, email, username, password_hash)
		SELECT %d + g, 'am' || g || '_' || %d || '@x.spook', 'am_' || g || '_' || %d, '!' FROM generate_series(1, 1000) g`, friendBase, friendBase, friendBase%1000000))
	exec(fmt.Sprintf(`INSERT INTO friendships (user_a, user_b, status, requested_by, accepted_at)
		SELECT LEAST($1::bigint, %d + g), GREATEST($1::bigint, %d + g), 'accepted', $1::bigint, now() FROM generate_series(1, 1000) g`, friendBase, friendBase), mustInt(t, b.id))
	c := e.newActor(t, "novo")
	c.call(t, "POST", "/api/users/me/friends", J{"username": b.name}, 201)
	b.call(t, "PUT", "/api/users/me/friends/"+c.id, nil, 409)
	if c.rel(t, b) != "outgoing" {
		t.Fatal("o pedido deve continuar pendente")
	}
	// Pedido cruzado também respeita o limite (aceitar automático).
	b.call(t, "POST", "/api/users/me/friends", J{"username": c.name}, 409)
}

func TestFriendRequestRateLimit(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		socialCfg(d)
		d.FriendRequestLimiter = ratelimit.New(1.0/3600, 3)
	})
	a := e.newActor(t, "spam")
	for i := 0; i < 3; i++ {
		a.call(t, "POST", "/api/users/me/friends", J{"username": e.newActor(t, "alvo").name}, 201)
	}
	resp, body := a.do(t, "POST", "/api/users/me/friends", J{"username": e.newActor(t, "alvo").name})
	status(t, resp, body, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}
}

func TestBlockMatrix(t *testing.T) {
	e := newEnvWith(t, socialCfg)
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "beto"), e.newActor(t, "caio")
	bc, _ := b.connectReady(t)
	cc, _ := c.connectReady(t)

	// Sem servidor em comum nem amizade: DM recusada; com amizade, abre.
	b.openDM(t, a.id, 403)
	a.befriend(t, b)
	dm := a.openDM(t, b.id, 201)
	id := str(dm, "id")
	a.say(t, id, "oi, beto", 201)
	b.say(t, id, "oi, ana", 201)

	// A bloqueia B: a amizade acaba (B é avisado só da remoção), bloqueios aparecem só para A.
	a.call(t, "PUT", "/api/users/me/blocks/"+a.id, nil, 422)
	a.call(t, "PUT", "/api/users/me/blocks/999999999999", nil, 404)
	p := obj(t, a.call(t, "PUT", "/api/users/me/blocks/"+b.id, nil, 200))
	if str(p, "type") != "blocked" {
		t.Fatalf("bloqueio = %v", p)
	}
	a.call(t, "PUT", "/api/users/me/blocks/"+b.id, nil, 200) // idempotente
	bc.relEvent("RELATIONSHIP_REMOVE", a.id)
	cc.noEvent(300*time.Millisecond, relEvents...)
	if a.rel(t, b) != "blocked" || b.rel(t, a) != "none" {
		t.Fatalf("relações: a→b %s, b→a %s (b não pode ver o bloqueio)", a.rel(t, b), b.rel(t, a))
	}
	if got := a.relationships(t, "?type=blocked"); len(got) != 1 || !hasUser(got, b.id) {
		t.Fatalf("bloqueados de A = %v", got)
	}
	if got := b.relationships(t, ""); len(got) != 0 {
		t.Fatalf("B não deveria ver nada: %v", got)
	}

	// DM nova recusada nos dois sentidos, com a mesma mensagem genérica; nada revela o bloqueio.
	var msgs []string
	for _, who := range []*actor{a, b} {
		other := b
		if who == b {
			other = a
		}
		_, body := who.do(t, "POST", "/api/users/@me/channels", J{"recipient_id": other.id})
		msgs = append(msgs, str(obj(t, body), "detail"))
	}
	if msgs[0] != msgs[1] || strings.Contains(strings.ToLower(msgs[0]), "bloque") {
		t.Fatalf("mensagens de DM recusada = %q", msgs)
	}
	for _, who := range []*actor{a, b} {
		resp, body := who.do(t, "POST", "/api/channels/"+id+"/messages", J{"content": "mais uma"})
		status(t, resp, body, 403)
		if strings.Contains(strings.ToLower(string(body)), "bloque") {
			t.Fatalf("o erro de envio revela o bloqueio: %s", body)
		}
	}
	// As mensagens antigas continuam legíveis para os dois.
	for _, who := range []*actor{a, b} {
		if n := len(list(obj(t, who.call(t, "GET", "/api/channels/"+id+"/messages", nil, 200)), "messages")); n != 2 {
			t.Fatalf("mensagens visíveis = %d", n)
		}
	}
	// Pedido de B a A: resposta igual à de um pedido enviado, mas nada é gravado nem A é avisada.
	ac, _ := a.connectReady(t)
	if q := obj(t, b.call(t, "POST", "/api/users/me/friends", J{"username": a.name}, 201)); str(q, "type") != "outgoing" {
		t.Fatalf("pedido ao bloqueador = %v", q)
	}
	ac.noEvent(300*time.Millisecond, relEvents...)
	if got := a.relationships(t, "?type=incoming"); len(got) != 0 {
		t.Fatalf("A não deveria ter pedido recebido: %v", got)
	}
	if b.rel(t, a) != "none" {
		t.Fatal("nada deveria ter sido gravado")
	}
	// A não pode pedir amizade a quem bloqueou (erro claro, é o próprio bloqueio dela).
	a.call(t, "POST", "/api/users/me/friends", J{"username": b.name}, 409)

	// Desbloquear libera a conversa só se ainda houver motivo (aqui não há: sem servidor nem amizade).
	a.call(t, "DELETE", "/api/users/me/blocks/"+b.id, nil, 204)
	a.call(t, "DELETE", "/api/users/me/blocks/"+b.id, nil, 204)
	ac.relEvent("RELATIONSHIP_REMOVE", b.id)
	a.openDM(t, b.id, 403)
	// Com um servidor em comum, a DM volta (e, aí, o bloqueio volta a impedir).
	g := a.createGuild(t, "Em comum")
	b.join(t, a, g.id)
	a.openDM(t, b.id, 200)
	b.say(t, id, "voltei", 201)
	a.call(t, "PUT", "/api/users/me/blocks/"+b.id, nil, 200)
	b.openDM(t, a.id, 403)
	b.say(t, id, "de novo", 403)
}

func TestBlockedMentionsDoNotNotifyBlocker(t *testing.T) {
	e := newEnvWith(t, socialCfg)
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "beto"), e.newActor(t, "caio")
	g := friends(t, "Menções", a, b, c)
	a.call(t, "PUT", "/api/users/me/blocks/"+b.id, nil, 200)

	ac, _ := a.connectReady(t)
	cc, _ := c.connectReady(t)
	m := b.say(t, g.textID, "oi @"+a.name+" e @"+c.name, 201)
	// A (que bloqueou B) não é destacada nem notificada; C é.
	mentions, _ := m["mention_ids"].([]any)
	if len(mentions) != 1 || mentions[0] != c.id {
		t.Fatalf("mention_ids = %v (esperado só %s)", mentions, c.id)
	}
	cc.event("READ_STATE_UPDATE")
	ac.noEvent(500*time.Millisecond, "READ_STATE_UPDATE")

	// Em DM em grupo (criada antes do bloqueio), a mensagem de B não soma aviso para A; C soma.
	d := e.newActor(t, "dani")
	friends(t, "Grupo", d, a, b, c)
	grp := str(d.newGroup(t, 201, a.id, b.id, c.id), "id")
	a.call(t, "PUT", "/api/users/me/blocks/"+b.id, nil, 200)
	b.say(t, grp, "alguém aí?", 201)
	cc.channelReadUpdate(grp)
	ac.noEvent(500*time.Millisecond, "READ_STATE_UPDATE")
}

// channelReadUpdate lê até chegar o READ_STATE_UPDATE do canal.
func (c *wsClient) channelReadUpdate(channelID string) J {
	c.t.Helper()
	for {
		if p := payload(c.t, c.event("READ_STATE_UPDATE")); str(p, "channel_id") == channelID {
			return p
		}
	}
}

func TestFriendPresenceWithoutSharedGuild(t *testing.T) {
	e := newEnvWith(t, socialCfg)
	a, b, stranger := e.newActor(t, "ana"), e.newActor(t, "beto"), e.newActor(t, "estranho")
	a.befriend(t, b) // sem servidor em comum
	bc, _ := b.connectReady(t)
	sc, _ := stranger.connectReady(t)

	// A conecta: o amigo vê online; o estranho, nada.
	ac, _ := a.connectReady(t)
	bc.presence(a.id, "online")
	sc.noPresence(a.id, 300*time.Millisecond)

	// Invisível e DND respeitados.
	a.call(t, "PATCH", "/api/users/@me/presence", J{"status_pref": "invisible"}, 200)
	bc.presence(a.id, "offline")
	a.call(t, "PATCH", "/api/users/@me/presence", J{"status_pref": "dnd", "custom_status": J{"text": "focado"}}, 200)
	bc.presence(a.id, "dnd")

	// READY do amigo que conecta depois traz a presença (dnd) de A.
	b2, ready := b.connectReady(t)
	defer b2.ws.CloseNow()
	found := false
	for _, p := range list(ready, "presences") {
		if str(p, "user_id") == a.id && str(p, "status") == "dnd" {
			found = true
		}
	}
	if !found {
		t.Fatalf("READY sem a presença do amigo: %v", ready["presences"])
	}
	// Desfazer a amizade: o evento de remoção chega; a presença futura não vaza mais.
	a.call(t, "DELETE", "/api/users/me/friends/"+b.id, nil, 204)
	bc.relEvent("RELATIONSHIP_REMOVE", a.id)
	a.call(t, "PATCH", "/api/users/@me/presence", J{"status_pref": "online"}, 200)
	bc.noPresence(a.id, 400*time.Millisecond)
	_ = ac
}

func TestAcceptExchangesPresence(t *testing.T) {
	e := newEnvWith(t, socialCfg)
	a, b := e.newActor(t, "ana"), e.newActor(t, "beto")
	ac, _ := a.connectReady(t)
	bc, _ := b.connectReady(t)
	a.call(t, "POST", "/api/users/me/friends", J{"username": b.name}, 201)
	bc.noPresence(a.id, 300*time.Millisecond) // só pedido: ainda não se veem
	b.call(t, "PUT", "/api/users/me/friends/"+a.id, nil, 200)
	bc.presence(a.id, "online")
	ac.presence(b.id, "online")
}

func TestInviteFriendByDM(t *testing.T) {
	e := newEnvWith(t, socialCfg)
	owner, friend, stranger, plain := e.newActor(t, "dono"), e.newActor(t, "amigo"), e.newActor(t, "estranho"), e.newActor(t, "comum")
	g := owner.createGuild(t, "Convite")
	plain.join(t, owner, g.id)
	owner.befriend(t, friend)
	plain.befriend(t, friend)
	path := "/api/users/me/friends/" + friend.id + "/invite"

	resp, body := e.do(t, "POST", path, J{"guild_id": g.id}, nil)
	status(t, resp, body, 401)
	owner.call(t, "POST", "/api/users/me/friends/"+stranger.id+"/invite", J{"guild_id": g.id}, 403) // não é amigo
	owner.call(t, "POST", path, J{"guild_id": "abc"}, 404)
	outsider := e.newActor(t, "fora")
	outsider.befriend(t, friend)
	outsider.call(t, "POST", "/api/users/me/friends/"+friend.id+"/invite", J{"guild_id": g.id}, 404) // não é membro do servidor
	stranger.call(t, "POST", "/api/users/me/friends/"+owner.id+"/invite", J{"guild_id": g.id}, 403)

	res := obj(t, owner.call(t, "POST", path, J{"guild_id": g.id}, 201))
	code := str(res, "code")
	if code == "" || str(res, "channel_id") == "" || str(res, "message_id") == "" {
		t.Fatalf("resultado = %v", res)
	}
	msgs := list(obj(t, friend.call(t, "GET", "/api/channels/"+str(res, "channel_id")+"/messages", nil, 200)), "messages")
	if len(msgs) != 1 || !strings.Contains(str(msgs[0], "content"), "http://spook.test/invite/"+code) || str(obj2(msgs[0], "author"), "id") != owner.id {
		t.Fatalf("mensagem do convite = %v", msgs)
	}
	// Reaproveita o convite; quem já entrou não é convidado de novo.
	if again := obj(t, owner.call(t, "POST", path, J{"guild_id": g.id}, 201)); str(again, "code") != code {
		t.Fatalf("deveria reaproveitar o convite %s, veio %v", code, again)
	}
	friend.call(t, "POST", "/api/invites/"+code, nil, 200)
	owner.call(t, "POST", path, J{"guild_id": g.id}, 409)

	// Bloqueio impede a entrega, sem revelar.
	other := e.newActor(t, "outro")
	owner.befriend(t, other)
	owner.call(t, "PUT", "/api/users/me/blocks/"+other.id, nil, 200)
	owner.call(t, "POST", "/api/users/me/friends/"+other.id+"/invite", J{"guild_id": g.id}, 403)
}

func TestAccountDeletionRemovesRelationships(t *testing.T) {
	e := newEnvWith(t, socialCfg)
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "beto"), e.newActor(t, "caio")
	a.befriend(t, b)
	a.call(t, "PUT", "/api/users/me/blocks/"+c.id, nil, 200)
	a.call(t, "DELETE", "/api/users/me", J{"password": "senha-forte-123"}, 204)
	if n := countRows(t, e, "SELECT count(*) FROM friendships WHERE user_a = $1 OR user_b = $1", a.id); n != 0 {
		t.Fatalf("amizades restantes: %d", n)
	}
	if n := countRows(t, e, "SELECT count(*) FROM blocks WHERE blocker_id = $1 OR blocked_id = $1", a.id); n != 0 {
		t.Fatalf("bloqueios restantes: %d", n)
	}
	if got := b.relationships(t, ""); len(got) != 0 {
		t.Fatalf("B ainda vê a conta excluída: %v", got)
	}
}

func countRows(t *testing.T, e *testEnv, q, id string) int {
	t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), q, mustInt(t, id)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------- chamadas em DM ----------

func (c *wsClient) callEvent(name, channelID string) J {
	c.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			break
		}
		if isEvent(f, name) {
			if p := payload(c.t, f); str(p, "channel_id") == channelID {
				return p
			}
		}
	}
	c.t.Fatalf("%s do canal %s não chegou", name, channelID)
	return nil
}

var callEvents = []string{"CALL_RING", "CALL_UPDATE", "CALL_END"}

func callCfg(f *fakeLiveKit) func(*Deps) {
	return func(d *Deps) {
		voiceCfg(f)(d)
		socialCfg(d)
	}
}

func TestDMCallRingAnswerDecline(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, callCfg(lkf))
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "beto"), e.newActor(t, "caio")
	g := friends(t, "Chamadas", a, b, c)
	dm := a.openDM(t, b.id, 201)
	id := str(dm, "id")
	ac, _ := a.connectReady(t)
	bc, _ := b.connectReady(t)
	bc2, _ := b.connectReady(t) // outro dispositivo de B
	cc, _ := c.connectReady(t)
	_ = g

	// Só participantes ligam.
	c.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 404)
	c.call(t, "POST", "/api/channels/"+id+"/call/accept", nil, 404)
	resp, body := e.do(t, "POST", "/api/channels/"+id+"/call/ring", nil, nil)
	status(t, resp, body, 401)
	b.call(t, "POST", "/api/channels/"+id+"/call/accept", nil, 404) // nada tocando

	// A liga: B toca nos dois dispositivos; A recebe o estado; C não ouve nada.
	call := obj(t, a.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 200))
	if str(call, "state") != "ringing" || str(call, "started_by") != a.id || call["expires_at"] == nil {
		t.Fatalf("chamada = %v", call)
	}
	ring := bc.callEvent("CALL_RING", id)
	bc2.callEvent("CALL_RING", id)
	if str(obj2(ring, "caller"), "id") != a.id {
		t.Fatalf("ring = %v", ring)
	}
	ac.callEvent("CALL_UPDATE", id)
	cc.noEvent(300*time.Millisecond, callEvents...)
	// Idempotente para quem ligou; outro participante recebe 409.
	a.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 200)
	b.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 409)
	b.call(t, "POST", "/api/channels/"+id+"/call/cancel", nil, 403)
	a.call(t, "POST", "/api/channels/"+id+"/call/decline", nil, 422)
	a.call(t, "POST", "/api/channels/"+id+"/call/accept", nil, 422)

	// O READY de quem recarrega no meio do toque traz a chamada.
	b3, ready := b.connectReady(t)
	defer b3.ws.CloseNow()
	if calls, _ := ready["calls"].([]any); len(calls) != 1 {
		t.Fatalf("calls do READY = %v", ready["calls"])
	}

	// B recusa: o toque para nos outros dispositivos de B e a chamada acaba (1:1).
	b.call(t, "POST", "/api/channels/"+id+"/call/decline", nil, 204)
	if ev := ac.callEvent("CALL_END", id); str(ev, "reason") != "declined" {
		t.Fatalf("fim = %v", ev)
	}
	bc2.callEvent("CALL_END", id)
	b.call(t, "POST", "/api/channels/"+id+"/call/decline", nil, 204) // idempotente

	// Cancelar: A liga de novo e desiste; B para de tocar.
	a.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 200)
	bc.callEvent("CALL_RING", id)
	a.call(t, "POST", "/api/channels/"+id+"/call/cancel", nil, 204)
	if ev := bc.callEvent("CALL_END", id); str(ev, "reason") != "cancelled" {
		t.Fatalf("fim = %v", ev)
	}
	a.call(t, "POST", "/api/channels/"+id+"/call/cancel", nil, 204)

	// Atender: B recebe o token de voz; a chamada fica em andamento e A é avisada.
	a.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 200)
	bc.callEvent("CALL_RING", id)
	acc := obj(t, b.call(t, "POST", "/api/channels/"+id+"/call/accept", nil, 200))
	if str(obj2(acc, "call"), "state") != "active" || str(obj2(acc, "voice"), "token") == "" {
		t.Fatalf("atender = %v", acc)
	}
	for {
		if ev := ac.callEvent("CALL_UPDATE", id); str(ev, "state") == "active" {
			break
		}
	}
	// Com a chamada em andamento, ligar de novo dá 409; quando a sala esvazia, a chamada acaba.
	b.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 409)
	e.lkJoin(t, id, a)
	e.lkJoin(t, id, b)
	e.lkEvent(t, "participant_left", id, a, nil)
	e.lkEvent(t, "participant_left", id, b, nil)
	if ev := ac.callEvent("CALL_END", id); str(ev, "reason") != "ended" {
		t.Fatalf("fim = %v", ev)
	}
}

func TestDMCallAnsweredByJoiningTheRoom(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, callCfg(lkf))
	a, b := e.newActor(t, "ana"), e.newActor(t, "beto")
	a.befriend(t, b)
	id := str(a.openDM(t, b.id, 201), "id")
	ac, _ := a.connectReady(t)
	bc, _ := b.connectReady(t)
	a.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 200)
	bc.callEvent("CALL_RING", id)
	// A entra na própria sala (não atende nada); B entra pela sala (sem usar /accept): o toque acaba.
	b.voiceToken(t, id, 200)
	e.lkJoin(t, id, a)
	bc.noEvent(200*time.Millisecond, "CALL_END")
	e.lkJoin(t, id, b)
	for {
		if ev := bc.callEvent("CALL_UPDATE", id); str(ev, "state") == "active" {
			break
		}
	}
	_ = ac
}

func TestDMCallSilentCases(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, callCfg(lkf))
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "beto"), e.newActor(t, "caio")
	a.befriend(t, b)
	a.befriend(t, c)
	idB := str(a.openDM(t, b.id, 201), "id")
	idC := str(a.openDM(t, c.id, 201), "id")
	ac, _ := a.connectReady(t)
	bc, _ := b.connectReady(t)
	cc, _ := c.connectReady(t)

	// DND: B não toca (e A não é avisada de nada além do próprio estado).
	b.call(t, "PATCH", "/api/users/@me/presence", J{"status_pref": "dnd"}, 200)
	a.call(t, "POST", "/api/channels/"+idB+"/call/ring", nil, 200)
	ac.callEvent("CALL_UPDATE", idB)
	bc.noEvent(400*time.Millisecond, "CALL_RING")
	a.call(t, "POST", "/api/channels/"+idB+"/call/cancel", nil, 204)

	// DM silenciada: C não toca.
	c.call(t, "PUT", "/api/users/@me/notification-settings/channel/"+idC, J{"muted": true}, 200)
	a.call(t, "POST", "/api/channels/"+idC+"/call/ring", nil, 200)
	cc.noEvent(400*time.Millisecond, "CALL_RING")
	a.call(t, "POST", "/api/channels/"+idC+"/call/cancel", nil, 204)
	c.call(t, "DELETE", "/api/users/@me/notification-settings/channel/"+idC, nil, 204)

	// Bloqueio: quem bloqueou não consegue ligar (erro claro); quem foi bloqueado "liga", mas ninguém toca.
	a.call(t, "PUT", "/api/users/me/blocks/"+c.id, nil, 200)
	a.call(t, "POST", "/api/channels/"+idC+"/call/ring", nil, 403)
	resp, body := c.do(t, "POST", "/api/channels/"+idC+"/call/ring", nil)
	status(t, resp, body, 200)
	ac.noEvent(400*time.Millisecond, "CALL_RING")
	c.call(t, "POST", "/api/channels/"+idC+"/call/cancel", nil, 204)
	// E o token de voz da DM bloqueada é recusado nos dois sentidos.
	a.voiceToken(t, idC, 403)
	c.voiceToken(t, idC, 403)
}

func TestDMCallVoiceOff(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) { voiceCfgOff(d); socialCfg(d) })
	a, b := e.newActor(t, "ana"), e.newActor(t, "beto")
	a.befriend(t, b)
	id := str(a.openDM(t, b.id, 201), "id")
	a.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 503)
}

func TestDMCallGroup(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, callCfg(lkf))
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "beto"), e.newActor(t, "caio")
	friends(t, "Grupo", a, b, c)
	id := str(a.newGroup(t, 201, b.id, c.id), "id")
	ac, _ := a.connectReady(t)
	bc, _ := b.connectReady(t)
	cc, _ := c.connectReady(t)
	a.call(t, "POST", "/api/channels/"+id+"/call/ring", nil, 200)
	bc.callEvent("CALL_RING", id)
	cc.callEvent("CALL_RING", id)
	// B recusa: a chamada continua tocando para C (só acaba quando todos recusam).
	b.call(t, "POST", "/api/channels/"+id+"/call/decline", nil, 204)
	ac.callEvent("CALL_UPDATE", id)
	cc.noEvent(200*time.Millisecond, "CALL_END")
	c.call(t, "POST", "/api/channels/"+id+"/call/decline", nil, 204)
	if ev := ac.callEvent("CALL_END", id); str(ev, "reason") != "declined" {
		t.Fatalf("fim = %v", ev)
	}
}
