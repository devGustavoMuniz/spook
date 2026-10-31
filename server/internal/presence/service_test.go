package presence

import (
	"context"
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
	svc := NewService(ctx, Config{OfflineGrace: 15 * time.Second, Clock: clock, Shards: 2}, st, pub, nil)
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
