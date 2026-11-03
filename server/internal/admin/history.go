package admin

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// Histórico persistido do LiveKit e do gateway (adicional fora do SPEC, ver SPEC 5.5 "Adicional: voz no backend,
// histórico do admin e rate limits"). Uma amostra por minuto vai para livekit_samples; a leitura agrega por balde
// (5 min em 24 h, 1 h em 7 dias, 1 dia em 30 dias), no máximo 300 pontos, e fica em cache.
const (
	// SampleEvery é o intervalo do job de amostragem.
	SampleEvery = time.Minute
	// DefaultSamplesRetentionDays é o padrão de LIVEKIT_SAMPLES_RETENTION_DAYS.
	DefaultSamplesRetentionDays = 35
	// MaxHistoryPoints é o teto de pontos de uma série devolvida.
	MaxHistoryPoints = 300

	purgeBatch      = 5000
	historyTTL      = time.Minute
	activityTTL     = 10 * time.Minute
	heatmapDays     = 28
	topServersDays  = 7
	topServersCount = 10
	sampleTimeout   = 10 * time.Second
	// ObjectScanLimit é o teto de objetos lidos por prefixo do S3 (mais que isso: tamanho parcial).
	ObjectScanLimit = 20000
	storageTTL      = 10 * time.Minute
)

// Sample é uma amostra por minuto. Ponteiros nulos = sem leitura (LiveKit sem Prometheus).
type Sample struct {
	TS                                               time.Time
	Media                                            bool
	Rooms, Participants, TracksPublished, TracksSubs *int32
	BytesIn, BytesOut, PacketsIn, PacketsOut         *float64
	LossPct, JitterMs, RTTMs                         *float64
	OnlineUsers, Connections                         *int32
}

// SampleBucket é um balde agregado vindo do banco.
type SampleBucket struct {
	Bucket                                 time.Time
	MediaSamples, Samples                  int
	Rooms, Participants                    int
	TracksPublished, TracksSubscribed      int
	BytesOut, BytesIn, Packets, PeakOutBps float64
	LossPct, JitterMs, RTTMs               float64 // < 0 = sem leitura
	OnlineUsers, Connections               int
}

// Traffic é o tráfego somado de um intervalo.
type Traffic struct {
	BytesOut, BytesIn, PeakOutBps float64
	Samples                       int64
}

// TopGuild é uma linha do ranking de servidores.
type TopGuild struct {
	ID       int64
	Name     string
	Messages int64
	Members  int64
}

// ---- amostragem (job River `livekit_sample`) ----

type histMetrics struct {
	samples metric.Int64Counter
	purged  metric.Int64Counter
}

// Sample lê o Prometheus do LiveKit (se houver) e o gateway e grava uma amostra do minuto atual. Idempotente
// (o minuto é a chave); LiveKit fora do ar grava só as colunas do gateway.
func (s *Service) Sample(ctx context.Context) error {
	ctx, span := tracer.Start(ctx, "admin.Sample")
	defer span.End()
	smp := Sample{TS: s.now().UTC().Truncate(time.Minute)}
	if s.d.Media != nil {
		mctx, cancel := context.WithTimeout(ctx, sampleTimeout)
		m, err := s.d.Media.Fetch(mctx)
		cancel()
		if err != nil {
			slog.Warn("admin: amostra do LiveKit sem métricas", "err", err)
		} else {
			smp.Media = true
			i32 := func(f float64) *int32 { v := int32(f); return &v }
			smp.Rooms, smp.Participants = i32(m.Rooms), i32(m.Participants)
			smp.TracksPublished, smp.TracksSubs = i32(m.TracksPublished), i32(m.TracksSubs)
			smp.BytesIn, smp.BytesOut, smp.PacketsIn, smp.PacketsOut = &m.BytesIn, &m.BytesOut, &m.PacketsIn, &m.PacketsOut
			smp.LossPct, smp.JitterMs, smp.RTTMs = m.PacketLossPct, m.JitterMs, m.RTTMs
		}
	}
	if s.d.Gateway != nil {
		g := s.d.Gateway.GatewayStats()
		u, c := int32(g.Users), int32(g.Connections)
		smp.OnlineUsers, smp.Connections = &u, &c
	}
	if err := s.d.Store.InsertSample(ctx, smp); err != nil {
		return spanErr(span, err)
	}
	s.hm.samples.Add(ctx, 1, metric.WithAttributes(attribute.Bool("media", smp.Media)))
	return nil
}

// PurgeSamples apaga em lote as amostras além da retenção. Devolve quantas saíram.
func (s *Service) PurgeSamples(ctx context.Context, retention time.Duration) (int64, error) {
	ctx, span := tracer.Start(ctx, "admin.PurgeSamples")
	defer span.End()
	cutoff := s.now().Add(-retention)
	var total int64
	for {
		n, err := s.d.Store.PurgeSamples(ctx, cutoff, purgeBatch)
		if err != nil {
			return total, spanErr(span, err)
		}
		total += n
		if n < purgeBatch {
			break
		}
	}
	if total > 0 {
		s.hm.purged.Add(ctx, total)
	}
	return total, nil
}

// ---- séries ----

// RangeSpec descreve uma janela do histórico.
type RangeSpec struct {
	Name   string
	Window time.Duration
	Bucket time.Duration
}

// Ranges são as janelas aceitas por GET /api/admin/livekit/history.
var Ranges = map[string]RangeSpec{
	"24h": {"24h", 24 * time.Hour, 5 * time.Minute},
	"7d":  {"7d", 7 * 24 * time.Hour, time.Hour},
	"30d": {"30d", 30 * 24 * time.Hour, 24 * time.Hour},
}

// HistoryPoint é um ponto (balde) da série. Tráfego em bytes dentro do balde; *_per_sec é a média do balde.
type HistoryPoint struct {
	TS               time.Time `json:"ts" doc:"Início do balde (UTC)"`
	Rooms            int       `json:"rooms" doc:"Salas (máximo do balde)"`
	Participants     int       `json:"participants" doc:"Participantes (máximo do balde)"`
	TracksPublished  int       `json:"tracks_published"`
	TracksSubscribed int       `json:"tracks_subscribed"`
	BytesOut         float64   `json:"bytes_out" doc:"Tráfego de saída no balde"`
	BytesIn          float64   `json:"bytes_in" doc:"Tráfego de entrada no balde"`
	BytesOutPerSec   float64   `json:"bytes_out_per_sec" doc:"Média do balde"`
	PeakOutPerSec    float64   `json:"peak_out_per_sec" doc:"Maior ritmo de saída entre duas amostras do balde"`
	PacketsPerSec    float64   `json:"packets_per_sec"`
	PacketLossPct    *float64  `json:"packet_loss_pct" nullable:"true" doc:"Pior perda do balde"`
	JitterMs         *float64  `json:"jitter_ms" nullable:"true" doc:"Média do balde"`
	RTTMs            *float64  `json:"rtt_ms" nullable:"true" doc:"Média do balde"`
	HasMedia         bool      `json:"has_media" doc:"Falso se o Prometheus do LiveKit não respondeu em nenhuma amostra do balde"`
}

// LiveKitHistory é a resposta de GET /api/admin/livekit/history.
type LiveKitHistory struct {
	GeneratedAt   time.Time      `json:"generated_at"`
	Range         string         `json:"range" enum:"24h,7d,30d"`
	BucketSeconds int            `json:"bucket_seconds"`
	Collecting    bool           `json:"collecting" doc:"Verdadeiro enquanto há menos de 2 amostras: o histórico ainda está acumulando"`
	Points        []HistoryPoint `json:"points" maxItems:"300"`
}

type histData struct {
	buckets []SampleBucket
}

func (s *Service) sampleSeries(ctx context.Context, rng string) ([]SampleBucket, RangeSpec, error) {
	spec, ok := Ranges[rng]
	if !ok {
		return nil, spec, apperr.Invalid("intervalo inválido (use 24h, 7d ou 30d)")
	}
	c := s.histCells[rng]
	d, _, err := c.get(ctx, s.now, func(ctx context.Context) (histData, error) {
		// O balde é alinhado ao relógio (date_bin a partir de 2000-01-01); a janela começa num balde cheio.
		since := s.now().Add(-spec.Window).UTC().Truncate(spec.Bucket)
		b, err := s.d.Store.SampleSeries(ctx, since, int(spec.Bucket/time.Second))
		return histData{b}, err
	})
	return d.buckets, spec, err
}

// LiveKitHistory devolve a série reduzida (cache de 1 min por janela).
func (s *Service) LiveKitHistory(ctx context.Context, rng string) (LiveKitHistory, error) {
	ctx, span := tracer.Start(ctx, "admin.LiveKitHistory", trace.WithAttributes(attribute.String("range", rng)))
	defer span.End()
	buckets, spec, err := s.sampleSeries(ctx, rng)
	if err != nil {
		return LiveKitHistory{}, spanErr(span, err)
	}
	out := LiveKitHistory{GeneratedAt: s.now(), Range: spec.Name, BucketSeconds: int(spec.Bucket / time.Second), Points: []HistoryPoint{}}
	secs := spec.Bucket.Seconds()
	total := 0
	for _, b := range buckets {
		total += b.Samples
		p := HistoryPoint{TS: b.Bucket.UTC(), HasMedia: b.MediaSamples > 0}
		if p.HasMedia {
			p.Rooms, p.Participants = b.Rooms, b.Participants
			p.TracksPublished, p.TracksSubscribed = b.TracksPublished, b.TracksSubscribed
			p.BytesOut, p.BytesIn = b.BytesOut, b.BytesIn
			p.BytesOutPerSec, p.PeakOutPerSec, p.PacketsPerSec = b.BytesOut/secs, b.PeakOutBps, b.Packets/secs
			p.PacketLossPct, p.JitterMs, p.RTTMs = nonNeg(b.LossPct), nonNeg(b.JitterMs), nonNeg(b.RTTMs)
		}
		out.Points = append(out.Points, p)
	}
	if len(out.Points) > MaxHistoryPoints { // defesa: nunca devolve mais que o teto
		out.Points = out.Points[len(out.Points)-MaxHistoryPoints:]
	}
	out.Collecting = total < 2
	return out, nil
}

func nonNeg(v float64) *float64 {
	if v < 0 || math.IsNaN(v) {
		return nil
	}
	return &v
}

// GatewayPoint é um ponto do histórico do gateway.
type GatewayPoint struct {
	TS          time.Time `json:"ts"`
	OnlineUsers int       `json:"online_users" doc:"Máximo do balde"`
	Connections int       `json:"connections" doc:"Máximo do balde"`
}

// GatewayHistory é a resposta de GET /api/admin/gateway/history (24 h, baldes de 5 min).
type GatewayHistory struct {
	GeneratedAt   time.Time      `json:"generated_at"`
	BucketSeconds int            `json:"bucket_seconds"`
	Collecting    bool           `json:"collecting"`
	Points        []GatewayPoint `json:"points" maxItems:"300"`
}

// GatewayHistory devolve usuários online e conexões das últimas 24 h (mesma série de 5 min do LiveKit, cache de 1 min).
func (s *Service) GatewayHistory(ctx context.Context) (GatewayHistory, error) {
	ctx, span := tracer.Start(ctx, "admin.GatewayHistory")
	defer span.End()
	buckets, spec, err := s.sampleSeries(ctx, "24h")
	if err != nil {
		return GatewayHistory{}, spanErr(span, err)
	}
	out := GatewayHistory{GeneratedAt: s.now(), BucketSeconds: int(spec.Bucket / time.Second), Points: []GatewayPoint{}}
	total := 0
	for _, b := range buckets {
		total += b.Samples
		out.Points = append(out.Points, GatewayPoint{TS: b.Bucket.UTC(), OnlineUsers: b.OnlineUsers, Connections: b.Connections})
	}
	out.Collecting = total < 2
	return out, nil
}

// ---- uso e capacidade ----

// LiveKitPlan é a resposta de GET /api/admin/livekit/usage.
type LiveKitPlan struct {
	GeneratedAt       time.Time `json:"generated_at"`
	Collecting        bool      `json:"collecting" doc:"Ainda sem amostras suficientes"`
	PeakOut24hPerSec  float64   `json:"peak_out_24h_per_sec" doc:"Maior ritmo de saída (bytes/s) entre duas amostras nas últimas 24 h"`
	MonthStart        time.Time `json:"month_start" doc:"Primeiro instante do mês corrente (UTC)"`
	MonthBytesOut     float64   `json:"month_bytes_out" doc:"Tráfego de saída do mês corrente (soma de deltas, tolera reinício do contador)"`
	MonthBytesIn      float64   `json:"month_bytes_in"`
	MonthlyLimitBytes *int64    `json:"monthly_limit_bytes" nullable:"true" doc:"Limite do plano (LIVEKIT_MONTHLY_TRAFFIC_GB); nulo se não configurado"`
	MonthPct          *float64  `json:"month_pct" nullable:"true" doc:"Percentual do limite já usado (tráfego de saída)"`
}

// LiveKitUsage devolve pico de saída em 24 h e tráfego do mês (cache de 1 min).
func (s *Service) LiveKitPlanUsage(ctx context.Context) (LiveKitPlan, error) {
	ctx, span := tracer.Start(ctx, "admin.LiveKitPlanUsage")
	defer span.End()
	v, _, err := s.planCell.get(ctx, s.now, func(ctx context.Context) (LiveKitPlan, error) {
		now := s.now().UTC()
		monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		day, err := s.d.Store.SampleTraffic(ctx, now.Add(-24*time.Hour))
		if err != nil {
			return LiveKitPlan{}, err
		}
		month, err := s.d.Store.SampleTraffic(ctx, monthStart)
		if err != nil {
			return LiveKitPlan{}, err
		}
		p := LiveKitPlan{
			GeneratedAt: now, Collecting: month.Samples < 2, PeakOut24hPerSec: day.PeakOutBps,
			MonthStart: monthStart, MonthBytesOut: month.BytesOut, MonthBytesIn: month.BytesIn,
		}
		if lim := s.d.MonthlyTrafficLimitBytes; lim > 0 {
			l := lim
			p.MonthlyLimitBytes = &l
			pct := month.BytesOut / float64(lim) * 100
			p.MonthPct = &pct
		}
		return p, nil
	})
	return v, spanErr(span, err)
}

// ---- atividade ----

// ActivityHeatmap é a resposta de GET /api/admin/activity/heatmap.
type ActivityHeatmap struct {
	GeneratedAt time.Time `json:"generated_at"`
	Days        int       `json:"days" doc:"Janela em dias (28)"`
	Total       int64     `json:"total"`
	Cells       [][]int64 `json:"cells" doc:"Mensagens por dia da semana (0 = domingo … 6 = sábado, UTC) e hora (0 a 23, UTC)"`
}

// ActivityHeatmap conta as mensagens dos últimos 28 dias por dia da semana e hora UTC (cache de 10 min).
func (s *Service) ActivityHeatmap(ctx context.Context) (ActivityHeatmap, error) {
	ctx, span := tracer.Start(ctx, "admin.ActivityHeatmap")
	defer span.End()
	v, _, err := s.heatCell.get(ctx, s.now, func(ctx context.Context) (ActivityHeatmap, error) {
		now := s.now().UTC()
		m, err := s.d.Store.MessageHeatmap(ctx, now.AddDate(0, 0, -heatmapDays))
		if err != nil {
			return ActivityHeatmap{}, err
		}
		h := ActivityHeatmap{GeneratedAt: now, Days: heatmapDays, Cells: make([][]int64, 7)}
		for d := range m {
			h.Cells[d] = make([]int64, 24)
			for hr, n := range m[d] {
				h.Cells[d][hr] = n
				h.Total += n
			}
		}
		return h, nil
	})
	return v, spanErr(span, err)
}

// TopServerRow é uma linha do ranking.
type TopServerRow struct {
	ID       string `json:"id" doc:"ID Snowflake (string)"`
	Name     string `json:"name"`
	Messages int64  `json:"messages" doc:"Mensagens nos últimos 7 dias"`
	Members  int64  `json:"members"`
}

// TopServers é a resposta de GET /api/admin/servers/top.
type TopServers struct {
	GeneratedAt time.Time      `json:"generated_at"`
	Days        int            `json:"days"`
	Items       []TopServerRow `json:"items" maxItems:"10"`
}

// TopServers devolve os 10 servidores com mais mensagens em 7 dias (cache de 10 min).
func (s *Service) TopServers(ctx context.Context) (TopServers, error) {
	ctx, span := tracer.Start(ctx, "admin.TopServers")
	defer span.End()
	v, _, err := s.topCell.get(ctx, s.now, func(ctx context.Context) (TopServers, error) {
		now := s.now().UTC()
		rows, err := s.d.Store.TopGuilds(ctx, now.AddDate(0, 0, -topServersDays), topServersCount)
		if err != nil {
			return TopServers{}, err
		}
		t := TopServers{GeneratedAt: now, Days: topServersDays, Items: []TopServerRow{}}
		for _, r := range rows {
			t.Items = append(t.Items, TopServerRow{ID: fmt.Sprint(r.ID), Name: r.Name, Messages: r.Messages, Members: r.Members})
		}
		return t, nil
	})
	return v, spanErr(span, err)
}

func newHistMetrics() *histMetrics {
	m := otel.Meter("spook/admin")
	h := &histMetrics{}
	h.samples, _ = m.Int64Counter("spook.admin.livekit_samples", metric.WithDescription("Amostras por minuto gravadas (media = LiveKit respondeu)"))
	h.purged, _ = m.Int64Counter("spook.admin.livekit_samples.purged", metric.WithDescription("Amostras apagadas pela retenção"))
	return h
}
