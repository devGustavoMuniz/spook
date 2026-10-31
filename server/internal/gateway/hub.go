package gateway

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

var tracer = otel.Tracer("spook/gateway")

// maxSessionsPerUser limita sessões (com ou sem socket) por usuário; as sem socket mais antigas
// são descartadas primeiro.
const maxSessionsPerUser = 20

// refreshWorkers é o paralelismo ao recalcular permissões depois de eventos de cargo.
const refreshWorkers = 16

// Directory é o que o gateway consulta do domínio (implementada pelo guild.Service): a lista
// de servidores do usuário (mesmo formato do GET /api/guilds), a permissão de um membro e os
// canais de um servidor.
type Directory interface {
	List(ctx context.Context, userID int64) ([]guild.Detail, error)
	Member(ctx context.Context, guildID, userID int64) (perm.Member, error)
	ChannelIDs(ctx context.Context, guildID int64) ([]int64, error)
}

// DMs é o que o gateway consulta das DMs (implementada pelo dm.Service): as DMs do usuário, com
// participantes, no READY e para assinar os canais.
type DMs interface {
	List(ctx context.Context, userID int64) ([]channel.Channel, error)
}

// Presence é o que o gateway avisa à presença (implementada pelo presence.Service): sessões que
// ganham ou perdem o socket e mudanças de idle (op 12), mais o snapshot do READY. Os métodos de
// aviso não bloqueiam (o gateway os chama com o lock da sessão).
type Presence interface {
	Connect(userID int64, sessionID string)
	Disconnect(userID int64, sessionID string)
	SetIdle(userID int64, sessionID string, idle bool)
	Snapshot(ctx context.Context, userID int64) ([]presence.UpdatePayload, error)
}

// Option liga uma dependência opcional do Hub.
type Option func(*Hub)

// WithDMs liga o suporte a DMs (assinaturas e private_channels no READY).
func WithDMs(d DMs) Option { return func(h *Hub) { h.dms = d } }

// WithPresence liga a presença (avisos de conexão, op 12 e presences no READY).
func WithPresence(p Presence) Option { return func(h *Hub) { h.pres = p } }

// Bus é o que o gateway precisa do barramento de eventos.
type Bus interface {
	Subscribe(fn func(events.Event)) (cancel func())
}

// Hub mantém sessões, conexões e as assinaturas por tópico, e faz o fan-out dos eventos.
type Hub struct {
	cfg  Config
	dir  Directory
	dms  DMs
	pres Presence
	met  *metrics
	tk   *tickets

	mu       sync.RWMutex
	topics   map[string]map[*Session]struct{}
	sessions map[string]*Session
	byUser   map[int64]map[*Session]struct{}
	conns    map[*conn]struct{}
	closed   bool

	wg           sync.WaitGroup // goroutines de conexão
	cancelBus    func()
	shutdownOnce sync.Once
	shutdownDone chan struct{}
	stopJanitor  chan struct{}
}

// NewHub cria o gateway e se inscreve no barramento. ctx controla a manutenção; quando for
// cancelado o hub se encerra (close 1001 em todas as conexões).
func NewHub(ctx context.Context, cfg Config, dir Directory, bus Bus, opts ...Option) *Hub {
	cfg = cfg.withDefaults()
	h := &Hub{
		cfg: cfg, dir: dir, met: newMetrics(), tk: newTickets(cfg.TicketTTL),
		topics: map[string]map[*Session]struct{}{}, sessions: map[string]*Session{},
		byUser: map[int64]map[*Session]struct{}{}, conns: map[*conn]struct{}{},
		shutdownDone: make(chan struct{}), stopJanitor: make(chan struct{}),
	}
	for _, o := range opts {
		o(h)
	}
	h.cancelBus = bus.Subscribe(h.handle)
	go h.janitor()
	go func() {
		select {
		case <-ctx.Done():
			sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = h.Shutdown(sctx)
		case <-h.shutdownDone:
		}
	}()
	return h
}

// Shutdown encerra o gateway com elegância: para de aceitar conexões, manda close 1001 a todas
// e espera as goroutines terminarem (ou ctx expirar). É idempotente.
func (h *Hub) Shutdown(ctx context.Context) error {
	h.shutdownOnce.Do(func() {
		h.mu.Lock()
		h.closed = true
		cs := make([]*conn, 0, len(h.conns))
		for c := range h.conns {
			cs = append(cs, c)
		}
		h.mu.Unlock()
		h.cancelBus()
		close(h.stopJanitor)
		for _, c := range cs {
			c.closeAsync(CloseGoingAway, "servidor reiniciando")
		}
		close(h.shutdownDone)
	})
	done := make(chan struct{})
	go func() { h.wg.Wait(); close(done) }()
	select {
	case <-done:
		h.mu.Lock()
		for _, s := range h.sessions {
			s.kill()
		}
		h.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Stats é um retrato para testes e diagnóstico.
type Stats struct{ Conns, Sessions int }

func (h *Hub) Stats() Stats {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return Stats{Conns: len(h.conns), Sessions: len(h.sessions)}
}

// ---- registro ----

func (h *Hub) addConn(c *conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return false
	}
	h.conns[c] = struct{}{}
	h.wg.Add(1)
	h.met.conns.Add(1)
	return true
}

func (h *Hub) removeConn(c *conn) {
	h.mu.Lock()
	delete(h.conns, c)
	h.mu.Unlock()
	h.met.conns.Add(-1)
	h.wg.Done()
}

func newSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// register cria uma sessão nova para o usuário (antes de assinar qualquer tópico).
// ok é false quando o usuário está no limite de sessões ativas.
func (h *Hub) register(userID int64) (*Session, bool) {
	s := newSession(newSessionID(), userID, h)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, false
	}
	mine := h.byUser[userID]
	for len(mine) >= maxSessionsPerUser {
		var oldest *Session
		var oldestAt time.Time
		for o := range mine {
			o.mu.Lock()
			det, at := o.conn == nil, o.detachedAt
			o.mu.Unlock()
			if det && (oldest == nil || at.Before(oldestAt)) {
				oldest, oldestAt = o, at
			}
		}
		if oldest == nil {
			return nil, false
		}
		h.removeSessionLocked(oldest)
	}
	if mine == nil {
		mine = map[*Session]struct{}{}
		h.byUser[userID] = mine
	}
	mine[s] = struct{}{}
	h.sessions[s.id] = s
	h.met.sessions.Add(1)
	return s, true
}

// removeSessionLocked tira a sessão dos índices (h.mu seguro) e libera as assinaturas fora do lock.
func (h *Hub) removeSessionLocked(s *Session) {
	if _, ok := h.sessions[s.id]; !ok {
		return
	}
	delete(h.sessions, s.id)
	if mine := h.byUser[s.userID]; mine != nil {
		delete(mine, s)
		if len(mine) == 0 {
			delete(h.byUser, s.userID)
		}
	}
	h.met.sessions.Add(-1)
	s.kill()
	go s.release() // pega stMu e depois h.mu: tem de rodar fora do lock atual
}

// dropSession descarta uma sessão que não chegou a ser usada.
func (h *Hub) dropSession(s *Session) {
	h.mu.Lock()
	h.removeSessionLocked(s)
	h.mu.Unlock()
}

func (h *Hub) lookup(id string) *Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.sessions[id]
}

func (h *Hub) subscribe(s *Session, topic string) {
	h.mu.Lock()
	m := h.topics[topic]
	if m == nil {
		m = map[*Session]struct{}{}
		h.topics[topic] = m
	}
	m[s] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) unsubscribe(s *Session, topic string) {
	h.mu.Lock()
	if m := h.topics[topic]; m != nil {
		delete(m, s)
		if len(m) == 0 {
			delete(h.topics, topic)
		}
	}
	h.mu.Unlock()
}

// recipients devolve as sessões inscritas em algum dos tópicos, sem repetição.
func (h *Hub) recipients(topics []string) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if len(topics) == 1 {
		m := h.topics[topics[0]]
		out := make([]*Session, 0, len(m))
		for s := range m {
			out = append(out, s)
		}
		return out
	}
	seen := map[*Session]struct{}{}
	var out []*Session
	for _, t := range topics {
		for s := range h.topics[t] {
			if _, ok := seen[s]; !ok {
				seen[s] = struct{}{}
				out = append(out, s)
			}
		}
	}
	return out
}

// janitor descarta sessões sem socket depois da janela de resume e poda eventos velhos dos buffers.
func (h *Hub) janitor() {
	every := h.cfg.ResumeWindow / 4
	if every > 5*time.Second {
		every = 5 * time.Second
	}
	if every < 10*time.Millisecond {
		every = 10 * time.Millisecond
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-h.stopJanitor:
			return
		case now := <-t.C:
			h.mu.RLock()
			all := make([]*Session, 0, len(h.sessions))
			for _, s := range h.sessions {
				all = append(all, s)
			}
			h.mu.RUnlock()
			var dead []*Session
			for _, s := range all {
				if s.expired(now, h.cfg.ResumeWindow) {
					dead = append(dead, s)
				} else {
					s.trimAge(now)
				}
			}
			if len(dead) > 0 {
				h.mu.Lock()
				for _, s := range dead {
					h.removeSessionLocked(s)
				}
				h.mu.Unlock()
			}
			h.tk.purge()
		}
	}
}

// ---- fan-out ----

// Campos mínimos que o gateway lê dos payloads para manter as assinaturas.
type guildCreateData struct {
	ID          string `json:"id"`
	Permissions int64  `json:"permissions"`
	IsOwner     bool   `json:"is_owner"`
	Channels    []struct {
		ID string `json:"id"`
	} `json:"channels"`
}

type memberData struct {
	UserID string `json:"user_id"`
}

// handle é o assinante do barramento: roda numa só goroutine, então os eventos chegam em ordem.
func (h *Hub) handle(ev events.Event) {
	if len(ev.Topics) == 0 {
		return
	}
	ctx, span := tracer.Start(context.Background(), "gateway.fanout",
		trace.WithAttributes(attribute.String("event.type", ev.Type)))
	defer span.End()

	d, err := json.Marshal(ev.Data)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		slog.Error("gateway: payload do evento não serializa", "type", ev.Type, "err", err)
		return
	}
	recips := h.recipients(ev.Topics)

	// Antes de entregar: atualiza as assinaturas e as permissões, para que o filtro use o estado novo.
	switch ev.Type {
	case events.GuildCreate:
		var g guildCreateData
		if json.Unmarshal(d, &g) == nil {
			if gid, err := strconv.ParseInt(g.ID, 10, 64); err == nil {
				view := g.IsOwner || perm.Perm(g.Permissions).Has(perm.ViewChannel)
				chs := make([]int64, 0, len(g.Channels))
				for _, c := range g.Channels {
					if id, err := strconv.ParseInt(c.ID, 10, 64); err == nil {
						chs = append(chs, id)
					}
				}
				for _, s := range recips {
					s.setGuild(gid, view, chs)
				}
			}
		}
	case events.ChannelCreate, events.ChannelUpdate:
		if ev.GuildID == 0 {
			// DM (o evento vai a user:<id> de cada participante): assina o canal. Idempotente, então
			// também cobre o participante recém-adicionado e outras sessões do mesmo usuário.
			for _, s := range recips {
				s.dmAdded(ev.ChannelID)
			}
		} else if ev.Type == events.ChannelCreate {
			for _, s := range recips {
				s.channelAdded(ev.GuildID, ev.ChannelID)
			}
		}
	case events.RoleUpdate, events.RoleDelete:
		h.refresh(ctx, recips, ev.GuildID)
	case events.GuildMemberUpdate:
		var m memberData
		if json.Unmarshal(d, &m) == nil {
			if uid, err := strconv.ParseInt(m.UserID, 10, 64); err == nil {
				var mine []*Session
				for _, s := range recips {
					if s.userID == uid {
						mine = append(mine, s)
					}
				}
				h.refresh(ctx, mine, ev.GuildID)
			}
		}
	}

	delivered := 0
	for _, s := range recips {
		if !allows(s, ev) {
			continue
		}
		s.push(ev.Type, d, ev.At)
		delivered++
	}

	// Depois de entregar: remove o que acabou de deixar de existir para a sessão.
	switch ev.Type {
	case events.GuildDelete:
		for _, s := range recips {
			s.dropGuild(ev.GuildID)
		}
	case events.ChannelDelete:
		for _, s := range recips {
			s.channelRemoved(ev.GuildID, ev.ChannelID)
		}
	}

	span.SetAttributes(attribute.Int("recipients", len(recips)), attribute.Int("delivered", delivered))
	if delivered > 0 {
		h.met.dispatched.Add(ctx, int64(delivered), metric.WithAttributes(attribute.String("event", ev.Type)))
	}
}

// allows é o filtro de permissão: mensagens e canais de um servidor só vão a quem tem VIEW_CHANNEL
// nele, mesmo que a assinatura do tópico ainda exista (defesa em profundidade).
func allows(s *Session, ev events.Event) bool {
	switch ev.Type {
	case events.MessageCreate, events.MessageUpdate, events.MessageDelete, events.TypingStart,
		events.ChannelCreate, events.ChannelUpdate, events.ChannelDelete:
		if ev.GuildID != 0 {
			return s.canView(ev.GuildID)
		}
	}
	return true
}

// refresh recalcula a permissão das sessões no servidor (em paralelo limitado) e ajusta as
// assinaturas de canal. Espera terminar para que os eventos seguintes já usem o estado novo.
func (h *Hub) refresh(ctx context.Context, sessions []*Session, gid int64) {
	if len(sessions) == 0 || gid == 0 {
		return
	}
	ctx, span := tracer.Start(ctx, "gateway.refresh_permissions",
		trace.WithAttributes(attribute.Int("sessions", len(sessions))))
	defer span.End()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Uma consulta por usuário (várias sessões do mesmo usuário compartilham o resultado).
	byUser := map[int64][]*Session{}
	for _, s := range sessions {
		byUser[s.userID] = append(byUser[s.userID], s)
	}
	sem := make(chan struct{}, refreshWorkers)
	var wg sync.WaitGroup
	for uid, ss := range byUser {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			m, err := h.dir.Member(ctx, gid, uid)
			switch {
			case errors.Is(err, perm.ErrNotMember):
				for _, s := range ss {
					s.dropGuild(gid)
				}
				return
			case err != nil:
				slog.Warn("gateway: não foi possível recalcular a permissão", "guild", gid, "user", uid, "err", err)
				return
			}
			view := m.Has(perm.ViewChannel)
			for _, s := range ss {
				if err := s.setView(gid, view, func() ([]int64, error) { return h.dir.ChannelIDs(ctx, gid) }); err != nil {
					slog.Warn("gateway: não foi possível listar os canais", "guild", gid, "user", uid, "err", err)
				}
			}
		}()
	}
	wg.Wait()
}

func (h *Hub) presenceConnect(s *Session) {
	if h.pres != nil {
		h.pres.Connect(s.userID, s.id)
	}
}

func (h *Hub) presenceDisconnect(s *Session) {
	if h.pres != nil {
		h.pres.Disconnect(s.userID, s.id)
	}
}
