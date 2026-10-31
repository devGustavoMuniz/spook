//go:build integration

package app

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SherClockHolmes/webpush-go"

	"github.com/devGustavoMuniz/spook/server/internal/notification"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/config"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/platform/snowflake"
)

// ---------- helpers ----------

// notifCfg: limites folgados e presença com tolerância curta.
func notifCfg(d *Deps) {
	p4Cfg(d)
	d.PushLimiter = ratelimit.New(100000, 100000)
}

func (a *actor) ack(t *testing.T, channelID, messageID string, want int) J {
	t.Helper()
	return obj(t, a.call(t, "PUT", "/api/channels/"+channelID+"/ack", J{"message_id": messageID}, want))
}

func (a *actor) readStates(t *testing.T) J {
	t.Helper()
	return obj(t, a.call(t, "GET", "/api/users/@me/read-states", nil, 200))
}

// rs devolve o item do canal em read_states (nil se não vier).
func rs(states J, channelID string) J {
	for _, s := range list(states, "read_states") {
		if str(s, "channel_id") == channelID {
			return s
		}
	}
	return nil
}

func guildRS(states J, guildID string) J {
	for _, g := range list(states, "guilds") {
		if str(g, "guild_id") == guildID {
			return g
		}
	}
	return nil
}

// unread/mentions exigem que o canal exista na resposta.
func (a *actor) counts(t *testing.T, channelID string) (unread, mentions int64) {
	t.Helper()
	s := rs(a.readStates(t), channelID)
	if s == nil {
		t.Fatalf("canal %s fora de read_states", channelID)
	}
	return num(s, "unread_count"), num(s, "mention_count")
}

// waitCounts espera (o processamento do barramento é assíncrono) até o canal ter os valores esperados.
func (a *actor) waitCounts(t *testing.T, channelID string, unread, mentions int64) {
	t.Helper()
	var gu, gm int64
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if gu, gm = a.counts(t, channelID); gu == unread && gm == mentions {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("canal %s: unread=%d mentions=%d, esperado %d e %d", channelID, gu, gm, unread, mentions)
}

func (a *actor) lastRead(t *testing.T, channelID string) string {
	t.Helper()
	return str(rs(a.readStates(t), channelID), "last_read_message_id")
}

func msgID(m J) string { return str(m, "id") }

// ---------- 401 e validação ----------

func TestNotificationRoutesRequireAuth(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	for _, r := range []struct{ method, path string }{
		{"PUT", "/api/channels/1/ack"}, {"GET", "/api/users/@me/read-states"}, {"GET", "/api/push/vapid-public-key"},
		{"POST", "/api/push/subscriptions"}, {"DELETE", "/api/push/subscriptions"},
	} {
		resp, b := e.do(t, r.method, r.path, J{}, nil)
		status(t, resp, b, 401)
	}
}

// ---------- não lidas ----------

func TestUnreadCountAfterReadingAndNewMessages(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Não lidas", owner, member)

	// sem mensagens: nada a ler
	if u, m := member.counts(t, g.textID); u != 0 || m != 0 {
		t.Fatalf("canal vazio: %d %d", u, m)
	}

	var ids []string
	for i := 0; i < 3; i++ {
		ids = append(ids, msgID(owner.say(t, g.textID, fmt.Sprintf("mensagem %d", i), 201)))
	}
	member.waitCounts(t, g.textID, 3, 0)

	// ack parcial: lê até a 2ª, sobra 1
	up := member.ack(t, g.textID, ids[1], 200)
	if str(up, "last_read_message_id") != ids[1] || num(up, "mention_count") != 0 {
		t.Fatalf("ack: %v", up)
	}
	member.waitCounts(t, g.textID, 1, 0)
	// nunca regride: ack da 1ª depois da 2ª mantém a 2ª
	up = member.ack(t, g.textID, ids[0], 200)
	if str(up, "last_read_message_id") != ids[1] {
		t.Fatalf("a leitura regrediu: %v", up)
	}
	member.waitCounts(t, g.textID, 1, 0)
	// ack total zera
	member.ack(t, g.textID, ids[2], 200)
	member.waitCounts(t, g.textID, 0, 0)

	// novas mensagens voltam a contar
	n1 := msgID(owner.say(t, g.textID, "nova 1", 201))
	owner.say(t, g.textID, "nova 2", 201)
	member.waitCounts(t, g.textID, 2, 0)

	// a própria mensagem nunca conta: o membro escreve e continua com o que o OUTRO enviou depois
	mine := msgID(member.say(t, g.textID, "minha", 201))
	owner.say(t, g.textID, "depois da minha", 201)
	// escrever avança a leitura do autor até a própria mensagem (n1 e "nova 2" ficam lidas): só a última sobra
	member.waitCounts(t, g.textID, 1, 0)
	if lr := member.lastRead(t, g.textID); lr < mine {
		t.Fatalf("last_read %s deveria ter alcançado a própria mensagem %s", lr, mine)
	}
	_ = n1

	// o dono também avançou ao escrever "depois da minha": a mensagem do membro, mais antiga, fica lida
	owner.waitCounts(t, g.textID, 0, 0)
}

func TestOwnMessagesNeverCountEvenBeforeTheAsyncAdvance(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	a, b := e.newActor(t, "ana"), e.newActor(t, "bia")
	g := friends(t, "Próprias", a, b)
	for i := 0; i < 5; i++ {
		a.say(t, g.textID, "eu", 201)
		// consulta imediata: a consulta exclui o autor, mesmo que o avanço assíncrono ainda não tenha rodado
		if u, _ := a.counts(t, g.textID); u != 0 {
			t.Fatalf("mensagem própria contou como não lida (%d)", u)
		}
	}
}

func TestAckClampsAndAccessRules(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member, outsider := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "fora")
	g := friends(t, "Ack", owner, member)
	m1 := msgID(owner.say(t, g.textID, "um", 201))
	m2 := msgID(owner.say(t, g.textID, "dois", 201))

	// um ID do futuro é limitado à última mensagem (não "lê" o que ainda não existe)
	up := member.ack(t, g.textID, "9000000000000000000", 200)
	if str(up, "last_read_message_id") != m2 {
		t.Fatalf("ack no futuro deveria ir até %s: %v", m2, up)
	}
	owner.say(t, g.textID, "três", 201)
	member.waitCounts(t, g.textID, 1, 0)
	_ = m1

	member.ack(t, g.textID, "abc", 422)
	member.ack(t, g.textID, "0", 422)
	outsider.ack(t, g.textID, m2, 404) // não é membro
	member.ack(t, g.voiceID, m2, 422)  // canal de voz não tem leitura
	member.call(t, "PUT", "/api/channels/xyz/ack", J{"message_id": m2}, 404)

	// sem VIEW_CHANNEL: 403
	owner.call(t, "PATCH", "/api/guilds/"+g.id+"/roles/"+g.id, J{"permissions": int64(perm.SendMessages)}, 200)
	member.ack(t, g.textID, m2, 403)
}

func TestReadStatesBaselineIgnoresHistoryBeforeJoining(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, late := e.newActor(t, "dono"), e.newActor(t, "tardio")
	g := owner.createGuild(t, "Entrada tardia")
	for i := 0; i < 5; i++ {
		owner.say(t, g.textID, fmt.Sprintf("histórico %d", i), 201)
	}
	time.Sleep(20 * time.Millisecond)
	before := time.Now()
	late.join(t, owner, g.id)

	s := late.readStates(t)
	item := rs(s, g.textID)
	if item == nil || num(item, "unread_count") != 0 {
		t.Fatalf("o histórico anterior à entrada não pode contar: %v", item)
	}
	base, _ := strconv.ParseInt(str(item, "last_read_message_id"), 10, 64)
	if got := snowflake.Time(base); got.Before(before.Add(-2*time.Second)) || got.After(time.Now().Add(time.Second)) {
		t.Fatalf("a base deve ser o instante de entrada, veio %v (entrada ~%v)", got, before)
	}
	// o ID-base é o menor ID possível daquele milissegundo (mesma conta do snowflake do Go)
	var viaSQL int64
	var joined time.Time
	if err := e.pool.QueryRow(context.Background(),
		`SELECT joined_at, snowflake_floor(joined_at) FROM guild_members WHERE guild_id = $1 AND user_id = $2`, mustInt(t, g.id), mustInt(t, late.id)).Scan(&joined, &viaSQL); err != nil {
		t.Fatal(err)
	}
	if want := (joined.UnixMilli() - time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()) << 22; viaSQL != want || base != want {
		t.Fatalf("snowflake_floor=%d base=%d, esperado %d", viaSQL, base, want)
	}
	if snowflake.Time(viaSQL).UnixMilli() != joined.UnixMilli() {
		t.Fatalf("a base não casa com o instante de entrada")
	}

	owner.say(t, g.textID, "depois da entrada 1", 201)
	owner.say(t, g.textID, "depois da entrada 2", 201)
	late.waitCounts(t, g.textID, 2, 0)
	// quem já estava lá desde o começo vê o histórico inteiro como não lido (é o que "entrou antes" significa)
}

func TestLeavingAGuildForgetsReadStateSoRejoinDoesNotInheritHistory(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Volta", owner, member)
	owner.say(t, g.textID, "antes de sair", 201)
	member.waitCounts(t, g.textID, 1, 0)
	member.ack(t, g.textID, msgID(owner.say(t, g.textID, "lida", 201)), 200)

	member.call(t, "DELETE", "/api/guilds/"+g.id+"/members/@me", nil, 204)
	for i := 0; i < 3; i++ {
		owner.say(t, g.textID, "enquanto estava fora", 201)
	}
	waitUntil(t, "estado de leitura apagado", func() bool {
		var n int
		_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM read_states WHERE user_id = $1 AND channel_id = $2`, mustInt(t, member.id), mustInt(t, g.textID)).Scan(&n)
		return n == 0
	})
	time.Sleep(20 * time.Millisecond)
	member.join(t, owner, g.id)
	if u, _ := member.counts(t, g.textID); u != 0 {
		t.Fatalf("ao voltar, o que aconteceu antes da nova entrada não conta (%d)", u)
	}
	owner.say(t, g.textID, "depois da volta", 201)
	member.waitCounts(t, g.textID, 1, 0)
}

func TestReadStatesDM(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "bia"), e.newActor(t, "cris")
	friends(t, "DMs", a, b, c)
	dm := str(a.openDM(t, b.id, 201), "id")
	if item := rs(b.readStates(t), dm); item == nil || num(item, "unread_count") != 0 || str(item, "guild_id") != "" {
		t.Fatalf("DM nova: %v", item)
	}
	if rs(c.readStates(t), dm) != nil {
		t.Fatal("quem não participa não vê a DM")
	}
	a.say(t, dm, "oi", 201)
	a.say(t, dm, "tudo bem?", 201)
	// DM: toda mensagem dos outros vale como menção
	b.waitCounts(t, dm, 2, 2)
	if u, m := a.counts(t, dm); u != 0 || m != 0 {
		t.Fatalf("autor: %d %d", u, m)
	}
	// DM não entra no agregado por servidor
	for _, g := range list(b.readStates(t), "guilds") {
		if num(g, "unread_count") != 0 {
			t.Fatalf("DM vazou para o servidor: %v", g)
		}
	}
	last := msgID(b.say(t, dm, "tudo e você?", 201))
	_ = last
	b.waitCounts(t, dm, 0, 0) // responder lê a conversa e zera as menções
	a.waitCounts(t, dm, 1, 1)
	a.ack(t, dm, last, 200)
	a.waitCounts(t, dm, 0, 0)
	c.ack(t, dm, last, 404)
}

func TestReadStatesExcludeChannelsWithoutViewChannel(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member, blind := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "cego")
	g := owner.createGuild(t, "Cegos")
	base := "/api/guilds/" + g.id
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.SendMessages)}, 200)
	visitor := owner.role(t, g.id, J{"name": "Visitante", "position": 1, "permissions": int64(perm.ViewChannel)})
	member.join(t, owner, g.id)
	blind.join(t, owner, g.id)
	owner.giveRole(t, g.id, member.id, str(visitor, "id"))
	owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "oi"}, 201)

	member.waitCounts(t, g.textID, 1, 0)
	bs := blind.readStates(t)
	if rs(bs, g.textID) != nil || guildRS(bs, g.id) != nil {
		t.Fatalf("sem VIEW_CHANNEL o canal não aparece: %v", bs)
	}
	if rs(owner.readStates(t), g.textID) == nil {
		t.Fatal("o dono vê o canal")
	}
	// voz e categorias não têm leitura
	ms := member.readStates(t)
	if rs(ms, g.voiceID) != nil || rs(ms, g.categoryID) != nil {
		t.Fatalf("só texto e DMs: %v", ms)
	}
}

func TestUnreadCountIsCappedAt100AndGuildSumToo(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Teto", owner, member)
	second := str(obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "segundo"}, 201)), "id")

	for i := 0; i < 101; i++ {
		owner.say(t, g.textID, "m", 201)
	}
	for i := 0; i < 5; i++ {
		owner.say(t, second, "n", 201)
	}
	member.waitCounts(t, second, 5, 0)
	s := member.readStates(t)
	if num(rs(s, g.textID), "unread_count") != notification.MaxUnread {
		t.Fatalf("teto por canal: %v", rs(s, g.textID))
	}
	gr := guildRS(s, g.id)
	if num(gr, "unread_count") != notification.MaxUnread || num(gr, "mention_count") != 0 {
		t.Fatalf("soma por servidor limitada: %v", gr)
	}

	// ler o primeiro canal deixa só o segundo no agregado (a soma não é o teto fixo)
	last := msgID(list(obj(t, member.call(t, "GET", "/api/channels/"+g.textID+"/messages?limit=1", nil, 200)), "messages")[0])
	member.ack(t, g.textID, last, 200)
	member.waitCounts(t, g.textID, 0, 0)
	if gr := guildRS(member.readStates(t), g.id); num(gr, "unread_count") != 5 {
		t.Fatalf("soma depois do ack: %v", gr)
	}
}

func TestReadStatesQueryCountDoesNotGrowWithChannels(t *testing.T) {
	var cp *countingPool
	e := newEnvWith(t, func(d *Deps) {
		notifCfg(d)
		cp = &countingPool{Pool: d.Pool}
		d.Pool = cp
	})
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "SemNMaisUm", owner, member)
	owner.say(t, g.textID, "x", 201)
	member.openDM(t, owner.id, 201)

	queries := func() (int64, J) {
		before := cp.n.Load()
		s := member.readStates(t)
		return cp.n.Load() - before, s
	}
	few, s := queries()
	if len(list(s, "read_states")) != 2 { // o canal de texto e a DM
		t.Fatalf("canais: %v", s)
	}
	for i := 0; i < 30; i++ {
		ch := str(obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": fmt.Sprintf("c%d", i)}, 201)), "id")
		owner.say(t, ch, "oi", 201)
		if i%5 == 0 {
			other := e.newActor(t, "outro")
			other.join(t, owner, g.id)
			other.openDM(t, member.id, 201)
		}
	}
	many, s := queries()
	if len(list(s, "read_states")) < 32 {
		t.Fatalf("canais: %d", len(list(s, "read_states")))
	}
	if few != many {
		t.Fatalf("o número de consultas depende do número de canais: %d (2 canais) vs %d (%d canais) — N+1", few, many, len(list(s, "read_states")))
	}
	t.Logf("consultas por GET /users/@me/read-states: %d (2 e %d canais)", many, len(list(s, "read_states")))
}

// ---------- menções ----------

func TestMentionsIncrementCountAndAppearInPayload(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member, other, outsider := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "outro"), e.newActor(t, "fora")
	g := friends(t, "Menções", owner, member, other)
	mc := member.connect(t)
	mc.identify()

	text := fmt.Sprintf("oi @%s e @%s, @%s e @%s.com e @%s (de novo @%s)",
		strings.ToUpper(member.name), outsider.name, owner.name, member.name, owner.name, member.name)
	msg := owner.say(t, g.textID, text, 201)

	ids := arrStrings(msg["mention_ids"])
	if len(ids) != 1 || ids[0] != member.id {
		t.Fatalf("só o membro vale (o outro não está no servidor, o autor não conta, e@x não é menção): %v", ids)
	}
	created := payload(t, mc.event("MESSAGE_CREATE"))
	if got := arrStrings(created["mention_ids"]); len(got) != 1 || got[0] != member.id {
		t.Fatalf("MESSAGE_CREATE: %v", created["mention_ids"])
	}
	// READ_STATE_UPDATE chega ao mencionado, com o contador
	up := payload(t, mc.event("READ_STATE_UPDATE"))
	if str(up, "channel_id") != g.textID || num(up, "mention_count") != 1 {
		t.Fatalf("READ_STATE_UPDATE: %v", up)
	}
	member.waitCounts(t, g.textID, 1, 1)
	other.waitCounts(t, g.textID, 1, 0) // não mencionado: lê sem contador
	owner.say(t, g.textID, "@"+member.name+" de novo", 201)
	member.waitCounts(t, g.textID, 2, 2)

	// o histórico traz o mesmo mention_ids
	hist := list(obj(t, other.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 200)), "messages")
	if got := arrStrings(hist[1]["mention_ids"]); len(got) != 1 || got[0] != member.id {
		t.Fatalf("histórico: %v", hist[1]["mention_ids"])
	}
	if got, ok := hist[0]["mention_ids"].([]any); !ok || len(got) != 1 {
		t.Fatalf("histórico (2ª): %v", hist[0]["mention_ids"])
	}
	plain := owner.say(t, g.textID, "sem ninguém", 201)
	if v, ok := plain["mention_ids"].([]any); !ok || len(v) != 0 {
		t.Fatalf("mention_ids deve ser [] e não null: %v", plain["mention_ids"])
	}

	// ack total zera as menções
	last := msgID(plain)
	member.ack(t, g.textID, last, 200)
	member.waitCounts(t, g.textID, 0, 0)
}

func TestMentionIgnoresUsersWhoCannotSeeTheChannel(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, blind, seer := e.newActor(t, "dono"), e.newActor(t, "cego"), e.newActor(t, "vidente")
	g := owner.createGuild(t, "Sem ver")
	owner.call(t, "PATCH", "/api/guilds/"+g.id+"/roles/"+g.id, J{"permissions": int64(perm.SendMessages)}, 200)
	visitor := owner.role(t, g.id, J{"name": "Visitante", "position": 1, "permissions": int64(perm.ViewChannel)})
	blind.join(t, owner, g.id)
	seer.join(t, owner, g.id)
	owner.giveRole(t, g.id, seer.id, str(visitor, "id"))

	msg := owner.say(t, g.textID, fmt.Sprintf("@%s @%s", blind.name, seer.name), 201)
	if ids := arrStrings(msg["mention_ids"]); len(ids) != 1 || ids[0] != seer.id {
		t.Fatalf("quem não vê o canal não é mencionado: %v", ids)
	}
}

func TestMentionInDMResolvesAmongParticipants(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "bia"), e.newActor(t, "cris")
	friends(t, "DM menção", a, b, c)
	dm := str(a.openDM(t, b.id, 201), "id")
	msg := a.say(t, dm, fmt.Sprintf("@%s @%s", b.name, c.name), 201) // cris não participa
	if ids := arrStrings(msg["mention_ids"]); len(ids) != 1 || ids[0] != b.id {
		t.Fatalf("%v", ids)
	}
}

func arrStrings(v any) []string {
	items, _ := v.([]any)
	out := make([]string, len(items))
	for i, it := range items {
		out[i], _ = it.(string)
	}
	return out
}

// ---------- gateway ----------

func TestReadStateUpdateReachesTheOtherSessionAndReadyCarriesReadStates(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Sessões", owner, member)
	quiet := str(obj(t, owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "quieto"}, 201)), "id")

	owner.say(t, g.textID, "um", 201)
	owner.say(t, g.textID, fmt.Sprintf("@%s dois", member.name), 201)
	last := msgID(owner.say(t, g.textID, "três", 201))
	member.waitCounts(t, g.textID, 3, 1)

	// READY: só os canais com não lidas ou menções
	first := member.connect(t)
	_, ready := first.identify()
	states := list(ready, "read_states")
	if len(states) != 1 || str(states[0], "channel_id") != g.textID || num(states[0], "unread_count") != 3 ||
		num(states[0], "mention_count") != 1 || str(states[0], "guild_id") != g.id {
		t.Fatalf("READY.read_states: %v", ready["read_states"])
	}
	for _, s := range states {
		if str(s, "channel_id") == quiet {
			t.Fatal("canal sem não lidas não deve ir no READY")
		}
	}
	// READY sempre traz array (usuário sem nada)
	fresh := e.newActor(t, "novo")
	fc := fresh.connect(t)
	_, fready := fc.identify()
	if v, ok := fready["read_states"].([]any); !ok || len(v) != 0 {
		t.Fatalf("read_states deve ser [] e não null: %v", fready["read_states"])
	}

	// a OUTRA sessão do mesmo usuário recebe o ack feito por REST (ou por qualquer dispositivo)
	second := member.connect(t)
	second.identify()
	member.ack(t, g.textID, last, 200)
	for _, c := range []*wsClient{first, second} {
		up := payload(t, c.event("READ_STATE_UPDATE"))
		if str(up, "channel_id") != g.textID || str(up, "last_read_message_id") != last || num(up, "mention_count") != 0 {
			t.Fatalf("READ_STATE_UPDATE: %v", up)
		}
	}
	// ninguém mais recebe: o dono não vê o ack do membro
	oc := owner.connect(t)
	oc.identify()
	member.ack(t, g.textID, last, 200)
	oc.noEvent(300*time.Millisecond, "READ_STATE_UPDATE")
}

// ---------- Web Push ----------

type pushHit struct {
	path   string
	header http.Header
	body   []byte
}

// fakePush é o "serviço de push" dos testes: um servidor HTTPS local que registra as requisições.
type fakePush struct {
	srv    *httptest.Server
	mu     sync.Mutex
	hits   []pushHit
	status func(n int) int // status da n-ésima requisição (1, 2…); nil = 201
}

func newFakePush(t *testing.T) *fakePush {
	t.Helper()
	f := &fakePush{}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.hits = append(f.hits, pushHit{path: r.URL.Path, header: r.Header.Clone(), body: b})
		n := len(f.hits)
		f.mu.Unlock()
		code := http.StatusCreated
		if f.status != nil {
			code = f.status(n)
		}
		w.WriteHeader(code)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakePush) endpoint(name string) string { return f.srv.URL + "/push/" + name }

func (f *fakePush) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.hits) }

func (f *fakePush) waitHits(t *testing.T, n int) []pushHit {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if f.count() >= n {
			f.mu.Lock()
			defer f.mu.Unlock()
			return append([]pushHit(nil), f.hits...)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("o serviço de push recebeu %d requisições, esperado %d", f.count(), n)
	return nil
}

// quiet falha se chegar requisição durante d.
func (f *fakePush) quiet(t *testing.T, d time.Duration) {
	t.Helper()
	time.Sleep(d)
	if n := f.count(); n != 0 {
		t.Fatalf("não deveria ter enviado push (%d requisições)", n)
	}
}

func browserKeys(t *testing.T) J {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	return J{"p256dh": base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()), "auth": base64.RawURLEncoding.EncodeToString(auth)}
}

func (a *actor) subscribe(t *testing.T, endpoint string, want int) {
	t.Helper()
	a.call(t, "POST", "/api/push/subscriptions", J{"endpoint": endpoint, "keys": browserKeys(t)}, want)
}

func (e *testEnv) subCount(t *testing.T, userID string) int {
	t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, mustInt(t, userID)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (e *testEnv) waitSubCount(t *testing.T, userID string, want int) {
	t.Helper()
	waitUntil(t, fmt.Sprintf("%d inscrições", want), func() bool { return e.subCount(t, userID) == want })
}

// pushEnv monta o app com VAPID e o serviço de push falso (o anti-SSRF só é relaxado aqui).
func pushEnv(t *testing.T, fp *fakePush, tweak ...func(*Deps)) *testEnv {
	t.Helper()
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	return newEnvWith(t, func(d *Deps) {
		notifCfg(d)
		d.Cfg.VAPID = config.VAPID{PublicKey: pub, PrivateKey: priv, Subject: "mailto:teste@spook.example"}
		if fp != nil {
			d.Push = PushOptions{AllowPrivate: true, HTTPClient: fp.srv.Client()}
		}
		for _, tw := range tweak {
			tw(d)
		}
	})
}

func TestPushDisabledWithoutVAPID(t *testing.T) {
	e := newEnvWith(t, notifCfg)
	u := e.newActor(t, "ana")
	u.call(t, "GET", "/api/push/vapid-public-key", nil, 503)
	u.call(t, "POST", "/api/push/subscriptions", J{"endpoint": "https://fcm.googleapis.com/x", "keys": browserKeys(t)}, 503)
	u.call(t, "DELETE", "/api/push/subscriptions", J{"endpoint": "https://fcm.googleapis.com/x"}, 503)
	resp, b := u.do(t, "GET", "/api/push/vapid-public-key", nil)
	if !strings.Contains(string(b), "push") || resp.StatusCode != 503 {
		t.Fatalf("mensagem em pt-br esperada: %s", b)
	}
	// o resto continua funcionando e nenhum job é enfileirado
	b2 := e.newActor(t, "bia")
	g := friends(t, "Sem push", u, b2)
	u.say(t, g.textID, fmt.Sprintf("@%s oi", b2.name), 201)
	b2.waitCounts(t, g.textID, 1, 1)
	var jobs int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM river_job WHERE kind = 'push' AND (args->>'channel_id')::bigint = $1`, mustInt(t, g.textID)).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 0 {
		t.Fatalf("%d jobs de push com o push desligado", jobs)
	}
}

func TestPushSubscriptionEndpoints(t *testing.T) {
	fp := newFakePush(t)
	e := pushEnv(t, fp)
	u, v := e.newActor(t, "ana"), e.newActor(t, "bia")

	key := obj(t, u.call(t, "GET", "/api/push/vapid-public-key", nil, 200))
	if len(str(key, "public_key")) < 80 {
		t.Fatalf("chave pública: %v", key)
	}
	u.subscribe(t, fp.endpoint("a"), 204)
	u.subscribe(t, fp.endpoint("a"), 204) // upsert pelo endpoint: não conta duas vezes
	e.waitSubCount(t, u.id, 1)
	u.call(t, "POST", "/api/push/subscriptions", J{"endpoint": fp.endpoint("b"), "keys": J{"p256dh": "ruim", "auth": "ruim"}}, 422)
	u.call(t, "POST", "/api/push/subscriptions", J{"endpoint": "http://exemplo.com/x", "keys": browserKeys(t)}, 422) // só https
	u.call(t, "POST", "/api/push/subscriptions", J{"endpoint": "", "keys": browserKeys(t)}, 422)

	// remover é idempotente e só vale para o dono do endpoint
	v.call(t, "DELETE", "/api/push/subscriptions", J{"endpoint": fp.endpoint("a")}, 204)
	e.waitSubCount(t, u.id, 1)
	u.call(t, "DELETE", "/api/push/subscriptions", J{"endpoint": fp.endpoint("a")}, 204)
	u.call(t, "DELETE", "/api/push/subscriptions", J{"endpoint": fp.endpoint("a")}, 204)
	e.waitSubCount(t, u.id, 0)
}

func TestPushSubscriptionLimitOf10(t *testing.T) {
	fp := newFakePush(t)
	e := pushEnv(t, fp)
	u := e.newActor(t, "ana")
	for i := 0; i < notification.MaxSubscriptions; i++ {
		u.subscribe(t, fp.endpoint(fmt.Sprintf("d%d", i)), 204)
	}
	u.subscribe(t, fp.endpoint("d11"), 409)
	u.subscribe(t, fp.endpoint("d0"), 204) // reinscrever um existente não estoura o limite
	u.call(t, "DELETE", "/api/push/subscriptions", J{"endpoint": fp.endpoint("d3")}, 204)
	u.subscribe(t, fp.endpoint("d11"), 204)
	e.waitSubCount(t, u.id, notification.MaxSubscriptions)
}

func TestPushSubscriptionLimitHoldsUnderConcurrency(t *testing.T) {
	fp := newFakePush(t)
	e := pushEnv(t, fp)
	u := e.newActor(t, "ana")
	var wg sync.WaitGroup
	var ok, conflict atomic.Int32
	for i := 0; i < 25; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body := J{"endpoint": fp.endpoint(fmt.Sprintf("c%d", i)), "keys": browserKeys(t)}
			resp, _ := u.do(t, "POST", "/api/push/subscriptions", body)
			switch resp.StatusCode {
			case 204:
				ok.Add(1)
			case 409:
				conflict.Add(1)
			}
		}()
	}
	wg.Wait()
	if ok.Load() != 10 || conflict.Load() != 15 || e.subCount(t, u.id) != 10 {
		t.Fatalf("ok=%d conflitos=%d no banco=%d", ok.Load(), conflict.Load(), e.subCount(t, u.id))
	}
}

func TestPushRejectsPrivateEndpointsOnSubscribe(t *testing.T) {
	e := pushEnv(t, nil) // política de produção: nada de rede interna
	u := e.newActor(t, "ana")
	for _, ep := range []string{
		"https://127.0.0.1/x", "https://127.0.0.1:8443/x", "https://localhost/x", "https://[::1]/x", "https://10.0.0.5/push",
		"https://192.168.1.10/push", "https://169.254.169.254/latest/meta-data", "https://172.16.0.1/x", "https://0.0.0.0/x",
		"https://fcm.googleapis.com:8443/x", "https://user:senha@fcm.googleapis.com/x",
	} {
		u.call(t, "POST", "/api/push/subscriptions", J{"endpoint": ep, "keys": browserKeys(t)}, 422)
	}
	if n := e.subCount(t, u.id); n != 0 {
		t.Fatalf("%d inscrições gravadas", n)
	}
}

func TestPushDeliveredToOfflineUserOnMention(t *testing.T) {
	fp := newFakePush(t)
	e := pushEnv(t, fp)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Push", owner, member)
	member.subscribe(t, fp.endpoint("membro"), 204)

	// mensagem comum em servidor: sem push
	owner.say(t, g.textID, "bom dia", 201)
	member.waitCounts(t, g.textID, 1, 0)
	fp.quiet(t, 1500*time.Millisecond)

	// menção direta com o usuário offline: push
	owner.say(t, g.textID, fmt.Sprintf("@%s olha isso", member.name), 201)
	hits := fp.waitHits(t, 1)
	h := hits[0]
	if h.path != "/push/membro" {
		t.Fatalf("endpoint: %s", h.path)
	}
	if h.header.Get("Content-Encoding") != "aes128gcm" || h.header.Get("TTL") != "3600" {
		t.Fatalf("cabeçalhos: %v", h.header)
	}
	if auth := h.header.Get("Authorization"); !strings.HasPrefix(strings.ToLower(auth), "vapid t=") || !strings.Contains(auth, "k=") {
		t.Fatalf("Authorization VAPID: %q", auth)
	}
	if len(h.body) < 100 || strings.Contains(string(h.body), "olha isso") {
		t.Fatalf("corpo deve ser cifrado e não vazio (%d bytes)", len(h.body))
	}
	time.Sleep(500 * time.Millisecond)
	if fp.count() != 1 {
		t.Fatalf("esperava exatamente 1 push, houve %d", fp.count())
	}
}

func TestPushNotSentToOnlineUserNorToTheAuthor(t *testing.T) {
	fp := newFakePush(t)
	e := pushEnv(t, fp)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Push online", owner, member)
	member.subscribe(t, fp.endpoint("membro"), 204)
	owner.subscribe(t, fp.endpoint("dono"), 204)

	mc := member.connect(t)
	mc.identify()
	owner.say(t, g.textID, fmt.Sprintf("@%s está aí?", member.name), 201)
	mc.event("READ_STATE_UPDATE")
	// o autor se menciona: nunca recebe
	owner.say(t, g.textID, fmt.Sprintf("@%s (eu mesmo)", owner.name), 201)
	fp.quiet(t, 1500*time.Millisecond)

	// quando a última sessão cai e a tolerância passa, volta a receber
	mc.ws.Close(1000, "")
	time.Sleep(testGrace + 400*time.Millisecond)
	owner.say(t, g.textID, fmt.Sprintf("@%s agora sim", member.name), 201)
	fp.waitHits(t, 1)
}

func TestPushForDMs(t *testing.T) {
	fp := newFakePush(t)
	e := pushEnv(t, fp)
	a, b, c := e.newActor(t, "ana"), e.newActor(t, "bia"), e.newActor(t, "cris")
	friends(t, "DM push", a, b, c)
	b.subscribe(t, fp.endpoint("bia"), 204)
	c.subscribe(t, fp.endpoint("cris"), 204)
	a.subscribe(t, fp.endpoint("ana"), 204)

	dm := str(a.openDM(t, b.id, 201), "id")
	a.say(t, dm, "oi, sem @ nenhum", 201) // DM não precisa de menção
	hits := fp.waitHits(t, 1)
	if hits[0].path != "/push/bia" {
		t.Fatalf("só a bia (a ana é a autora, a cris não participa): %s", hits[0].path)
	}

	// DM em grupo: todos os outros participantes
	group := str(a.newGroup(t, 201, b.id, c.id), "id")
	a.say(t, group, "grupo", 201)
	waitUntil(t, "push do grupo", func() bool { return fp.count() == 3 })
	paths := map[string]bool{}
	for _, h := range fp.waitHits(t, 3) {
		paths[h.path] = true
	}
	if !paths["/push/bia"] || !paths["/push/cris"] || paths["/push/ana"] {
		t.Fatalf("destinos: %v", paths)
	}
}

func TestPushGone410RemovesSubscription(t *testing.T) {
	fp := newFakePush(t)
	fp.status = func(int) int { return http.StatusGone }
	e := pushEnv(t, fp)
	a, b := e.newActor(t, "ana"), e.newActor(t, "bia")
	friends(t, "Push 410", a, b)
	b.subscribe(t, fp.endpoint("morta"), 204)
	dm := str(a.openDM(t, b.id, 201), "id")
	a.say(t, dm, "alguém aí?", 201)
	fp.waitHits(t, 1)
	e.waitSubCount(t, b.id, 0)
	// sem inscrição, a próxima mensagem não gera requisição
	a.say(t, dm, "mais uma", 201)
	time.Sleep(800 * time.Millisecond)
	if fp.count() != 1 {
		t.Fatalf("requisições: %d", fp.count())
	}
}

func TestPushTemporaryFailureIsRetried(t *testing.T) {
	fp := newFakePush(t)
	fp.status = func(n int) int {
		if n == 1 {
			return http.StatusServiceUnavailable
		}
		return http.StatusCreated
	}
	e := pushEnv(t, fp)
	a, b := e.newActor(t, "ana"), e.newActor(t, "bia")
	friends(t, "Push retry", a, b)
	b.subscribe(t, fp.endpoint("instavel"), 204)
	dm := str(a.openDM(t, b.id, 201), "id")
	a.say(t, dm, "tenta de novo", 201)
	fp.waitHits(t, 2) // a 1ª recebe 503 e o River repete com backoff
	if e.subCount(t, b.id) != 1 {
		t.Fatal("falha temporária não remove a inscrição")
	}
}

func TestPushToPrivateEndpointIsBlockedAtSendTime(t *testing.T) {
	fp := newFakePush(t) // um servidor em 127.0.0.1, mas o app usa a política de produção
	e := pushEnv(t, nil)
	a, b := e.newActor(t, "ana"), e.newActor(t, "bia")
	friends(t, "Push SSRF", a, b)
	k := browserKeys(t)
	// a inscrição entra direto no banco (como se o DNS tivesse mudado depois de validada)
	if _, err := e.pool.Exec(context.Background(),
		`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)`,
		time.Now().UnixNano(), mustInt(t, b.id), fp.endpoint("interno"), k["p256dh"], k["auth"]); err != nil {
		t.Fatal(err)
	}
	dm := str(a.openDM(t, b.id, 201), "id")
	a.say(t, dm, "oi", 201)
	e.waitSubCount(t, b.id, 0) // bloqueada e removida
	if fp.count() != 0 {
		t.Fatalf("o servidor interno recebeu %d requisições", fp.count())
	}
}

func TestPushEndpointsRateLimited(t *testing.T) {
	fp := newFakePush(t)
	e := pushEnv(t, fp, func(d *Deps) { d.PushLimiter = ratelimit.New(0.001, 3) })
	u := e.newActor(t, "ana")
	for i := 0; i < 3; i++ {
		u.call(t, "GET", "/api/push/vapid-public-key", nil, 200)
	}
	resp, b := u.do(t, "GET", "/api/push/vapid-public-key", nil)
	status(t, resp, b, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("sem Retry-After")
	}
}
