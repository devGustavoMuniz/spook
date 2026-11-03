package admin

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeStore struct {
	admins      map[int64]bool
	countsCalls atomic.Int32
	perDay      map[string]int64
	rooms       map[int64]ChannelInfo
	names       map[int64]string
	lastQuery   ListQuery

	mu          sync.Mutex
	samples     []Sample
	insertErr   error
	purgeLeft   int64
	purgeCalls  int
	series      []SampleBucket
	seriesCalls int
	lastBucket  int
	lastSince   time.Time
	month, day  Traffic
	heat        [7][24]int64
	heatCalls   int
	top         []TopGuild
	topLimit    int
}

func (f *fakeStore) IsAdmin(_ context.Context, id int64) (bool, error) { return f.admins[id], nil }
func (f *fakeStore) Promote(_ context.Context, names []string) ([]string, error) {
	return names, nil
}
func (f *fakeStore) Counts(context.Context, time.Time) (Counts, error) {
	f.countsCalls.Add(1)
	time.Sleep(20 * time.Millisecond) // deixa chamadas simultâneas se juntarem
	return Counts{UsersTotal: 110, UsersNew7d: 10, Attachments: 3, AttachmentBytes: 3000}, nil
}
func (f *fakeStore) MessageTotals(context.Context) (MessageTotals, error) {
	return MessageTotals{Total: 50, InGuilds: 40, InDMs: 10}, nil
}
func (f *fakeStore) UsersPerDay(context.Context, time.Time) (map[string]int64, error) {
	return f.perDay, nil
}
func (f *fakeStore) MessagesPerDay(context.Context, time.Time) (map[string]int64, error) {
	return map[string]int64{}, nil
}
func (f *fakeStore) DatabaseSize(context.Context) (int64, error) { return 1 << 20, nil }
func (f *fakeStore) LargestTables(context.Context) ([]TableSize, error) {
	return []TableSize{{Name: "messages", Bytes: 10}}, nil
}
func (f *fakeStore) Users(_ context.Context, q ListQuery) (UserPage, error) {
	f.lastQuery = q
	return UserPage{}, nil
}
func (f *fakeStore) Servers(_ context.Context, q ListQuery) (ServerPage, error) {
	f.lastQuery = q
	return ServerPage{}, nil
}
func (f *fakeStore) Channels(context.Context, []int64) (map[int64]ChannelInfo, error) {
	return f.rooms, nil
}
func (f *fakeStore) Usernames(context.Context, []int64) (map[int64]string, error) {
	return f.names, nil
}
func (f *fakeStore) JobCounts(context.Context) (JobCounts, bool, error) {
	return JobCounts{Available: 2, Discarded: 1}, true, nil
}

// ---- histórico (livekit_samples) ----

func (f *fakeStore) InsertSample(_ context.Context, m Sample) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.insertErr != nil {
		return f.insertErr
	}
	f.samples = append(f.samples, m)
	return nil
}
func (f *fakeStore) PurgeSamples(_ context.Context, _ time.Time, batch int) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.purgeCalls++
	n := f.purgeLeft
	if n > int64(batch) {
		n = int64(batch)
	}
	f.purgeLeft -= n
	return n, nil
}
func (f *fakeStore) SampleSeries(_ context.Context, since time.Time, bucket int) ([]SampleBucket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seriesCalls++
	f.lastBucket, f.lastSince = bucket, since
	return f.series, nil
}
func (f *fakeStore) SampleTraffic(_ context.Context, since time.Time) (Traffic, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if since.Day() == 1 && since.Hour() == 0 { // consulta do mês corrente
		return f.month, nil
	}
	return f.day, nil
}
func (f *fakeStore) MessageHeatmap(context.Context, time.Time) ([7][24]int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.heatCalls++
	return f.heat, nil
}
func (f *fakeStore) TopGuilds(_ context.Context, _ time.Time, limit int) ([]TopGuild, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.topLimit = limit
	return f.top, nil
}

type fakeCalls struct {
	rooms []LiveRoom
	err   error
	n     atomic.Int32
}

func (f *fakeCalls) LiveRooms(context.Context) ([]LiveRoom, error) {
	f.n.Add(1)
	return f.rooms, f.err
}

type fakeGW struct {
	mu sync.Mutex
	s  GatewaySample
}

func (f *fakeGW) GatewayStats() GatewaySample {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.s
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

var t0 = time.Date(2026, 10, 31, 15, 30, 0, 0, time.UTC)

func TestIsAdmin(t *testing.T) {
	s := NewService(Deps{Store: &fakeStore{admins: map[int64]bool{1: true}}})
	for id, want := range map[int64]bool{0: false, 1: true, 2: false} {
		if got, err := s.IsAdmin(context.Background(), id); err != nil || got != want {
			t.Fatalf("IsAdmin(%d) = %v, %v", id, got, err)
		}
	}
}

func TestOverviewSeriesFillsEmptyDaysAndCompares(t *testing.T) {
	// 14 dias terminando em 2026-10-31: 10-18 .. 10-31. Só alguns dias têm dado.
	per := map[string]int64{
		"2026-10-19": 2, "2026-10-20": 2, // anteriores: 10-19..10-24
		"2026-10-25": 6, "2026-10-26": 6, // 6 recentes: 10-25..10-30
		"2026-10-31": 100, // hoje: fora da comparação
	}
	st := &fakeStore{perDay: per}
	c := &clock{t: t0}
	s := NewService(Deps{Store: st, Now: c.now})
	o, err := s.Overview(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(o.NewUsersPerDay) != 14 || o.NewUsersPerDay[0].Date != "2026-10-18" || o.NewUsersPerDay[13].Date != "2026-10-31" {
		t.Fatalf("série = %+v", o.NewUsersPerDay)
	}
	if o.NewUsersPerDay[1].Count != 2 || o.NewUsersPerDay[3].Count != 0 || o.NewUsersPerDay[13].Count != 100 {
		t.Fatalf("dias vazios devem valer 0: %+v", o.NewUsersPerDay)
	}
	tr := o.NewUsersTrend
	if tr.Recent != 12 || tr.Previous != 4 || tr.ChangePct == nil || *tr.ChangePct != 200 {
		t.Fatalf("comparação = %+v", tr)
	}
	if o.MessagesTrend.ChangePct != nil || o.MessagesTrend.Recent != 0 {
		t.Fatalf("sem período anterior a variação é nula: %+v", o.MessagesTrend)
	}
	if o.Users.Total != 110 || o.Users.GrowthPct == nil || *o.Users.GrowthPct != 10 {
		t.Fatalf("usuários = %+v", o.Users)
	}
	if o.Messages.Total != 50 || o.Messages.InGuilds != 40 {
		t.Fatalf("mensagens = %+v", o.Messages)
	}
}

func TestCacheJoinsConcurrentCallsAndExpires(t *testing.T) {
	st := &fakeStore{perDay: map[string]int64{}}
	c := &clock{t: t0}
	s := NewService(Deps{Store: st, Now: c.now})
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Overview(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if n := st.countsCalls.Load(); n != 1 {
		t.Fatalf("20 chamadas simultâneas devem gerar 1 consulta, geraram %d", n)
	}
	_, _ = s.Overview(context.Background())
	c.add(10 * time.Second)
	_, _ = s.Overview(context.Background())
	if n := st.countsCalls.Load(); n != 1 {
		t.Fatalf("dentro do TTL não consulta de novo: %d", n)
	}
	c.add(31 * time.Second)
	_, _ = s.Overview(context.Background())
	if n := st.countsCalls.Load(); n != 2 {
		t.Fatalf("depois do TTL consulta de novo: %d", n)
	}
}

func TestCallsFilterAndSummary(t *testing.T) {
	calls := &fakeCalls{rooms: []LiveRoom{
		{ChannelID: 10, Since: t0.Add(-90 * time.Second), Participants: []LiveParticipant{{UserID: 1, Camera: true}, {UserID: 2, Screen: true}}},
		{ChannelID: 20, Participants: []LiveParticipant{{UserID: 3}}},
	}}
	st := &fakeStore{
		rooms: map[int64]ChannelInfo{10: {Name: "geral", GuildName: "Casa"}, 20: {DM: true}},
		names: map[int64]string{1: "ana", 2: "beto", 3: "carla"},
	}
	c := &clock{t: t0}
	s := NewService(Deps{Store: st, Calls: calls, Now: c.now})
	got, err := s.Calls(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Summary.Ongoing != 2 || got.Summary.People != 3 || got.Summary.Cameras != 1 || got.Summary.Screens != 1 || !got.Summary.Available {
		t.Fatalf("resumo = %+v", got.Summary)
	}
	if len(got.Rooms) != 2 || got.Rooms[0].Server != "Casa" || got.Rooms[0].DurationSeconds != 90 || got.Rooms[1].Channel != "Conversa direta" {
		t.Fatalf("salas = %+v", got.Rooms)
	}
	got, _ = s.Calls(context.Background(), "BETO")
	if len(got.Rooms) != 1 || got.Rooms[0].ChannelID != "10" {
		t.Fatalf("filtro por pessoa: %+v", got.Rooms)
	}
	got, _ = s.Calls(context.Background(), "casa")
	if len(got.Rooms) != 1 {
		t.Fatalf("filtro por servidor: %+v", got.Rooms)
	}
	if n := calls.n.Load(); n != 1 {
		t.Fatalf("LiveKit deve ser lido 1 vez dentro do TTL de 5 s, foi %d", n)
	}
}

func TestCallsDisabledAndError(t *testing.T) {
	s := NewService(Deps{Store: &fakeStore{}, Calls: &fakeCalls{err: ErrCallsDisabled}})
	l, err := s.Live(context.Background())
	if err != nil || l.Calls.Available || !strings.Contains(l.Calls.Reason, "desligada") {
		t.Fatalf("voz desligada: %+v err=%v", l.Calls, err)
	}
	if l.LiveKit.Available || l.LiveKit.Reason == "" {
		t.Fatalf("sem Prometheus deve explicar: %+v", l.LiveKit)
	}
	s = NewService(Deps{Store: &fakeStore{}, Calls: &fakeCalls{err: errors.New("boom secreto")}})
	l, _ = s.Live(context.Background())
	if l.Calls.Available || strings.Contains(l.Calls.Reason, "boom") {
		t.Fatalf("erro não vaza detalhes: %+v", l.Calls)
	}
}

func TestSystemGatewayRateAndJobs(t *testing.T) {
	gw := &fakeGW{s: GatewaySample{Connections: 3, Sessions: 4, Users: 2, EventsTotal: 100}}
	c := &clock{t: t0}
	s := NewService(Deps{Store: &fakeStore{}, Gateway: gw, Now: c.now, Env: "test"})
	a, err := s.System(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if a.Gateway.EventsPerSecond != 0 || a.Gateway.OnlineUsers != 2 || !a.Jobs.Available || a.Jobs.Pending != 2 || a.Jobs.Failed != 1 {
		t.Fatalf("sistema = %+v %+v", a.Gateway, a.Jobs)
	}
	if a.App.Goroutines < 1 || a.App.GoVersion == "" || a.App.Environment != "test" || a.Database.SizeBytes != 1<<20 || a.Storage.AttachmentBytes != 3000 {
		t.Fatalf("app = %+v", a)
	}
	gw.mu.Lock()
	gw.s.EventsTotal = 150
	gw.mu.Unlock()
	c.add(10 * time.Second)
	b, _ := s.System(context.Background())
	if b.Gateway.EventsPerSecond != 5 {
		t.Fatalf("eventos/s = %v", b.Gateway.EventsPerSecond)
	}
}

func TestListQueryNormalization(t *testing.T) {
	st := &fakeStore{}
	s := NewService(Deps{Store: st})
	if _, _, err := s.Users(context.Background(), ListQuery{Sort: "password_hash"}); err == nil {
		t.Fatal("coluna fora da lista deve ser recusada")
	}
	if _, q, err := s.Users(context.Background(), ListQuery{Page: 3}); err != nil || q.Sort != "created_at" || !q.Desc || q.PageOffset != 50 || q.PageSize != 25 {
		t.Fatalf("padrões: %+v err=%v", q, err)
	}
	if _, _, err := s.Servers(context.Background(), ListQuery{Sort: "email"}); err == nil {
		t.Fatal("email não é coluna de servidores")
	}
	if _, _, err := s.Users(context.Background(), ListQuery{Q: strings.Repeat("a", 101)}); err == nil {
		t.Fatal("busca longa demais")
	}
}

func TestParseMedia(t *testing.T) {
	const txt = `# HELP livekit_room_total rooms
livekit_room_total 2
livekit_participant_total 5
livekit_track_published_total{kind="audio"} 4
livekit_track_published_total{kind="video"} 2
livekit_track_subscribed_total{kind="audio"} 8
livekit_packet_bytes{direction="incoming",type="rtp"} 1000
livekit_packet_bytes{direction="outgoing",type="rtp"} 3000
livekit_packet_total{direction="incoming",type="rtp"} 90
livekit_packet_total{direction="outgoing",type="rtp"} 10
livekit_packet_loss_total{direction="incoming"} 25
livekit_jitter_us_sum 4000
livekit_jitter_us_count 4
livekit_rtt_ms_sum 60
livekit_rtt_ms_count 3
`
	m, err := ParseMedia(strings.NewReader(txt))
	if err != nil {
		t.Fatal(err)
	}
	if m.Rooms != 2 || m.Participants != 5 || m.TracksPublished != 6 || m.TracksSubs != 8 || m.BytesIn != 1000 || m.BytesOut != 3000 {
		t.Fatalf("contagens = %+v", m)
	}
	if m.PacketLossPct == nil || *m.PacketLossPct != 20 || m.JitterMs == nil || *m.JitterMs != 1 || m.RTTMs == nil || *m.RTTMs != 20 {
		t.Fatalf("saúde = loss %v jitter %v rtt %v", m.PacketLossPct, m.JitterMs, m.RTTMs)
	}
	if m.QualityScore != nil {
		t.Fatal("métrica ausente deve ficar nula")
	}
}

func TestParseMediaIdleLiveKit(t *testing.T) {
	// LiveKit 1.13 sem tráfego: só estes contadores existem; nada vira zero falso nas métricas de qualidade.
	const txt = `livekit_node_packet_total{node_id="N",node_type="SERVER",type="dropped"} 0
livekit_node_packet_total{node_id="N",node_type="SERVER",type="out"} 12
livekit_participant_total{node_id="N",node_type="SERVER"} 0
livekit_quality_score_sum{node_id="N",node_type="SERVER"} 0
livekit_quality_score_count{node_id="N",node_type="SERVER"} 0
`
	m, err := ParseMedia(strings.NewReader(txt))
	if err != nil {
		t.Fatal(err)
	}
	if m.PacketsOut != 12 || m.QualityScore != nil || m.JitterMs != nil || m.PacketLossPct != nil {
		t.Fatalf("m = %+v", m)
	}
}
