package admin

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

type fakeMedia struct {
	m   MediaSample
	err error
}

func (f fakeMedia) Fetch(context.Context) (MediaSample, error) { return f.m, f.err }

func ptr[T any](v T) *T { return &v }

func TestSampleStoresMediaAndGatewayAtTheMinute(t *testing.T) {
	st := &fakeStore{}
	c := &clock{t: time.Date(2026, 11, 3, 10, 7, 41, 0, time.UTC)}
	gw := &fakeGW{s: GatewaySample{Connections: 9, Users: 5}}
	s := NewService(Deps{Store: st, Now: c.now, Gateway: gw, Media: fakeMedia{m: MediaSample{
		Rooms: 2, Participants: 4, BytesOut: 1000, BytesIn: 500, PacketLossPct: ptr(0.5),
	}}})
	if err := s.Sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(st.samples) != 1 {
		t.Fatalf("amostras = %d", len(st.samples))
	}
	m := st.samples[0]
	if !m.TS.Equal(time.Date(2026, 11, 3, 10, 7, 0, 0, time.UTC)) || !m.Media || *m.Rooms != 2 || *m.Participants != 4 ||
		*m.BytesOut != 1000 || *m.LossPct != 0.5 || *m.OnlineUsers != 5 || *m.Connections != 9 || m.JitterMs != nil {
		t.Fatalf("amostra = %+v", m)
	}
}

func TestSampleKeepsGatewayWhenLiveKitIsDown(t *testing.T) {
	st := &fakeStore{}
	s := NewService(Deps{Store: st, Gateway: &fakeGW{s: GatewaySample{Connections: 3, Users: 2}}, Media: fakeMedia{err: errors.New("prometheus fora do ar")}})
	if err := s.Sample(context.Background()); err != nil {
		t.Fatalf("LiveKit fora do ar não é erro da amostra: %v", err)
	}
	m := st.samples[0]
	if m.Media || m.Rooms != nil || m.BytesOut != nil || *m.OnlineUsers != 2 {
		t.Fatalf("só o gateway deveria ser gravado: %+v", m)
	}
	// Sem Media configurado, idem. Falha do banco volta como erro.
	st2 := &fakeStore{insertErr: errors.New("banco")}
	if err := NewService(Deps{Store: st2}).Sample(context.Background()); err == nil {
		t.Fatal("erro ao gravar deveria subir")
	}
}

func TestPurgeSamplesLoopsInBatches(t *testing.T) {
	st := &fakeStore{purgeLeft: 12_000}
	s := NewService(Deps{Store: st})
	n, err := s.PurgeSamples(context.Background(), 35*24*time.Hour)
	if err != nil || n != 12_000 || st.purgeCalls != 3 {
		t.Fatalf("apagadas %d em %d lotes (err %v)", n, st.purgeCalls, err)
	}
}

// Retenção zerada (config ausente) não apaga nada: o corte seria "agora" e o job de início levaria as amostras novas.
func TestPurgeSamplesWithoutRetentionDeletesNothing(t *testing.T) {
	st := &fakeStore{purgeLeft: 5}
	s := NewService(Deps{Store: st})
	for _, retention := range []time.Duration{0, -time.Hour} {
		n, err := s.PurgeSamples(context.Background(), retention)
		if err != nil || n != 0 || st.purgeCalls != 0 {
			t.Fatalf("retenção %v: apagou %d em %d lotes (err %v)", retention, n, st.purgeCalls, err)
		}
	}
}

func TestLiveKitHistoryRangesBucketsAndCollecting(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 3, 10, 7, 0, 0, time.UTC)}
	st := &fakeStore{}
	s := NewService(Deps{Store: st, Now: c.now})
	ctx := context.Background()

	// Sem amostras: "coletando".
	h, err := s.LiveKitHistory(ctx, "24h")
	if err != nil || !h.Collecting || h.BucketSeconds != 300 || len(h.Points) != 0 {
		t.Fatalf("vazio = %+v %v", h, err)
	}
	for rng, want := range map[string]int{"24h": 300, "7d": 3600, "30d": 86400} {
		fresh := NewService(Deps{Store: st, Now: c.now})
		if _, err := fresh.LiveKitHistory(ctx, rng); err != nil || st.lastBucket != want {
			t.Fatalf("%s: balde %d (queria %d) err %v", rng, st.lastBucket, want, err)
		}
	}
	if _, err := s.LiveKitHistory(ctx, "1y"); apperrKind(err) != apperr.KindInvalid {
		t.Fatalf("intervalo inválido deveria ser 422: %v", err)
	}

	// Pontos: perda/jitter negativos = sem leitura; balde sem mídia não traz números do LiveKit.
	st.series = []SampleBucket{
		{Bucket: c.t.Add(-10 * time.Minute), Samples: 5, MediaSamples: 5, Participants: 4, Rooms: 1, BytesOut: 3000, PeakOutBps: 50, LossPct: 1.5, JitterMs: -1, RTTMs: 20, OnlineUsers: 7, Connections: 9},
		{Bucket: c.t.Add(-5 * time.Minute), Samples: 5, MediaSamples: 0, OnlineUsers: 8, Connections: 10},
	}
	c.add(2 * time.Minute) // vence o cache de 1 min
	h, err = s.LiveKitHistory(ctx, "24h")
	if err != nil || h.Collecting || len(h.Points) != 2 {
		t.Fatalf("pontos = %+v %v", h, err)
	}
	p := h.Points[0]
	if !p.HasMedia || p.Participants != 4 || p.BytesOutPerSec != 10 || p.PeakOutPerSec != 50 ||
		p.PacketLossPct == nil || *p.PacketLossPct != 1.5 || p.JitterMs != nil || *p.RTTMs != 20 {
		t.Fatalf("ponto 0 = %+v", p)
	}
	if q := h.Points[1]; q.HasMedia || q.Participants != 0 || q.PacketLossPct != nil {
		t.Fatalf("ponto sem mídia = %+v", q)
	}
	gh, err := s.GatewayHistory(ctx)
	if err != nil || len(gh.Points) != 2 || gh.Points[0].OnlineUsers != 7 || gh.Points[1].Connections != 10 {
		t.Fatalf("gateway = %+v %v", gh, err)
	}
}

func TestLiveKitHistoryNeverExceeds300Points(t *testing.T) {
	st := &fakeStore{}
	for i := 0; i < 500; i++ {
		st.series = append(st.series, SampleBucket{Bucket: t0.Add(time.Duration(i) * time.Minute), Samples: 1, MediaSamples: 1})
	}
	h, err := NewService(Deps{Store: st, Now: (&clock{t: t0}).now}).LiveKitHistory(context.Background(), "24h")
	if err != nil || len(h.Points) != MaxHistoryPoints {
		t.Fatalf("pontos = %d (%v)", len(h.Points), err)
	}
}

func TestHistoryIsCachedForAMinute(t *testing.T) {
	c := &clock{t: t0}
	st := &fakeStore{}
	s := NewService(Deps{Store: st, Now: c.now})
	for i := 0; i < 5; i++ {
		if _, err := s.LiveKitHistory(context.Background(), "7d"); err != nil {
			t.Fatal(err)
		}
	}
	if st.seriesCalls != 1 {
		t.Fatalf("consultas ao banco = %d, queria 1 (cache)", st.seriesCalls)
	}
	c.add(61 * time.Second)
	_, _ = s.LiveKitHistory(context.Background(), "7d")
	if st.seriesCalls != 2 {
		t.Fatalf("depois do TTL = %d", st.seriesCalls)
	}
}

func TestPlanUsagePeakMonthAndLimit(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)}
	st := &fakeStore{
		day:   Traffic{PeakOutBps: 125_000, Samples: 800},
		month: Traffic{BytesOut: 25e9, BytesIn: 5e9, Samples: 3000},
	}
	s := NewService(Deps{Store: st, Now: c.now, MonthlyTrafficLimitBytes: 100e9})
	u, err := s.LiveKitPlanUsage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if u.PeakOut24hPerSec != 125_000 || u.MonthBytesOut != 25e9 || u.MonthlyLimitBytes == nil || *u.MonthlyLimitBytes != 100e9 ||
		u.MonthPct == nil || *u.MonthPct != 25 || u.Collecting || !u.MonthStart.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("uso = %+v", u)
	}
	// Sem limite configurado os campos ficam nulos; sem amostras, "coletando".
	u, err = NewService(Deps{Store: &fakeStore{}, Now: c.now}).LiveKitPlanUsage(context.Background())
	if err != nil || u.MonthlyLimitBytes != nil || u.MonthPct != nil || !u.Collecting {
		t.Fatalf("sem limite = %+v %v", u, err)
	}
}

func TestHeatmapAndTopServersAreCachedForTenMinutes(t *testing.T) {
	c := &clock{t: t0}
	st := &fakeStore{top: []TopGuild{{ID: 5, Name: "Geral", Messages: 40, Members: 3}}}
	st.heat[0][3], st.heat[6][23] = 7, 2
	s := NewService(Deps{Store: st, Now: c.now})
	ctx := context.Background()
	h, err := s.ActivityHeatmap(ctx)
	if err != nil || len(h.Cells) != 7 || len(h.Cells[0]) != 24 || h.Cells[0][3] != 7 || h.Cells[6][23] != 2 || h.Total != 9 || h.Days != 28 {
		t.Fatalf("heatmap = %+v %v", h, err)
	}
	c.add(9 * time.Minute)
	_, _ = s.ActivityHeatmap(ctx)
	if st.heatCalls != 1 {
		t.Fatalf("dentro de 10 min deve vir do cache (chamadas %d)", st.heatCalls)
	}
	c.add(2 * time.Minute)
	_, _ = s.ActivityHeatmap(ctx)
	if st.heatCalls != 2 {
		t.Fatalf("depois de 10 min recalcula (chamadas %d)", st.heatCalls)
	}
	top, err := s.TopServers(ctx)
	if err != nil || len(top.Items) != 1 || top.Items[0].ID != "5" || top.Items[0].Messages != 40 || st.topLimit != 10 || top.Days != 7 {
		t.Fatalf("top = %+v %v", top, err)
	}
	empty, _ := NewService(Deps{Store: &fakeStore{}, Now: c.now}).TopServers(ctx)
	if empty.Items == nil {
		t.Fatal("lista vazia deve ser [] e não null")
	}
}

type fakeSizer struct {
	sizes map[string]int64
	err   map[string]error
	calls int
}

func (f *fakeSizer) PrefixSize(_ context.Context, prefix string, max int) (int64, int64, bool, error) {
	f.calls++
	if err := f.err[prefix]; err != nil {
		return 0, 0, false, err
	}
	return f.sizes[prefix], 1, max < 0, nil
}

func TestSystemDiskAndObjectBytes(t *testing.T) {
	c := &clock{t: t0}
	sz := &fakeSizer{sizes: map[string]int64{"avatars/": 100, "guild-icons/": 50, "banners/": 7}, err: map[string]error{"banners/": errors.New("s3 fora do ar")}}
	s := NewService(Deps{Store: &fakeStore{}, Now: c.now, Objects: sz, DiskPath: "/"})
	sy, err := s.System(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sy.Disk == nil || sy.Disk.TotalBytes == 0 || sy.Disk.UsedPct <= 0 || sy.Disk.UsedPct > 100 || sy.Disk.Path != "/" {
		t.Fatalf("disco = %+v", sy.Disk)
	}
	o := sy.Storage.Objects
	if o == nil || *o.AvatarsBytes != 100 || *o.IconsBytes != 50 || o.BannersBytes != nil {
		t.Fatalf("objetos = %+v (um prefixo com erro fica nulo, os demais seguem)", o)
	}
	// Cache de 10 min: o painel recarrega o sistema a cada 5 s sem listar o S3 de novo.
	c.add(10 * time.Second)
	if _, err := s.System(context.Background()); err != nil || sz.calls != 3 {
		t.Fatalf("listagens do S3 = %d, queria 3 (cache) err %v", sz.calls, err)
	}
	// Tudo indisponível = campo ausente, nunca erro.
	bad := &fakeSizer{err: map[string]error{"avatars/": errors.New("x"), "guild-icons/": errors.New("x"), "banners/": errors.New("x")}}
	sy, err = NewService(Deps{Store: &fakeStore{}, Now: c.now, Objects: bad, DiskPath: "/caminho/que/nao/existe"}).System(context.Background())
	if err != nil || sy.Storage.Objects != nil || sy.Disk != nil {
		t.Fatalf("indisponível deveria vir ausente: %+v %v", sy, err)
	}
}

func apperrKind(err error) apperr.Kind {
	if ae, ok := apperr.As(err); ok {
		return ae.Kind
	}
	return 0
}
