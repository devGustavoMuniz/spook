//go:build integration

package app

import (
	"fmt"
	"strings"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
)

// reply envia uma resposta (reply_to e, opcionalmente, mention_reply).
func (a *actor) reply(t *testing.T, channelID, to, text string, mention *bool, want int) J {
	t.Helper()
	body := J{"content": text, "reply_to": to}
	if mention != nil {
		body["mention_reply"] = *mention
	}
	return obj(t, a.call(t, "POST", "/api/channels/"+channelID+"/messages", body, want))
}

func (a *actor) pin(t *testing.T, channelID, messageID string, want int) {
	t.Helper()
	a.call(t, "PUT", "/api/channels/"+channelID+"/pins/"+messageID, nil, want)
}

func (a *actor) unpin(t *testing.T, channelID, messageID string, want int) {
	t.Helper()
	a.call(t, "DELETE", "/api/channels/"+channelID+"/pins/"+messageID, nil, want)
}

func (a *actor) pins(t *testing.T, channelID string, want int) []J {
	t.Helper()
	return list(obj(t, a.call(t, "GET", "/api/channels/"+channelID+"/pins", nil, want)), "messages")
}

func ptr[T any](v T) *T { return &v }

// ---------- 401 ----------

func TestReplyPinRoutesRequireAuth(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/channels/1/pins"}, {"PUT", "/api/channels/1/pins/2"}, {"DELETE", "/api/channels/1/pins/2"},
	} {
		resp, b := e.do(t, r.method, r.path, J{}, nil)
		status(t, resp, b, 401)
	}
}

// ---------- responder ----------

func TestReplyCarriesPreviewAndMentionsTheAuthor(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Respostas", owner, member)
	mc := member.connect(t)
	mc.identify()

	orig := owner.say(t, g.textID, strings.Repeat("é", 150), 201)
	member.waitCounts(t, g.textID, 1, 0)
	mc.event("MESSAGE_CREATE") // a original

	r := member.reply(t, g.textID, msgID(orig), "concordo", nil, 201) // mention_reply padrão = true
	rt, _ := r["reply_to"].(map[string]any)
	if rt == nil || str(rt, "id") != msgID(orig) || str(J(rt["author"].(map[string]any)), "username") != owner.name ||
		len([]rune(str(rt, "content"))) != 100 || rt["deleted"] != false || rt["has_attachments"] != false {
		t.Fatalf("reply_to: %v", r["reply_to"])
	}
	if r["pinned"] != false {
		t.Fatalf("pinned: %v", r["pinned"])
	}
	// o autor respondido entra em mention_ids (a própria autora da resposta não se menciona)
	if ids := arrStrings(r["mention_ids"]); len(ids) != 1 || ids[0] != owner.id {
		t.Fatalf("mention_ids: %v", ids)
	}
	owner.waitCounts(t, g.textID, 1, 1)

	// mention_reply:false não menciona
	r2 := member.reply(t, g.textID, msgID(orig), "só respondendo", ptr(false), 201)
	if ids := arrStrings(r2["mention_ids"]); len(ids) != 0 {
		t.Fatalf("mention_reply:false: %v", ids)
	}
	// responder a si mesmo não se menciona
	r3 := member.reply(t, g.textID, msgID(r), "eu mesmo", nil, 201)
	if ids := arrStrings(r3["mention_ids"]); len(ids) != 0 {
		t.Fatalf("auto-resposta: %v", ids)
	}
	// uma mensagem comum tem reply_to null
	plain := owner.say(t, g.textID, "oi", 201)
	if v, ok := plain["reply_to"]; !ok || v != nil {
		t.Fatalf("reply_to deve ser null: %v", plain)
	}

	// o histórico traz a mesma prévia
	hist := list(obj(t, owner.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 200)), "messages")
	var found bool
	for _, m := range hist {
		if msgID(m) == msgID(r) {
			found = true
			if str(J(m["reply_to"].(map[string]any)), "id") != msgID(orig) {
				t.Fatalf("histórico: %v", m["reply_to"])
			}
		}
	}
	if !found {
		t.Fatal("resposta fora do histórico")
	}
}

func TestReplyWithAttachmentOnlyStillMentionsAndPreviewsAttachments(t *testing.T) {
	e := uploadsEnv(t)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Anexos", owner, member)
	a := owner.upload(t, g.textID, "a.txt", "text/plain", []byte("x"))
	orig := owner.sendWith(t, g.textID, "", []string{a}, 201)
	r := member.reply(t, g.textID, msgID(orig), "ok", nil, 201)
	if rt := r["reply_to"].(map[string]any); rt["has_attachments"] != true || str(rt, "content") != "" {
		t.Fatalf("reply_to: %v", rt)
	}
}

func TestReplyValidation(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Validação", owner, member)
	other := str(obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "outro"}, 201)), "id")

	inOther := owner.say(t, other, "lá", 201)
	gone := owner.say(t, g.textID, "apagada", 201)
	owner.call(t, "DELETE", "/api/channels/"+g.textID+"/messages/"+msgID(gone), nil, 204)

	for name, to := range map[string]string{
		"outro canal": msgID(inOther), "apagada": msgID(gone), "inexistente": "999999999999", "id inválido": "abc",
	} {
		b := member.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "x", "reply_to": to}, 422)
		if name != "id inválido" && !strings.Contains(string(b), "mensagem respondida") {
			t.Errorf("%s: mensagem de erro pouco clara: %s", name, b)
		}
	}
	// nada foi gravado
	if n := len(list(obj(t, owner.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 200)), "messages")); n != 0 {
		t.Fatalf("o canal deveria estar vazio, tem %d", n)
	}
}

func TestReplyToMessageDeletedLaterShowsDeleted(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Apagada depois", owner, member)
	orig := owner.say(t, g.textID, "segredo", 201)
	r := member.reply(t, g.textID, msgID(orig), "sobre isso", nil, 201)
	owner.call(t, "DELETE", "/api/channels/"+g.textID+"/messages/"+msgID(orig), nil, 204)

	hist := list(obj(t, member.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 200)), "messages")
	if len(hist) != 1 || msgID(hist[0]) != msgID(r) {
		t.Fatalf("histórico: %v", hist)
	}
	rt := hist[0]["reply_to"].(map[string]any)
	if rt["deleted"] != true || str(rt, "content") != "" || str(rt, "id") != msgID(orig) {
		t.Fatalf("reply_to apagada: %v", rt)
	}
}

func TestReplyMentionSkipsAuthorWhoCannotSeeTheChannel(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, seer := e.newActor(t, "dono"), e.newActor(t, "vidente")
	g := friends(t, "Sem ver", owner, seer)
	orig := seer.say(t, g.textID, "oi", 201)
	// o autor da original perde o acesso ao canal depois (cargo @everyone sem VIEW_CHANNEL)
	owner.call(t, "PATCH", "/api/guilds/"+g.id+"/roles/"+g.id, J{"permissions": int64(perm.SendMessages)}, 200)
	r := owner.reply(t, g.textID, msgID(orig), "e aí", nil, 201)
	if ids := arrStrings(r["mention_ids"]); len(ids) != 0 {
		t.Fatalf("quem não vê o canal não é mencionado: %v", ids)
	}
}

func TestReplyInDM(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	a, b := e.newActor(t, "ana"), e.newActor(t, "bia")
	friends(t, "DM resposta", a, b)
	dm := str(a.openDM(t, b.id, 201), "id")
	orig := a.say(t, dm, "oi bia", 201)
	r := b.reply(t, dm, msgID(orig), "oi ana", nil, 201)
	if ids := arrStrings(r["mention_ids"]); len(ids) != 1 || ids[0] != a.id {
		t.Fatalf("mention_ids na DM: %v", ids)
	}
	a.waitCounts(t, dm, 1, 1)
}

func TestHistoryLoadsRepliesWithoutNPlusOne(t *testing.T) {
	var cp *countingPool
	e := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		cp = &countingPool{Pool: d.Pool}
		d.Pool = cp
	})
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "SemNMaisUmResp")
	base := msgID(owner.say(t, g.textID, "original", 201))
	other := msgID(owner.say(t, g.textID, "outra", 201))

	send := func(n int) {
		for i := 0; i < n; i++ {
			to := base
			if i%2 == 1 {
				to = other
			}
			owner.reply(t, g.textID, to, fmt.Sprintf("r%d", i), nil, 201)
		}
	}
	queries := func() (int64, J) {
		before := cp.n.Load()
		h := obj(t, owner.call(t, "GET", "/api/channels/"+g.textID+"/messages?limit=100", nil, 200))
		return cp.n.Load() - before, h
	}
	send(2)
	few, h := queries()
	if len(list(h, "messages")) != 4 {
		t.Fatalf("histórico: %v", h)
	}
	send(16)
	many, h := queries()
	replies := 0
	for _, m := range list(h, "messages") {
		if m["reply_to"] != nil {
			replies++
		}
	}
	if replies != 18 {
		t.Fatalf("respostas no histórico: %d", replies)
	}
	if few != many {
		t.Fatalf("o número de consultas depende do tamanho do histórico: %d vs %d — N+1", few, many)
	}
	t.Logf("consultas por GET do histórico com respostas: %d (4 e 20 mensagens)", many)
}

// ---------- fixar ----------

func TestPinFlowPermissionsAndGatewayUpdate(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member, outsider := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "fora")
	g := friends(t, "Fixadas", owner, member)
	mc := member.connect(t)
	mc.identify()

	m1 := owner.say(t, g.textID, "primeira", 201)
	m2 := owner.say(t, g.textID, "segunda", 201)
	mc.event("MESSAGE_CREATE")
	mc.event("MESSAGE_CREATE")

	// sem MANAGE_MESSAGES: 403; de fora do servidor: 404; mensagem inexistente: 404
	member.pin(t, g.textID, msgID(m1), 403)
	member.unpin(t, g.textID, msgID(m1), 403)
	outsider.pin(t, g.textID, msgID(m1), 404)
	outsider.call(t, "GET", "/api/channels/"+g.textID+"/pins", nil, 404)
	owner.pin(t, g.textID, "999999999999", 404)
	if got := member.pins(t, g.textID, 200); len(got) != 0 {
		t.Fatalf("nada fixado ainda: %v", got)
	}

	owner.pin(t, g.textID, msgID(m1), 204)
	up := payload(t, mc.event("MESSAGE_UPDATE"))
	if str(up, "id") != msgID(m1) || up["pinned"] != true || str(up, "content") != "primeira" {
		t.Fatalf("MESSAGE_UPDATE de fixar: %v", up)
	}
	// idempotente: sem novo evento
	owner.pin(t, g.textID, msgID(m1), 204)
	owner.pin(t, g.textID, msgID(m2), 204)
	up2 := payload(t, mc.event("MESSAGE_UPDATE"))
	if str(up2, "id") != msgID(m2) {
		t.Fatalf("o segundo evento deve ser da segunda mensagem (a repetição não publica): %v", up2)
	}

	// o membro (sem permissão) lê as fixadas: a mais recente primeiro
	got := member.pins(t, g.textID, 200)
	if len(got) != 2 || msgID(got[0]) != msgID(m2) || msgID(got[1]) != msgID(m1) || got[0]["pinned"] != true {
		t.Fatalf("fixadas: %v", got)
	}
	// o histórico reflete pinned
	hist := list(obj(t, member.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 200)), "messages")
	if hist[0]["pinned"] != true || hist[1]["pinned"] != true {
		t.Fatalf("histórico: %v", hist)
	}

	owner.unpin(t, g.textID, msgID(m1), 204)
	up3 := payload(t, mc.event("MESSAGE_UPDATE"))
	if str(up3, "id") != msgID(m1) || up3["pinned"] != false {
		t.Fatalf("MESSAGE_UPDATE de desafixar: %v", up3)
	}
	owner.unpin(t, g.textID, msgID(m1), 204) // idempotente
	if got = member.pins(t, g.textID, 200); len(got) != 1 || msgID(got[0]) != msgID(m2) {
		t.Fatalf("fixadas: %v", got)
	}

	// mensagem fixada apagada some das fixadas e não fixa de novo
	owner.call(t, "DELETE", "/api/channels/"+g.textID+"/messages/"+msgID(m2), nil, 204)
	if got = member.pins(t, g.textID, 200); len(got) != 0 {
		t.Fatalf("apagada deve sumir das fixadas: %v", got)
	}
	owner.pin(t, g.textID, msgID(m2), 404)
}

func TestPinWithManageMessagesRole(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, mod := e.newActor(t, "dono"), e.newActor(t, "mod")
	g := friends(t, "Moderação", owner, mod)
	role := owner.role(t, g.id, J{"name": "Mod", "position": 1, "permissions": int64(perm.ViewChannel | perm.SendMessages | perm.ManageMessages)})
	owner.giveRole(t, g.id, mod.id, str(role, "id"))
	m := owner.say(t, g.textID, "fixe", 201)
	mod.pin(t, g.textID, msgID(m), 204)
	if got := owner.pins(t, g.textID, 200); len(got) != 1 {
		t.Fatalf("fixadas: %v", got)
	}
}

func TestPinLimitOfFifty(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) { notifCfg(d); bigLimits(d) })
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Limite")
	var ids []string
	for i := 0; i < 51; i++ {
		ids = append(ids, msgID(owner.say(t, g.textID, fmt.Sprintf("m%d", i), 201)))
	}
	for _, id := range ids[:50] {
		owner.pin(t, g.textID, id, 204)
	}
	owner.pin(t, g.textID, ids[50], 409)
	owner.pin(t, g.textID, ids[0], 204) // já fixada: idempotente, mesmo no limite
	if got := owner.pins(t, g.textID, 200); len(got) != 50 || msgID(got[0]) != ids[49] {
		t.Fatalf("fixadas: %d, primeira %s", len(got), msgID(got[0]))
	}
	owner.unpin(t, g.textID, ids[3], 204)
	owner.pin(t, g.textID, ids[50], 204)
}

func TestPinInDMAnyParticipantAndOutsiderGets404(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "bia"), e.newActor(t, "cris")
	friends(t, "DM fixar", a, b, c)
	dm := str(a.openDM(t, b.id, 201), "id")
	bc := b.connect(t)
	bc.identify()
	m := a.say(t, dm, "guarde isto", 201)
	bc.event("MESSAGE_CREATE")

	b.pin(t, dm, msgID(m), 204) // quem não é autor também fixa
	up := payload(t, bc.event("MESSAGE_UPDATE"))
	if up["pinned"] != true {
		t.Fatalf("%v", up)
	}
	if got := a.pins(t, dm, 200); len(got) != 1 || msgID(got[0]) != msgID(m) {
		t.Fatalf("fixadas na DM: %v", got)
	}
	c.pin(t, dm, msgID(m), 404)
	c.unpin(t, dm, msgID(m), 404)
	c.call(t, "GET", "/api/channels/"+dm+"/pins", nil, 404)
	a.unpin(t, dm, msgID(m), 204)
}
