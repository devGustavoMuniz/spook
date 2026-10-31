package presence

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

var tracer = otel.Tracer("spook/presence")

// maxJoinSnapshot limita quantas presenças um novo membro recebe ao entrar num servidor.
const maxJoinSnapshot = 500

// Store é o que o service precisa do banco (consultas de "quem vê quem").
type Store interface {
	// Audience devolve os servidores do usuário e quem divide uma DM com ele.
	Audience(ctx context.Context, userID int64) (guildIDs, dmPeers []int64, err error)
	// OnlineSharing devolve, dos usuários online, quem compartilha servidor ou DM com userID.
	OnlineSharing(ctx context.Context, userID int64, online []int64) ([]int64, error)
	// OnlineGuildMembers devolve, dos usuários online, quem é membro do servidor.
	OnlineGuildMembers(ctx context.Context, guildID int64, online []int64) ([]int64, error)
}

// Bus é o que o service precisa do barramento para reagir a eventos de domínio.
type Bus interface {
	Subscribe(fn func(events.Event)) (cancel func())
}

type userState struct {
	sessions  map[string]bool // id da sessão do gateway -> ausente (idle)
	published string          // último status publicado; mantido durante a tolerância
	timer     Timer
	gen       uint64
}

// Service é a máquina de estados da presença. Os métodos Connect/Disconnect/SetIdle são
// chamados pelo gateway e nunca bloqueiam: as publicações (que consultam o banco) rodam em filas
// por usuário.
type Service struct {
	cfg   Config
	store Store
	pub   events.Publisher

	mu     sync.Mutex
	users  map[int64]*userState
	shards []*shard

	online, idle atomic.Int64
	transitions  metric.Int64Counter
}

// NewService cria o serviço. ctx encerra as filas e a assinatura do barramento; bus pode ser nil
// (testes de unidade).
func NewService(ctx context.Context, cfg Config, store Store, pub events.Publisher, bus Bus) *Service {
	cfg = cfg.withDefaults()
	s := &Service{cfg: cfg, store: store, pub: pub, users: map[int64]*userState{}}
	for range cfg.Shards {
		sh := &shard{wake: make(chan struct{}, 1)}
		s.shards = append(s.shards, sh)
		go sh.run(ctx)
	}
	meter := otel.Meter("spook/presence")
	_, _ = meter.Int64ObservableGauge("spook.presence.users",
		metric.WithDescription("Usuários com presença ativa, por status (online/idle)"),
		metric.WithInt64Callback(func(_ context.Context, o metric.Int64Observer) error {
			o.Observe(s.online.Load(), metric.WithAttributes(attribute.String("status", StatusOnline)))
			o.Observe(s.idle.Load(), metric.WithAttributes(attribute.String("status", StatusIdle)))
			return nil
		}))
	s.transitions, _ = meter.Int64Counter("spook.presence.transitions",
		metric.WithDescription("Transições de presença publicadas, por novo status"))
	if bus != nil {
		cancel := bus.Subscribe(s.onEvent)
		go func() { <-ctx.Done(); cancel() }()
	}
	return s
}

// ---- máquina de estados (chamada pelo gateway) ----

// Connect registra que a sessão tem um socket ativo. Idempotente (um resume não muda o status).
func (s *Service) Connect(userID int64, sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.users[userID]
	if st == nil {
		st = &userState{sessions: map[string]bool{}}
		s.users[userID] = st
	}
	if _, ok := st.sessions[sessionID]; !ok {
		st.sessions[sessionID] = false
	}
	st.gen++ // invalida a tolerância pendente
	if st.timer != nil {
		st.timer.Stop()
		st.timer = nil
	}
	s.evaluateLocked(userID, st)
}

// Disconnect registra que a sessão perdeu o socket. Se era a última, o offline só é publicado
// depois da tolerância; antes disso, reconectar não gera evento.
func (s *Service) Disconnect(userID int64, sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.users[userID]
	if st == nil {
		return
	}
	delete(st.sessions, sessionID)
	if len(st.sessions) > 0 {
		s.evaluateLocked(userID, st)
		return
	}
	st.gen++
	gen := st.gen
	if st.timer != nil {
		st.timer.Stop()
	}
	st.timer = s.cfg.Clock.AfterFunc(s.cfg.OfflineGrace, func() { s.expire(userID, gen) })
}

// SetIdle marca a sessão como ausente (ou de volta a online), por sinal do cliente.
func (s *Service) SetIdle(userID int64, sessionID string, idle bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.users[userID]
	if st == nil {
		return
	}
	if cur, ok := st.sessions[sessionID]; !ok || cur == idle {
		return
	}
	st.sessions[sessionID] = idle
	s.evaluateLocked(userID, st)
}

// Status devolve o status publicado do usuário.
func (s *Service) Status(userID int64) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.users[userID]; st != nil && st.published != "" {
		return st.published
	}
	return StatusOffline
}

func (s *Service) expire(userID int64, gen uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.users[userID]
	if st == nil || st.gen != gen || len(st.sessions) > 0 {
		return
	}
	delete(s.users, userID)
	s.count(st.published, -1)
	s.emitLocked(userID, StatusOffline)
}

// evaluateLocked recalcula o status (o melhor entre as sessões: online > idle) e publica se mudou.
func (s *Service) evaluateLocked(userID int64, st *userState) {
	if len(st.sessions) == 0 {
		return
	}
	want := StatusIdle
	for _, idle := range st.sessions {
		if !idle {
			want = StatusOnline
			break
		}
	}
	if want == st.published {
		return
	}
	s.count(st.published, -1)
	s.count(want, 1)
	st.published = want
	s.emitLocked(userID, want)
}

func (s *Service) count(status string, d int64) {
	switch status {
	case StatusOnline:
		s.online.Add(d)
	case StatusIdle:
		s.idle.Add(d)
	}
}

// emitLocked enfileira a publicação (sob s.mu, para preservar a ordem das transições do usuário).
func (s *Service) emitLocked(userID int64, status string) {
	s.transitions.Add(context.Background(), 1, metric.WithAttributes(attribute.String("status", status)))
	s.shardFor(userID).push(func() { s.broadcast(userID, status) })
}

func (s *Service) shardFor(key int64) *shard {
	return s.shards[int(uint64(key)%uint64(len(s.shards)))]
}

// broadcast publica PRESENCE_UPDATE em guild:<id> de cada servidor do usuário e em user:<par>
// de cada par de DM.
func (s *Service) broadcast(userID int64, status string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ctx, span := tracer.Start(ctx, "presence.transition", spanAttrs(userID, status))
	defer span.End()
	guilds, peers, err := s.store.Audience(ctx, userID)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		slog.Warn("presence: não foi possível calcular quem vê a presença", "user", userID, "err", err)
		return
	}
	topics := make([]string, 0, len(guilds)+len(peers))
	for _, g := range guilds {
		topics = append(topics, "guild:"+strconv.FormatInt(g, 10))
	}
	for _, p := range peers {
		topics = append(topics, "user:"+strconv.FormatInt(p, 10))
	}
	span.SetAttributes(attribute.Int("topics", len(topics)))
	if len(topics) == 0 {
		return
	}
	s.pub.Publish(events.Event{Type: events.PresenceUpdate, Topics: topics, Data: payload(userID, status)})
}

func spanAttrs(userID int64, status string) trace.SpanStartEventOption {
	return trace.WithAttributes(attribute.Int64("user.id", userID), attribute.String("status", status))
}

func payload(userID int64, status string) UpdatePayload {
	return UpdatePayload{UserID: strconv.FormatInt(userID, 10), Status: status}
}

// ---- READY ----

// Snapshot devolve a presença dos usuários não-offline que compartilham servidor ou DM com
// userID. Cruza o conjunto de online (memória) com o banco, partindo dos servidores do próprio
// usuário: nunca varre os membros de um servidor grande.
func (s *Service) Snapshot(ctx context.Context, userID int64) ([]UpdatePayload, error) {
	ctx, span := tracer.Start(ctx, "presence.snapshot")
	defer span.End()
	s.mu.Lock()
	status := make(map[int64]string, len(s.users))
	ids := make([]int64, 0, len(s.users))
	for id, st := range s.users {
		if id != userID && st.published != "" {
			status[id] = st.published
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	span.SetAttributes(attribute.Int("online", len(ids)))
	out := []UpdatePayload{}
	if len(ids) == 0 {
		return out, nil
	}
	visible, err := s.store.OnlineSharing(ctx, userID, ids)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}
	for _, id := range visible {
		out = append(out, payload(id, status[id]))
	}
	return out, nil
}

// ---- reação a eventos de domínio ----

func (s *Service) onEvent(ev events.Event) {
	switch ev.Type {
	case events.GuildMemberAdd:
		var m struct {
			UserID string `json:"user_id"`
		}
		b, err := json.Marshal(ev.Data)
		if err != nil || json.Unmarshal(b, &m) != nil {
			return
		}
		uid, err := strconv.ParseInt(m.UserID, 10, 64)
		if err != nil || ev.GuildID == 0 {
			return
		}
		s.shardFor(ev.GuildID).push(func() { s.memberJoined(ev.GuildID, uid) })
	case events.ChannelCreate:
		if ch, ok := ev.Data.(channel.ChannelPayload); ok && ch.Type == int(channel.TypeGroupDM) {
			s.groupDMCreated(ev, ch)
		}
	}
}

func (s *Service) onlineSnapshot(except int64) (ids []int64, status map[int64]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	status = make(map[int64]string, len(s.users))
	for id, st := range s.users {
		if id != except && st.published != "" {
			status[id] = st.published
			ids = append(ids, id)
		}
	}
	return ids, status
}

// memberJoined: quem entra num servidor passa a ser visto por ele (se está online) e vê quem
// do servidor está online (um PRESENCE_UPDATE por pessoa, no tópico do novo membro).
func (s *Service) memberJoined(guildID, userID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ctx, span := tracer.Start(ctx, "presence.member_joined", spanAttrs(userID, ""))
	defer span.End()
	if st := s.Status(userID); st != StatusOffline {
		s.pub.Publish(events.Event{
			Type: events.PresenceUpdate, GuildID: guildID,
			Topics: []string{"guild:" + strconv.FormatInt(guildID, 10)}, Data: payload(userID, st),
		})
	}
	ids, status := s.onlineSnapshot(userID)
	if len(ids) == 0 {
		return
	}
	members, err := s.store.OnlineGuildMembers(ctx, guildID, ids)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		slog.Warn("presence: não foi possível listar os membros online", "guild", guildID, "err", err)
		return
	}
	if len(members) > maxJoinSnapshot {
		members = members[:maxJoinSnapshot]
	}
	topic := "user:" + strconv.FormatInt(userID, 10)
	for _, m := range members {
		s.pub.Publish(events.Event{Type: events.PresenceUpdate, Topics: []string{topic}, Data: payload(m, status[m])})
	}
}

// groupDMCreated cobre quem só se vê pela DM em grupo (não precisa dividir servidor com todos):
// na criação ou quando alguém é adicionado (o evento vai só ao novo participante), os online
// passam a ver uns aos outros.
func (s *Service) groupDMCreated(ev events.Event, ch channel.ChannelPayload) {
	targets := map[int64]bool{}
	for _, t := range ev.Topics {
		if id, err := strconv.ParseInt(strings.TrimPrefix(t, "user:"), 10, 64); err == nil {
			targets[id] = true
		}
	}
	var members []int64
	for _, r := range ch.Recipients {
		if id, err := strconv.ParseInt(r.ID, 10, 64); err == nil {
			members = append(members, id)
		}
	}
	for t := range targets {
		for _, m := range members {
			if m == t {
				continue
			}
			if st := s.Status(t); st != StatusOffline { // t aparece para os demais participantes
				s.pub.Publish(events.Event{
					Type: events.PresenceUpdate, Topics: []string{"user:" + strconv.FormatInt(m, 10)}, Data: payload(t, st),
				})
			}
			if !targets[m] {
				if st := s.Status(m); st != StatusOffline { // os demais aparecem para t
					s.pub.Publish(events.Event{
						Type: events.PresenceUpdate, Topics: []string{"user:" + strconv.FormatInt(t, 10)}, Data: payload(m, st),
					})
				}
			}
		}
	}
}

// ---- filas de publicação ----

// shard é uma fila FIFO ilimitada com uma goroutine: push nunca bloqueia (é chamado sob s.mu).
type shard struct {
	mu   sync.Mutex
	jobs []func()
	wake chan struct{}
}

func (sh *shard) push(f func()) {
	sh.mu.Lock()
	sh.jobs = append(sh.jobs, f)
	sh.mu.Unlock()
	select {
	case sh.wake <- struct{}{}:
	default:
	}
}

func (sh *shard) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-sh.wake:
		}
		for {
			sh.mu.Lock()
			jobs := sh.jobs
			sh.jobs = nil
			sh.mu.Unlock()
			if len(jobs) == 0 {
				break
			}
			for _, j := range jobs {
				j()
			}
		}
	}
}
