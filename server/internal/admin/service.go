package admin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

var tracer = otel.Tracer("spook/admin")

// TTLs do cache (ver SPEC 5.5): o que varre tabelas fica 30 s; o que é barato ou "ao vivo", 5 s.
const (
	heavyTTL = 30 * time.Second
	liveTTL  = 5 * time.Second
	dbTTL    = 60 * time.Second // tamanho do banco e das tabelas
)

// Deps agrupa as dependências do service. Qualquer porta opcional pode ser nula.
type Deps struct {
	Store   Store
	Calls   CallSource   // nulo = voz indisponível
	Gateway GatewayStats // nulo = sem dados do gateway
	Pool    PoolStats
	Media   MediaMetrics // nulo = Prometheus do LiveKit não configurado
	// Env, Version e Commit aparecem no bloco "Aplicação". Version/Commit vazios usam o build info do Go.
	Env, Version, Commit string
	Now                  func() time.Time // relógio (testes)
}

type Service struct {
	d       Deps
	now     func() time.Time
	started time.Time

	counts   cell[Counts]
	totals   cell[MessageTotals]
	series   cell[seriesData]
	dbInfo   cell[dbData]
	rooms    cell[[]roomView]
	livekit  cell[LiveKitUsage]
	system   cell[System]
	overview cell[Overview]

	mu     sync.Mutex // amostras anteriores (taxas por segundo)
	prevGW *gwPoint
	prevLK *lkPoint
}

type gwPoint struct {
	at     time.Time
	events int64
}

type lkPoint struct {
	at          time.Time
	in, out     float64
	pkIn, pkOut float64
}

func NewService(d Deps) *Service {
	now := d.Now
	if now == nil {
		now = time.Now
	}
	s := &Service{d: d, now: now, started: now()}
	s.counts.ttl, s.totals.ttl, s.series.ttl = heavyTTL, heavyTTL, heavyTTL
	s.dbInfo.ttl = dbTTL
	s.rooms.ttl, s.livekit.ttl, s.system.ttl = liveTTL, liveTTL, liveTTL
	s.overview.ttl = heavyTTL
	return s
}

// ---- acesso ----

// IsAdmin diz se o usuário é administrador. Lê do banco a cada chamada: rebaixar alguém vale na hora.
func (s *Service) IsAdmin(ctx context.Context, userID int64) (bool, error) {
	if userID == 0 {
		return false, nil
	}
	return s.d.Store.IsAdmin(ctx, userID)
}

// Bootstrap promove os usernames (idempotente) e devolve quem foi promovido agora. Nunca rebaixa.
func (s *Service) Bootstrap(ctx context.Context, usernames []string) ([]string, error) {
	if len(usernames) == 0 {
		return nil, nil
	}
	got, err := s.d.Store.Promote(ctx, usernames)
	if err != nil {
		return nil, fmt.Errorf("promover administradores: %w", err)
	}
	if len(got) > 0 {
		slog.Info("admin: usuários promovidos por ADMIN_USERNAMES", "usernames", got)
	}
	return got, nil
}

// ---- visão geral ----

type Comparison struct {
	Recent    int64    `json:"recent" doc:"Soma dos últimos 6 dias completos (sem hoje)"`
	Previous  int64    `json:"previous" doc:"Soma dos 6 dias completos anteriores a esses"`
	ChangePct *float64 `json:"change_pct" nullable:"true" doc:"Variação percentual; nulo se o período anterior foi zero"`
}

type DayCount struct {
	Date  string `json:"date" doc:"Dia em UTC (AAAA-MM-DD)"`
	Count int64  `json:"count"`
}

type Overview struct {
	GeneratedAt time.Time `json:"generated_at" doc:"Quando o cache foi calculado"`
	Users       struct {
		Total     int64    `json:"total"`
		New24h    int64    `json:"new_24h"`
		New7d     int64    `json:"new_7d"`
		GrowthPct *float64 `json:"growth_pct" nullable:"true" doc:"Contas novas em 7 dias sobre as que existiam antes"`
	} `json:"users"`
	Accounts struct {
		Registered int64 `json:"registered"`
		Admins     int64 `json:"admins"`
		WithAvatar int64 `json:"with_avatar"`
	} `json:"accounts"`
	Servers struct {
		Total         int64 `json:"total"`
		Memberships   int64 `json:"memberships"`
		TextChannels  int64 `json:"text_channels"`
		VoiceChannels int64 `json:"voice_channels"`
		Categories    int64 `json:"categories"`
		Roles         int64 `json:"roles"`
		ActiveInvites int64 `json:"active_invites"`
		InviteUses    int64 `json:"invite_uses"`
		WithIcon      int64 `json:"with_icon"`
	} `json:"servers"`
	Messages struct {
		Total    int64 `json:"total"`
		Last24h  int64 `json:"last_24h"`
		Last7d   int64 `json:"last_7d"`
		InGuilds int64 `json:"in_guilds"`
		InDMs    int64 `json:"in_dms"`
	} `json:"messages"`
	Attachments struct {
		Count int64 `json:"count"`
		Bytes int64 `json:"bytes"`
	} `json:"attachments"`
	Conversations struct {
		Direct int64 `json:"direct"`
		Groups int64 `json:"groups"`
	} `json:"conversations"`
	NewUsersPerDay []DayCount `json:"new_users_per_day"`
	MessagesPerDay []DayCount `json:"messages_per_day"`
	NewUsersTrend  Comparison `json:"new_users_trend"`
	MessagesTrend  Comparison `json:"messages_trend"`
}

type seriesData struct{ users, messages []DayCount }

// Overview reúne contagens e séries (cache de 30 s).
func (s *Service) Overview(ctx context.Context) (Overview, error) {
	ctx, span := tracer.Start(ctx, "admin.Overview")
	defer span.End()
	v, _, err := s.overview.get(ctx, s.now, s.loadOverview)
	return v, spanErr(span, err)
}

func (s *Service) loadOverview(ctx context.Context) (Overview, error) {
	c, _, err := s.counts.get(ctx, s.now, s.loadCounts)
	if err != nil {
		return Overview{}, err
	}
	t, _, err := s.totals.get(ctx, s.now, func(ctx context.Context) (MessageTotals, error) { return s.d.Store.MessageTotals(ctx) })
	if err != nil {
		return Overview{}, err
	}
	ser, _, err := s.series.get(ctx, s.now, s.loadSeries)
	if err != nil {
		return Overview{}, err
	}
	var o Overview
	o.GeneratedAt = s.now()
	o.Users.Total, o.Users.New24h, o.Users.New7d = c.UsersTotal, c.UsersNew24h, c.UsersNew7d
	if before := c.UsersTotal - c.UsersNew7d; before > 0 {
		p := float64(c.UsersNew7d) / float64(before) * 100
		o.Users.GrowthPct = &p
	}
	o.Accounts.Registered, o.Accounts.Admins, o.Accounts.WithAvatar = c.UsersTotal, c.Admins, c.Avatars
	o.Servers.Total, o.Servers.Memberships = c.GuildsTotal, c.Memberships
	o.Servers.TextChannels, o.Servers.VoiceChannels, o.Servers.Categories = c.TextChannels, c.VoiceChannels, c.Categories
	o.Servers.Roles, o.Servers.ActiveInvites, o.Servers.InviteUses, o.Servers.WithIcon = c.Roles, c.InvitesActive, c.InviteUses, c.GuildIcons
	o.Messages.Total, o.Messages.InGuilds, o.Messages.InDMs = t.Total, t.InGuilds, t.InDMs
	o.Messages.Last24h, o.Messages.Last7d = c.Messages24h, c.Messages7d
	o.Attachments.Count, o.Attachments.Bytes = c.Attachments, c.AttachmentBytes
	o.Conversations.Direct, o.Conversations.Groups = c.DirectChats, c.GroupChats
	o.NewUsersPerDay, o.MessagesPerDay = ser.users, ser.messages
	o.NewUsersTrend, o.MessagesTrend = compare(ser.users), compare(ser.messages)
	return o, nil
}

func (s *Service) loadCounts(ctx context.Context) (Counts, error) {
	return s.d.Store.Counts(ctx, s.now())
}

func (s *Service) loadSeries(ctx context.Context) (seriesData, error) {
	days := lastDays(s.now(), SeriesDays)
	since, _ := time.Parse("2006-01-02", days[0])
	u, err := s.d.Store.UsersPerDay(ctx, since)
	if err != nil {
		return seriesData{}, err
	}
	m, err := s.d.Store.MessagesPerDay(ctx, since)
	if err != nil {
		return seriesData{}, err
	}
	return seriesData{users: fill(days, u), messages: fill(days, m)}, nil
}

// lastDays devolve os n dias UTC terminando em hoje (AAAA-MM-DD, em ordem crescente).
func lastDays(now time.Time, n int) []string {
	d := now.UTC().Truncate(24 * time.Hour)
	out := make([]string, n)
	for i := 0; i < n; i++ {
		out[i] = d.AddDate(0, 0, i-(n-1)).Format("2006-01-02")
	}
	return out
}

// fill monta a série completa: dia sem dado = 0.
func fill(days []string, by map[string]int64) []DayCount {
	out := make([]DayCount, len(days))
	for i, d := range days {
		out[i] = DayCount{Date: d, Count: by[d]}
	}
	return out
}

// compare compara os 6 dias completos mais recentes (sem o último, que é hoje e está incompleto)
// com os 6 anteriores.
func compare(series []DayCount) Comparison {
	n := len(series)
	var c Comparison
	if n < 1+2*CompareDays {
		return c
	}
	for _, d := range series[n-1-CompareDays : n-1] {
		c.Recent += d.Count
	}
	for _, d := range series[n-1-2*CompareDays : n-1-CompareDays] {
		c.Previous += d.Count
	}
	if c.Previous > 0 {
		p := float64(c.Recent-c.Previous) / float64(c.Previous) * 100
		c.ChangePct = &p
	}
	return c
}

// ---- ao vivo ----

type CallsSummary struct {
	Available bool   `json:"available" doc:"Falso se a voz (LiveKit) está desligada ou não respondeu"`
	Reason    string `json:"reason,omitempty"`
	Ongoing   int    `json:"ongoing" doc:"Chamadas em andamento"`
	People    int    `json:"people" doc:"Pessoas em chamadas"`
	Cameras   int    `json:"cameras" doc:"Câmeras ligadas"`
	Screens   int    `json:"screens" doc:"Compartilhamentos de tela"`
}

// LiveKitUsage vem do endpoint Prometheus do LiveKit; sem ele, Available=false e Reason explica.
type LiveKitUsage struct {
	Available        bool     `json:"available"`
	Reason           string   `json:"reason,omitempty"`
	Rooms            float64  `json:"rooms"`
	Participants     float64  `json:"participants"`
	TracksPublished  float64  `json:"tracks_published"`
	TracksSubscribed float64  `json:"tracks_subscribed"`
	BytesIn          float64  `json:"bytes_in" doc:"Tráfego de entrada acumulado desde o boot do LiveKit"`
	BytesOut         float64  `json:"bytes_out"`
	BytesInPerSec    float64  `json:"bytes_in_per_sec"`
	BytesOutPerSec   float64  `json:"bytes_out_per_sec"`
	PacketsIn        float64  `json:"packets_in"`
	PacketsOut       float64  `json:"packets_out"`
	PacketsPerSec    float64  `json:"packets_per_sec" doc:"Entrada + saída"`
	PacketLossPct    *float64 `json:"packet_loss_pct" nullable:"true"`
	JitterMs         *float64 `json:"jitter_ms" nullable:"true"`
	RTTMs            *float64 `json:"rtt_ms" nullable:"true"`
	QualityScore     *float64 `json:"quality_score" nullable:"true" doc:"Nota de qualidade média do LiveKit (0 a 5)"`
}

type Live struct {
	GeneratedAt time.Time    `json:"generated_at"`
	Calls       CallsSummary `json:"calls"`
	LiveKit     LiveKitUsage `json:"livekit"`
}

type roomView struct{ room LiveRoom }

// Live devolve o "ao vivo agora" (cache de 5 s).
func (s *Service) Live(ctx context.Context) (Live, error) {
	ctx, span := tracer.Start(ctx, "admin.Live")
	defer span.End()
	var l Live
	l.GeneratedAt = s.now()
	if rooms, _, err := s.rooms.get(ctx, s.now, s.loadRooms); err != nil {
		l.Calls = CallsSummary{Reason: reasonFor(err)}
	} else {
		l.Calls = summarize(rooms, "")
	}
	lk, _, err := s.livekit.get(ctx, s.now, s.loadLiveKit)
	if err != nil {
		return Live{}, spanErr(span, err)
	}
	l.LiveKit = lk
	return l, nil
}

func reasonFor(err error) string {
	if errors.Is(err, ErrCallsDisabled) {
		return "voz desligada neste servidor (sem LiveKit configurado)"
	}
	return "não foi possível consultar o servidor LiveKit"
}

func summarize(rooms []roomView, reason string) CallsSummary {
	c := CallsSummary{Available: true, Reason: reason}
	for _, r := range rooms {
		if len(r.room.Participants) == 0 {
			continue
		}
		c.Ongoing++
		for _, p := range r.room.Participants {
			c.People++
			if p.Camera {
				c.Cameras++
			}
			if p.Screen {
				c.Screens++
			}
		}
	}
	return c
}

func (s *Service) loadRooms(ctx context.Context) ([]roomView, error) {
	if s.d.Calls == nil {
		return nil, ErrCallsDisabled
	}
	rooms, err := s.d.Calls.LiveRooms(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]roomView, len(rooms))
	for i, r := range rooms {
		out[i] = roomView{room: r}
	}
	return out, nil
}

func (s *Service) loadLiveKit(ctx context.Context) (LiveKitUsage, error) {
	if s.d.Media == nil {
		return LiveKitUsage{Reason: "o Prometheus do LiveKit não está configurado (veja LIVEKIT_METRICS_URL e `prometheus` em deploy/livekit)"}, nil
	}
	m, err := s.d.Media.Fetch(ctx)
	if err != nil {
		slog.Warn("admin: métricas do LiveKit indisponíveis", "err", err)
		return LiveKitUsage{Reason: "não foi possível ler o endpoint Prometheus do LiveKit; confira se `prometheus` está habilitado na config dele"}, nil
	}
	u := LiveKitUsage{
		Available: true, Rooms: m.Rooms, Participants: m.Participants,
		TracksPublished: m.TracksPublished, TracksSubscribed: m.TracksSubs,
		BytesIn: m.BytesIn, BytesOut: m.BytesOut, PacketsIn: m.PacketsIn, PacketsOut: m.PacketsOut,
		PacketLossPct: m.PacketLossPct, JitterMs: m.JitterMs, RTTMs: m.RTTMs, QualityScore: m.QualityScore,
	}
	now := s.now()
	s.mu.Lock()
	if p := s.prevLK; p != nil {
		if dt := now.Sub(p.at).Seconds(); dt > 0 {
			u.BytesInPerSec, u.BytesOutPerSec = rate(m.BytesIn-p.in, dt), rate(m.BytesOut-p.out, dt)
			u.PacketsPerSec = rate(m.PacketsIn+m.PacketsOut-p.pkIn-p.pkOut, dt)
		}
	}
	s.prevLK = &lkPoint{at: now, in: m.BytesIn, out: m.BytesOut, pkIn: m.PacketsIn, pkOut: m.PacketsOut}
	s.mu.Unlock()
	return u, nil
}

// rate evita taxa negativa quando o contador reinicia (LiveKit reiniciado).
func rate(delta, seconds float64) float64 {
	if delta < 0 || seconds <= 0 {
		return 0
	}
	return delta / seconds
}

// ---- chamadas ----

type CallRoom struct {
	ChannelID       string     `json:"channel_id"`
	Channel         string     `json:"channel" doc:"Nome do canal de voz, ou \"Conversa direta\" em DM"`
	Server          string     `json:"server,omitempty" doc:"Vazio em DM"`
	DM              bool       `json:"dm"`
	People          []string   `json:"people" doc:"Usernames"`
	Cameras         int        `json:"cameras"`
	Screens         int        `json:"screens"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	DurationSeconds int64      `json:"duration_seconds"`
}

type Calls struct {
	GeneratedAt time.Time    `json:"generated_at"`
	Summary     CallsSummary `json:"summary"`
	Rooms       []CallRoom   `json:"rooms"`
}

// Calls lista as salas ativas (cache de 5 s para a leitura do LiveKit); q filtra por servidor, canal ou pessoa.
func (s *Service) Calls(ctx context.Context, q string) (Calls, error) {
	ctx, span := tracer.Start(ctx, "admin.Calls")
	defer span.End()
	out := Calls{GeneratedAt: s.now(), Rooms: []CallRoom{}}
	rooms, at, err := s.rooms.get(ctx, s.now, s.loadRooms)
	if err != nil {
		out.Summary = CallsSummary{Reason: reasonFor(err)}
		return out, nil
	}
	out.GeneratedAt = at
	out.Summary = summarize(rooms, "")
	var chIDs, uIDs []int64
	for _, r := range rooms {
		chIDs = append(chIDs, r.room.ChannelID)
		for _, p := range r.room.Participants {
			uIDs = append(uIDs, p.UserID)
		}
	}
	if len(rooms) == 0 {
		return out, nil
	}
	chans, err := s.d.Store.Channels(ctx, chIDs)
	if err != nil {
		return Calls{}, spanErr(span, err)
	}
	names, err := s.d.Store.Usernames(ctx, uIDs)
	if err != nil {
		return Calls{}, spanErr(span, err)
	}
	needle := strings.ToLower(strings.TrimSpace(q))
	now := s.now()
	for _, r := range rooms {
		ci := chans[r.room.ChannelID]
		cr := CallRoom{ChannelID: strconv.FormatInt(r.room.ChannelID, 10), Channel: ci.Name, Server: ci.GuildName, DM: ci.DM, People: []string{}}
		if ci.DM || cr.Channel == "" {
			cr.Channel = "Conversa direta"
		}
		for _, p := range r.room.Participants {
			n := names[p.UserID]
			if n == "" {
				n = strconv.FormatInt(p.UserID, 10)
			}
			cr.People = append(cr.People, n)
			if p.Camera {
				cr.Cameras++
			}
			if p.Screen {
				cr.Screens++
			}
		}
		sort.Strings(cr.People)
		if !r.room.Since.IsZero() {
			t := r.room.Since
			cr.StartedAt = &t
			cr.DurationSeconds = int64(now.Sub(t).Seconds())
			if cr.DurationSeconds < 0 {
				cr.DurationSeconds = 0
			}
		}
		if needle != "" && !matches(needle, cr) {
			continue
		}
		out.Rooms = append(out.Rooms, cr)
	}
	sort.Slice(out.Rooms, func(i, j int) bool { return out.Rooms[i].DurationSeconds > out.Rooms[j].DurationSeconds })
	return out, nil
}

func matches(needle string, r CallRoom) bool {
	if strings.Contains(strings.ToLower(r.Channel), needle) || strings.Contains(strings.ToLower(r.Server), needle) {
		return true
	}
	for _, p := range r.People {
		if strings.Contains(strings.ToLower(p), needle) {
			return true
		}
	}
	return false
}

// ---- sistema ----

type System struct {
	GeneratedAt time.Time `json:"generated_at"`
	App         struct {
		Version       string    `json:"version"`
		Commit        string    `json:"commit"`
		Environment   string    `json:"environment"`
		ServerTime    time.Time `json:"server_time"`
		StartedAt     time.Time `json:"started_at"`
		UptimeSeconds int64     `json:"uptime_seconds"`
		GoVersion     string    `json:"go_version"`
		Goroutines    int       `json:"goroutines"`
		HeapBytes     uint64    `json:"heap_bytes"`
		SysBytes      uint64    `json:"sys_bytes" doc:"Memória obtida do sistema pelo runtime do Go"`
		RSSBytes      *int64    `json:"rss_bytes" nullable:"true" doc:"Memória residente do processo (só em Linux)"`
	} `json:"app"`
	Database struct {
		SizeBytes int64       `json:"size_bytes"`
		Tables    []TableSize `json:"tables"`
		Pool      *PoolInfo   `json:"pool,omitempty"`
	} `json:"database"`
	Storage struct {
		AttachmentCount int64 `json:"attachment_count"`
		AttachmentBytes int64 `json:"attachment_bytes"`
		Avatars         int64 `json:"avatars" doc:"Quantidade de avatares (o tamanho em bytes não é gravado)"`
		GuildIcons      int64 `json:"guild_icons" doc:"Quantidade de ícones de servidor (o tamanho em bytes não é gravado)"`
	} `json:"storage"`
	Jobs struct {
		Available bool  `json:"available" doc:"Falso se a fila (River) não está rodando neste servidor"`
		Pending   int64 `json:"pending" doc:"Disponíveis para execução"`
		Running   int64 `json:"running"`
		Retryable int64 `json:"retryable" doc:"Falharam e vão tentar de novo"`
		Failed    int64 `json:"failed" doc:"Descartados após esgotar as tentativas"`
		Scheduled int64 `json:"scheduled"`
	} `json:"jobs"`
	Gateway struct {
		Available       bool    `json:"available"`
		Connections     int     `json:"connections" doc:"Conexões WebSocket abertas"`
		Sessions        int     `json:"sessions"`
		OnlineUsers     int     `json:"online_users" doc:"Usuários distintos com sessão viva"`
		EventsPerSecond float64 `json:"events_per_second" doc:"Eventos entregues por segundo, média entre as duas últimas leituras"`
		EventsTotal     int64   `json:"events_total"`
	} `json:"gateway"`
}

// PoolInfo é o pool no JSON.
type PoolInfo struct {
	Max       int32 `json:"max"`
	Open      int32 `json:"open"`
	Idle      int32 `json:"idle"`
	InUse     int32 `json:"in_use"`
	WaitCount int64 `json:"wait_count" doc:"Vezes que alguém esperou por uma conexão, acumulado"`
}

type dbData struct {
	size   int64
	tables []TableSize
}

// System devolve aplicação, banco, armazenamento, fila e gateway (cache de 5 s; banco 60 s; contagens 30 s).
func (s *Service) System(ctx context.Context) (System, error) {
	ctx, span := tracer.Start(ctx, "admin.System")
	defer span.End()
	v, _, err := s.system.get(ctx, s.now, s.loadSystem)
	return v, spanErr(span, err)
}

func (s *Service) loadSystem(ctx context.Context) (System, error) {
	var sy System
	now := s.now()
	sy.GeneratedAt = now
	a := &sy.App
	a.Version, a.Commit = s.versionInfo()
	a.Environment, a.ServerTime, a.StartedAt = s.d.Env, now, s.started
	a.UptimeSeconds = int64(now.Sub(s.started).Seconds())
	a.GoVersion, a.Goroutines = runtime.Version(), runtime.NumGoroutine()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	a.HeapBytes, a.SysBytes = ms.HeapAlloc, ms.Sys
	a.RSSBytes = readRSS()

	db, _, err := s.dbInfo.get(ctx, s.now, func(ctx context.Context) (dbData, error) {
		size, err := s.d.Store.DatabaseSize(ctx)
		if err != nil {
			return dbData{}, err
		}
		tables, err := s.d.Store.LargestTables(ctx)
		return dbData{size: size, tables: tables}, err
	})
	if err != nil {
		return System{}, err
	}
	sy.Database.SizeBytes, sy.Database.Tables = db.size, db.tables
	if s.d.Pool != nil {
		p := s.d.Pool.PoolStats()
		sy.Database.Pool = &PoolInfo{Max: p.Max, Open: p.Open, Idle: p.Idle, InUse: p.InUse, WaitCount: p.WaitCount}
	}
	c, _, err := s.counts.get(ctx, s.now, s.loadCounts)
	if err != nil {
		return System{}, err
	}
	sy.Storage.AttachmentCount, sy.Storage.AttachmentBytes = c.Attachments, c.AttachmentBytes
	sy.Storage.Avatars, sy.Storage.GuildIcons = c.Avatars, c.GuildIcons

	jc, ok, err := s.d.Store.JobCounts(ctx)
	if err != nil {
		slog.Warn("admin: contagem de jobs falhou", "err", err)
	} else if ok {
		sy.Jobs.Available = true
		sy.Jobs.Pending, sy.Jobs.Running, sy.Jobs.Retryable = jc.Available, jc.Running, jc.Retryable
		sy.Jobs.Failed, sy.Jobs.Scheduled = jc.Discarded, jc.Scheduled
	}

	if s.d.Gateway != nil {
		g := s.d.Gateway.GatewayStats()
		sy.Gateway.Available = true
		sy.Gateway.Connections, sy.Gateway.Sessions, sy.Gateway.OnlineUsers = g.Connections, g.Sessions, g.Users
		sy.Gateway.EventsTotal = g.EventsTotal
		s.mu.Lock()
		if p := s.prevGW; p != nil {
			if dt := now.Sub(p.at).Seconds(); dt > 0 {
				sy.Gateway.EventsPerSecond = rate(float64(g.EventsTotal-p.events), dt)
			}
		}
		s.prevGW = &gwPoint{at: now, events: g.EventsTotal}
		s.mu.Unlock()
	}
	return sy, nil
}

func (s *Service) versionInfo() (version, commit string) {
	version, commit = s.d.Version, s.d.Commit
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, kv := range bi.Settings {
			if kv.Key == "vcs.revision" && commit == "" {
				commit = kv.Value
				if len(commit) > 12 {
					commit = commit[:12]
				}
			}
		}
	}
	if version == "" {
		version = "dev"
	}
	if commit == "" {
		commit = "desconhecido"
	}
	return version, commit
}

// readRSS lê VmRSS de /proc/self/status (Linux); nil nos demais sistemas.
func readRSS() *int64 {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(b), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmRSS:"); ok {
			f := strings.Fields(rest)
			if len(f) >= 1 {
				if kb, err := strconv.ParseInt(f[0], 10, 64); err == nil {
					v := kb * 1024
					return &v
				}
			}
		}
	}
	return nil
}

// ---- tabelas ----

var (
	userSorts   = map[string]bool{"username": true, "email": true, "guilds_member": true, "guilds_owned": true, "messages_sent": true, "last_active_at": true, "created_at": true}
	serverSorts = map[string]bool{"name": true, "owner": true, "members": true, "channels": true, "messages": true, "invites_active": true, "created_at": true}
)

// normalize aplica padrões e valida a ordenação contra a lista de colunas permitidas.
func normalize(q ListQuery, allowed map[string]bool) (ListQuery, error) {
	if q.Sort == "" {
		q.Sort = "created_at"
		q.Desc = true
	}
	if !allowed[q.Sort] {
		return q, apperr.Invalid("coluna de ordenação inválida")
	}
	if q.Page < 1 {
		q.Page = 1
	}
	q.Q = strings.TrimSpace(q.Q)
	if len([]rune(q.Q)) > 100 {
		return q, apperr.Invalid("busca longa demais (máx. 100 caracteres)")
	}
	q.PageSize = PageSize
	q.PageOffset = (q.Page - 1) * PageSize
	return q, nil
}

// Users devolve uma página de usuários (25 por página). Sem cache: é paginada e filtrada, e o custo
// está nos índices (guild_members.user_id, guilds.owner_id, messages.author_id, sessions.user_id).
func (s *Service) Users(ctx context.Context, q ListQuery) (UserPage, ListQuery, error) {
	ctx, span := tracer.Start(ctx, "admin.Users", trace.WithAttributes(attribute.String("sort", q.Sort)))
	defer span.End()
	q, err := normalize(q, userSorts)
	if err != nil {
		return UserPage{}, q, err
	}
	p, err := s.d.Store.Users(ctx, q)
	if p.Items == nil {
		p.Items = []UserRow{}
	}
	return p, q, spanErr(span, err)
}

func (s *Service) Servers(ctx context.Context, q ListQuery) (ServerPage, ListQuery, error) {
	ctx, span := tracer.Start(ctx, "admin.Servers", trace.WithAttributes(attribute.String("sort", q.Sort)))
	defer span.End()
	q, err := normalize(q, serverSorts)
	if err != nil {
		return ServerPage{}, q, err
	}
	p, err := s.d.Store.Servers(ctx, q)
	if p.Items == nil {
		p.Items = []ServerRow{}
	}
	return p, q, spanErr(span, err)
}

func spanErr(span trace.Span, err error) error {
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
	}
	return err
}
