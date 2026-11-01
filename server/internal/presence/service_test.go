package presence

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

// ---- dublês ----

type fakeClock struct {
	mu     sync.Mutex
	now    time.Duration
	timers []*fakeTimer
}

type fakeTimer struct {
	at      time.Duration
	f       func()
	stopped bool
	fired   bool
}

func (t *fakeTimer) Stop() bool {
	was := !t.stopped && !t.fired
	t.stopped = true
	return was
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{at: c.now + d, f: f}
	c.timers = append(c.timers, t)
	return t
}

var epoch = time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)

// wall é o "agora" do serviço: o relógio falso a partir de uma época fixa.
func (c *fakeClock) wall() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return epoch.Add(c.now)
}

// advance move o relógio e dispara os timers vencidos (fora do lock, como o time.AfterFunc faz).
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now += d
	var due []*fakeTimer
	for _, t := range c.timers {
		if !t.stopped && !t.fired && t.at <= c.now {
			t.fired = true
			due = append(due, t)
		}
	}
	c.mu.Unlock()
	for _, t := range due {
		t.f()
	}
}

type fakeStore struct {
	guilds  map[int64][]int64
	peers   map[int64][]int64
	sharing map[int64][]int64 // quem enxerga quem (para o snapshot)
	members map[int64][]int64 // servidor -> membros
	prefs   map[int64]Prefs
}

func (f *fakeStore) Audience(_ context.Context, u int64) ([]int64, []int64, error) {
	return f.guilds[u], f.peers[u], nil
}

func (f *fakeStore) OnlineSharing(_ context.Context, u int64, online []int64) ([]int64, error) {
	var out []int64
	for _, o := range online {
		for _, v := range f.sharing[u] {
			if v == o {
				out = append(out, o)
			}
		}
	}
	return out, nil
}

func (f *fakeStore) OnlineGuildMembers(_ context.Context, g int64, online []int64) ([]int64, error) {
	var out []int64
	for _, o := range online {
		for _, m := range f.members[g] {
			if m == o {
				out = append(out, o)
			}
		}
	}
	return out, nil
}

func (f *fakeStore) Prefs(_ context.Context, u int64) (Prefs, error) {
	if p, ok := f.prefs[u]; ok {
		return p, nil
	}
	return Prefs{Pref: PrefOnline}, nil
}

func (f *fakeStore) SetPrefs(_ context.Context, u int64, p Prefs) (bool, error) {
	if f.prefs == nil {
		f.prefs = map[int64]Prefs{}
	}
	f.prefs[u] = p
	return true, nil
}

type collector struct {
	mu  sync.Mutex
	got []events.Event
}

func (c *collector) Publish(ev events.Event) { c.mu.Lock(); c.got = append(c.got, ev); c.mu.Unlock() }

func (c *collector) all() []events.Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]events.Event(nil), c.got...)
}

type rig struct {
	t     *testing.T
	svc   *Service
	clock *fakeClock
	pub   *collector
	store *fakeStore
}

func newRig(t *testing.T) *rig {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	st := &fakeStore{
		guilds: map[int64][]int64{1: {100, 200}}, peers: map[int64][]int64{1: {7}},
		sharing: map[int64][]int64{}, members: map[int64][]int64{},
	}
	clock, pub := &fakeClock{}, &collector{}
	svc := NewService(ctx, Config{OfflineGrace: 15 * time.Second, Clock: clock, Shards: 2, Now: clock.wall}, st, pub, nil)
	return &rig{t: t, svc: svc, clock: clock, pub: pub, store: st}
}

// flush espera as filas de publicação esvaziarem.
func (r *rig) flush() {
	r.t.Helper()
	for _, sh := range r.svc.shards {
		done := make(chan struct{})
		sh.push(func() { close(done) })
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			r.t.Fatal("fila de presença não esvaziou")
		}
	}
}

// statuses devolve os status publicados do usuário, em ordem.
func (r *rig) statuses(user string) []string {
	r.t.Helper()
	r.flush()
	var out []string
	for _, ev := range r.pub.all() {
		if p, ok := ev.Data.(UpdatePayload); ok && ev.Type == events.PresenceUpdate && p.UserID == user {
			out = append(out, p.Status)
		}
	}
	return out
}

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (r *rig) want(user string, want ...string) {
	r.t.Helper()
	if got := r.statuses(user); !eq(got, want) {
		r.t.Fatalf("eventos de %s = %v, esperado %v", user, got, want)
	}
}

// ---- testes ----

func TestConnectPublishesOnlineToGuildsAndDMPeers(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "s1")
	r.want("1", "online")
	ev := r.pub.all()[0]
	got := append([]string(nil), ev.Topics...)
	sort.Strings(got)
	want := []string{"guild:100", "guild:200", "user:7"}
	if !eq(got, want) {
		t.Fatalf("tópicos = %v, esperado %v", got, want)
	}
	if r.svc.Status(1) != StatusOnline {
		t.Fatal("deveria estar online")
	}
}

func TestOfflineOnlyAfterGrace(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "s1")
	r.svc.Disconnect(1, "s1")
	r.clock.advance(14 * time.Second)
	r.want("1", "online") // ainda dentro da tolerância
	if r.svc.Status(1) != StatusOnline {
		t.Fatal("durante a tolerância o status segue online")
	}
	r.clock.advance(time.Second)
	r.want("1", "online", "offline")
	if r.svc.Status(1) != StatusOffline {
		t.Fatal("deveria estar offline")
	}
}

func TestQuickReconnectEmitsNothing(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "s1")
	r.svc.Disconnect(1, "s1")
	r.clock.advance(10 * time.Second)
	r.svc.Connect(1, "s2") // reconexão com sessão nova
	r.clock.advance(time.Minute)
	r.want("1", "online") // nenhum offline nem online repetido
	if r.svc.Status(1) != StatusOnline {
		t.Fatal("deveria seguir online")
	}
}

func TestResumeOfSameSessionIsIdempotent(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "s1")
	r.svc.Connect(1, "s1") // resume: o gateway chama Connect de novo
	r.svc.Disconnect(1, "s1")
	r.svc.Connect(1, "s1")
	r.clock.advance(time.Minute)
	r.want("1", "online")
}

func TestOfflineThenOnlineAgain(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "s1")
	r.svc.Disconnect(1, "s1")
	r.clock.advance(15 * time.Second)
	r.svc.Connect(1, "s2")
	r.want("1", "online", "offline", "online")
}

func TestIdleViaSignal(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "s1")
	r.svc.SetIdle(1, "s1", true)
	r.svc.SetIdle(1, "s1", true) // repetido: sem evento
	r.svc.SetIdle(1, "s1", false)
	r.want("1", "online", "idle", "online")
}

func TestSetIdleIgnoresUnknownSession(t *testing.T) {
	r := newRig(t)
	r.svc.SetIdle(1, "nada", true)
	r.svc.Connect(1, "s1")
	r.svc.SetIdle(1, "outra", true)
	r.want("1", "online")
}

func TestMultipleSessionsBestStatusWins(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "web")
	r.svc.Connect(1, "desktop")
	r.svc.SetIdle(1, "web", true) // desktop segue ativo: continua online
	r.want("1", "online")
	r.svc.SetIdle(1, "desktop", true) // todas ausentes
	r.want("1", "online", "idle")
	r.svc.Connect(1, "mobile") // sessão nova e ativa
	r.want("1", "online", "idle", "online")
	r.svc.SetIdle(1, "mobile", true)
	r.want("1", "online", "idle", "online", "idle")
}

func TestOfflineOnlyWhenAllSessionsDrop(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "a")
	r.svc.Connect(1, "b")
	r.svc.Disconnect(1, "a")
	r.clock.advance(time.Minute)
	r.want("1", "online") // b segura
	r.svc.Disconnect(1, "b")
	r.clock.advance(14 * time.Second)
	r.want("1", "online")
	r.clock.advance(time.Second)
	r.want("1", "online", "offline")
}

func TestLosingTheActiveSessionFallsBackToIdleImmediately(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "a")
	r.svc.Connect(1, "b")
	r.svc.SetIdle(1, "b", true)
	r.svc.Disconnect(1, "a") // sobra só a ausente: o idle sai na hora (só o offline espera)
	r.want("1", "online", "idle")
}

func TestReconnectAfterIdleDropReportsOnline(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "a")
	r.svc.SetIdle(1, "a", true)
	r.svc.Disconnect(1, "a")
	r.svc.Connect(1, "b") // sessão nova começa ativa
	r.clock.advance(time.Minute)
	r.want("1", "online", "idle", "online")
}

func TestReconnectRestartsTheGraceFromTheNextDrop(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "a")
	r.svc.Disconnect(1, "a") // prazo vence em t=15 s
	r.clock.advance(10 * time.Second)
	r.svc.Connect(1, "a")
	r.svc.Disconnect(1, "a") // novo prazo: vence em t=25 s
	r.clock.advance(14 * time.Second)
	r.want("1", "online") // t=24 s: o prazo antigo (cancelado) não derruba
	r.clock.advance(time.Second)
	r.want("1", "online", "offline")
}

func TestSnapshotListsOnlyVisibleNonOffline(t *testing.T) {
	r := newRig(t)
	r.store.sharing[1] = []int64{2, 3} // 1 vê 2 e 3; 4 não é visível
	r.svc.Connect(2, "x")
	r.svc.Connect(3, "y")
	r.svc.SetIdle(3, "y", true)
	r.svc.Connect(4, "z")
	r.svc.Connect(1, "me")
	snap, err := r.svc.Snapshot(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, p := range snap {
		got[p.UserID] = p.Status
	}
	if len(got) != 2 || got["2"] != "online" || got["3"] != "idle" {
		t.Fatalf("snapshot = %v", snap)
	}
	empty, _ := newRig(t).svc.Snapshot(context.Background(), 1)
	if empty == nil || len(empty) != 0 {
		t.Fatalf("sem ninguém online o snapshot deve ser [] (não nulo): %#v", empty)
	}
}

func TestMemberJoinedPublishesToGuildAndSendsPresencesToJoiner(t *testing.T) {
	r := newRig(t)
	r.store.members[300] = []int64{2, 3}
	r.svc.Connect(2, "x")
	r.svc.Connect(1, "me")
	r.flush()
	before := len(r.pub.all())
	r.svc.onEvent(events.Event{Type: events.GuildMemberAdd, GuildID: 300, Data: map[string]any{"user_id": "1"}})
	r.flush()
	evs := r.pub.all()[before:]
	var toGuild, toJoiner int
	for _, ev := range evs {
		p := ev.Data.(UpdatePayload)
		switch {
		case ev.Topics[0] == "guild:300" && p.UserID == "1" && p.Status == "online":
			toGuild++
		case ev.Topics[0] == "user:1" && p.UserID == "2" && p.Status == "online":
			toJoiner++
		}
	}
	if toGuild != 1 || toJoiner != 1 || len(evs) != 2 {
		t.Fatalf("eventos = %+v", evs)
	}
}

func TestOfflineMemberJoinedPublishesNothingAboutHimself(t *testing.T) {
	r := newRig(t)
	r.svc.onEvent(events.Event{Type: events.GuildMemberAdd, GuildID: 300, Data: map[string]any{"user_id": "1"}})
	r.flush()
	if n := len(r.pub.all()); n != 0 {
		t.Fatalf("esperava nenhum evento, vieram %d", n)
	}
}

func TestGroupDMMakesParticipantsSeeEachOther(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "a")
	r.svc.Connect(2, "b")
	r.flush()
	before := len(r.pub.all())
	ch := channel.ChannelPayload{ID: "9", Type: int(channel.TypeGroupDM), Recipients: []channel.RecipientPayload{{ID: "1"}, {ID: "2"}, {ID: "3"}}}
	// criação: o evento vai a todos os participantes
	r.svc.onEvent(events.Event{Type: events.ChannelCreate, Topics: []string{"user:1", "user:2", "user:3"}, Data: ch})
	got := map[string]bool{}
	for _, ev := range r.pub.all()[before:] {
		p := ev.Data.(UpdatePayload)
		got[ev.Topics[0]+"<-"+p.UserID] = true
	}
	want := []string{"user:2<-1", "user:3<-1", "user:1<-2", "user:3<-2"}
	if len(got) != len(want) {
		t.Fatalf("eventos = %v", got)
	}
	for _, w := range want {
		if !got[w] {
			t.Fatalf("faltou %s em %v", w, got)
		}
	}
	// adição de um participante (3 conecta e entra depois): evento só para ele
	r.svc.Connect(3, "c")
	r.flush()
	before = len(r.pub.all())
	r.svc.onEvent(events.Event{Type: events.ChannelCreate, Topics: []string{"user:3"}, Data: ch})
	got = map[string]bool{}
	for _, ev := range r.pub.all()[before:] {
		p := ev.Data.(UpdatePayload)
		got[ev.Topics[0]+"<-"+p.UserID] = true
	}
	for _, w := range []string{"user:1<-3", "user:2<-3", "user:3<-1", "user:3<-2"} {
		if !got[w] {
			t.Fatalf("faltou %s em %v", w, got)
		}
	}
}

func TestDM1to1CreateDoesNotBroadcastPresence(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "a")
	r.flush()
	before := len(r.pub.all())
	r.svc.onEvent(events.Event{Type: events.ChannelCreate, Topics: []string{"user:1", "user:2"},
		Data: channel.ChannelPayload{ID: "9", Type: int(channel.TypeDM)}})
	r.flush()
	if len(r.pub.all()) != before {
		t.Fatal("DM 1:1 não publica presença (o par já se vê pelo servidor em comum)")
	}
}

func TestGaugesFollowTransitions(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "a")
	r.svc.Connect(2, "b")
	r.svc.SetIdle(2, "b", true)
	if r.svc.online.Load() != 1 || r.svc.idle.Load() != 1 {
		t.Fatalf("online=%d idle=%d", r.svc.online.Load(), r.svc.idle.Load())
	}
	r.svc.Disconnect(1, "a")
	r.clock.advance(15 * time.Second)
	if r.svc.online.Load() != 0 || r.svc.idle.Load() != 1 {
		t.Fatalf("online=%d idle=%d", r.svc.online.Load(), r.svc.idle.Load())
	}
}

// ---- Não perturbar, invisível e status personalizado ----

func (r *rig) updatePayloads(user string) []UpdatePayload {
	r.t.Helper()
	r.flush()
	var out []UpdatePayload
	for _, ev := range r.pub.all() {
		if p, ok := ev.Data.(UpdatePayload); ok && ev.Type == events.PresenceUpdate && p.UserID == user {
			out = append(out, p)
		}
	}
	return out
}

func ptrS(s string) *string { return &s }

func TestDNDShowsAsDNDEvenWhenIdleAndBackToOnline(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "s1")
	if _, err := r.svc.Update(context.Background(), 1, Update{StatusPref: ptrS(PrefDND)}); err != nil {
		t.Fatal(err)
	}
	r.svc.SetIdle(1, "s1", true) // ausente não muda o dnd: nenhum evento novo
	r.want("1", "online", "dnd")
	r.svc.SetIdle(1, "s1", false)
	if _, err := r.svc.Update(context.Background(), 1, Update{StatusPref: ptrS(PrefOnline)}); err != nil {
		t.Fatal(err)
	}
	r.want("1", "online", "dnd", "online")
	if r.svc.Status(1) != StatusOnline {
		t.Fatal("o status de conexão segue online (o push usa isso)")
	}
}

func TestInvisibleLooksOfflineToOthersButStaysConnected(t *testing.T) {
	r := newRig(t)
	r.store.prefs = map[int64]Prefs{1: {Pref: PrefInvisible}}
	self, err := r.svc.Self(context.Background(), 1) // o READY lê a preferência antes do Connect
	if err != nil || self.StatusPref != PrefInvisible {
		t.Fatalf("self: %+v %v", self, err)
	}
	r.svc.Connect(1, "s1")
	r.want("1") // invisível desde o primeiro instante: nunca piscou online
	if r.svc.Status(1) != StatusOnline {
		t.Fatal("a conexão segue registrada (voz e push dependem dela)")
	}
	r.store.sharing[2] = []int64{1}
	snap, _ := r.svc.Snapshot(context.Background(), 2)
	if len(snap) != 0 {
		t.Fatalf("invisível não entra no snapshot: %+v", snap)
	}
	// Ficar visível publica online; sair invisível não publica offline repetido.
	if _, err := r.svc.Update(context.Background(), 1, Update{StatusPref: ptrS(PrefOnline)}); err != nil {
		t.Fatal(err)
	}
	r.want("1", "online")
	if _, err := r.svc.Update(context.Background(), 1, Update{StatusPref: ptrS(PrefInvisible)}); err != nil {
		t.Fatal(err)
	}
	r.want("1", "online", "offline")
	r.svc.Disconnect(1, "s1")
	r.clock.advance(time.Minute)
	r.want("1", "online", "offline") // já aparecia offline
}

func TestSelfUpdateIsPublishedToOwnTopic(t *testing.T) {
	r := newRig(t)
	if _, err := r.svc.Update(context.Background(), 1, Update{StatusPref: ptrS(PrefInvisible)}); err != nil {
		t.Fatal(err)
	}
	var got *events.Event
	for _, ev := range r.pub.all() {
		if ev.Type == events.PresenceSelfUpdate {
			got = &ev
		}
	}
	if got == nil || len(got.Topics) != 1 || got.Topics[0] != "user:1" || got.Data.(SelfPayload).StatusPref != PrefInvisible {
		t.Fatalf("evento: %+v", got)
	}
}

func TestCustomStatusIsBroadcastAndExpiresOnTime(t *testing.T) {
	r := newRig(t)
	r.svc.Connect(1, "s1")
	exp := epoch.Add(30 * time.Minute)
	self, err := r.svc.Update(context.Background(), 1, Update{Custom: &CustomStatus{Text: " almoçando ", Emoji: "🍽️", ExpiresAt: &exp}})
	if err != nil || self.CustomStatus == nil || self.CustomStatus.Text != "almoçando" {
		t.Fatalf("update: %+v %v", self, err)
	}
	ups := r.updatePayloads("1")
	if len(ups) != 2 || ups[1].CustomStatus == nil || ups[1].CustomStatus.Emoji != "🍽️" || ups[1].Status != StatusOnline {
		t.Fatalf("eventos: %+v", ups)
	}
	r.store.sharing[2] = []int64{1}
	snap, _ := r.svc.Snapshot(context.Background(), 2)
	if len(snap) != 1 || snap[0].CustomStatus == nil {
		t.Fatalf("snapshot traz o status: %+v", snap)
	}
	r.clock.advance(29 * time.Minute)
	if n := len(r.updatePayloads("1")); n != 2 {
		t.Fatalf("antes do prazo nada muda (%d eventos)", n)
	}
	r.clock.advance(time.Minute) // vence
	ups = r.updatePayloads("1")
	if len(ups) != 3 || ups[2].CustomStatus != nil || ups[2].Status != StatusOnline {
		t.Fatalf("depois do prazo o status some e é publicado: %+v", ups)
	}
	snap, _ = r.svc.Snapshot(context.Background(), 2)
	if len(snap) != 1 || snap[0].CustomStatus != nil {
		t.Fatalf("snapshot sem o vencido: %+v", snap)
	}
	if cur, _ := r.svc.Self(context.Background(), 1); cur.CustomStatus != nil {
		t.Fatalf("Self ignora o vencido: %+v", cur)
	}
}

func TestExpiredCustomStatusFromDatabaseIsIgnored(t *testing.T) {
	r := newRig(t)
	old := epoch.Add(-time.Hour)
	r.store.prefs = map[int64]Prefs{1: {Pref: PrefOnline, Custom: &CustomStatus{Text: "ontem", ExpiresAt: &old}}}
	if self, _ := r.svc.Self(context.Background(), 1); self.CustomStatus != nil {
		t.Fatalf("vencido na leitura: %+v", self)
	}
	r.svc.Connect(1, "s1")
	if ups := r.updatePayloads("1"); len(ups) != 1 || ups[0].CustomStatus != nil {
		t.Fatalf("nada de status vencido no primeiro evento: %+v", ups)
	}
}

func TestUpdateValidation(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	if _, err := r.svc.Update(ctx, 1, Update{StatusPref: ptrS("away")}); !errors.Is(err, ErrInvalidPref) {
		t.Fatalf("pref: %v", err)
	}
	past, far := epoch.Add(-time.Minute), epoch.Add(49*time.Hour)
	long := make([]rune, 129)
	for i := range long {
		long[i] = 'a'
	}
	for name, c := range map[string]*CustomStatus{
		"vazio": {}, "só espaços": {Text: "  "}, "texto longo": {Text: string(long)},
		"prazo passado": {Text: "x", ExpiresAt: &past}, "prazo longe": {Text: "x", ExpiresAt: &far},
	} {
		if _, err := r.svc.Update(ctx, 1, Update{Custom: c}); !errors.Is(err, ErrInvalidCustom) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Só o emoji basta; limpar remove.
	if _, err := r.svc.Update(ctx, 1, Update{Custom: &CustomStatus{Emoji: "🎮"}}); err != nil {
		t.Fatal(err)
	}
	self, err := r.svc.Update(ctx, 1, Update{ClearCustom: true})
	if err != nil || self.CustomStatus != nil || self.StatusPref != PrefOnline {
		t.Fatalf("limpar: %+v %v", self, err)
	}
}

// Corrida READY→Connect: a pessoa fica invisível (PATCH) depois que o READY leu a preferência e antes do
// Connect da sessão. O Connect precisa usar a preferência nova, senão ela apareceria online para os outros.
func TestUpdateBetweenSelfAndConnectIsNotLost(t *testing.T) {
	r := newRig(t)
	if _, err := r.svc.Self(context.Background(), 1); err != nil { // READY: ainda online
		t.Fatal(err)
	}
	if _, err := r.svc.Update(context.Background(), 1, Update{
		StatusPref: ptrS(PrefInvisible), Custom: &CustomStatus{Text: "x"},
	}); err != nil {
		t.Fatal(err)
	}
	r.svc.Connect(1, "s1")
	r.want("1") // nunca piscou online, nem com o status personalizado
	r.store.sharing[2] = []int64{1}
	if snap, _ := r.svc.Snapshot(context.Background(), 2); len(snap) != 0 {
		t.Fatalf("invisível no snapshot: %+v", snap)
	}
}
