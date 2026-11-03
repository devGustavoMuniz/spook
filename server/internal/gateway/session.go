package gateway

import (
	"encoding/json"
	"strconv"
	"sync"
	"time"
)

// Session é o estado de um cliente identificado. Sobrevive à queda do socket pela janela de
// resume, guardando os eventos num buffer circular numerado por `s`.
type Session struct {
	id     string
	userID int64
	// authKey: sessão de login dona desta sessão do gateway (vazio em testes).
	authKey string
	hub     *Hub

	// mu protege seq, buffer, conn, detachedAt e dead. push (chamado pelo barramento) só pega
	// este lock por microssegundos e nunca bloqueia em I/O.
	mu         sync.Mutex
	seq        int64
	buf        *ring
	conn       *conn
	detachedAt time.Time
	dead       bool
	// holding: sessão nova ainda sem READY. Eventos que chegam do barramento nesse intervalo ficam
	// retidos em held e são numerados DEPOIS do READY (que precisa ser s=1), sem perder nenhum.
	holding bool
	held    []heldEvent

	// stMu protege as assinaturas. Ordem de locks: stMu → hub.mu.
	stMu   sync.Mutex
	guilds map[int64]*guildState
	topics map[string]struct{}
}

type heldEvent struct {
	t  string
	d  json.RawMessage
	at time.Time
}

// guildState é o que a sessão sabe de um servidor: se pode ver os canais (VIEW_CHANNEL) e em
// quais tópicos de canal está inscrita.
type guildState struct {
	view     bool
	channels map[int64]struct{}
}

func newSession(id string, userID int64, h *Hub) *Session {
	return &Session{
		id: id, userID: userID, hub: h,
		buf:     newRing(h.cfg.BufferSize, h.cfg.ResumeWindow),
		holding: true,
		guilds:  map[int64]*guildState{}, topics: map[string]struct{}{},
	}
}

// push numera o evento, guarda no buffer e acorda o escritor da conexão atual (se houver).
// Se a conexão acumulou eventos demais sem escrever, ela é cortada (4008) e a sessão fica
// para o resume. Nunca bloqueia.
func (s *Session) push(t string, d json.RawMessage, at time.Time) {
	now := time.Now()
	s.mu.Lock()
	if s.dead {
		s.mu.Unlock()
		return
	}
	if s.holding {
		s.held = append(s.held, heldEvent{t: t, d: d, at: at})
		s.mu.Unlock()
		return
	}
	s.appendLocked(t, d, at, now)
	s.afterAppend()
}

// appendLocked numera o evento e o guarda no buffer. Exige s.mu.
func (s *Session) appendLocked(t string, d json.RawMessage, at, now time.Time) {
	s.seq++
	s.buf.push(event{Seq: s.seq, T: t, D: d, At: at}, now)
}

// afterAppend avalia consumidor lento e acorda o escritor. Chamado com s.mu travado; destrava-o.
func (s *Session) afterAppend() {
	c := s.conn
	slow := c != nil && !c.replaying.Load() && s.seq-c.sent.Load() > int64(s.hub.cfg.SendQueue)
	s.mu.Unlock()
	if c == nil {
		return
	}
	if slow {
		s.hub.met.slowClose()
		c.closeAsync(CloseSlowConsumer, "consumidor lento")
		return
	}
	c.wakeUp()
}

// pushReady numera o READY como s=1 e, em seguida, libera os eventos retidos desde o registro da
// sessão, na ordem em que chegaram. É atômico em relação ao push.
func (s *Session) pushReady(ready json.RawMessage, at time.Time) {
	now := time.Now()
	s.mu.Lock()
	if s.dead {
		s.mu.Unlock()
		return
	}
	s.holding = false
	held := s.held
	s.held = nil
	s.appendLocked(EventReady, ready, at, now)
	for _, e := range held {
		s.appendLocked(e.t, e.d, e.at, now)
	}
	s.afterAppend()
}

// pending devolve os eventos com Seq > after para o escritor. ok é false se o buffer não cobre
// (o consumidor ficou para trás além do buffer).
func (s *Session) pending(c *conn, after int64) (out []event, last int64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != c {
		return nil, s.seq, true // outra conexão assumiu: o escritor antigo só termina
	}
	out, ok = s.buf.since(after, s.seq)
	return out, s.seq, ok
}

// attach liga uma conexão à sessão. Devolve a conexão anterior (a ser fechada), se havia.
func (s *Session) attach(c *conn) (old *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, s.conn = s.conn, c
	s.detachedAt = time.Time{}
	s.hub.presenceConnect(s) // sob s.mu: a ordem Connect/Disconnect da sessão fica garantida
	return old
}

// detach desliga a conexão (se ainda for a atual) e começa a contar a janela de resume.
func (s *Session) detach(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == c {
		s.conn = nil
		s.detachedAt = time.Now()
		s.hub.presenceDisconnect(s)
	}
}

// tryResume valida o resume e, se der, assume a sessão para c. Devolve a conexão anterior.
func (s *Session) tryResume(c *conn, seq int64) (old *conn, upTo int64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return nil, 0, false
	}
	s.buf.trim(time.Now())
	if _, ok := s.buf.since(seq, s.seq); !ok {
		return nil, 0, false
	}
	old, s.conn = s.conn, c
	s.detachedAt = time.Time{}
	s.hub.presenceConnect(s)
	return old, s.seq, true
}

func (s *Session) expired(now time.Time, window time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn == nil && !s.detachedAt.IsZero() && now.Sub(s.detachedAt) > window
}

func (s *Session) trimAge(now time.Time) {
	s.mu.Lock()
	s.buf.trim(now)
	s.mu.Unlock()
}

func (s *Session) isDetached() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn == nil
}

// kill encerra a sessão (expirou ou o servidor está parando).
func (s *Session) kill() {
	s.mu.Lock()
	s.dead = true
	s.buf = newRing(0, 0)
	s.mu.Unlock()
}

// ---- assinaturas ----

func userTopic(id int64) string  { return "user:" + strconv.FormatInt(id, 10) }
func guildTopic(id int64) string { return "guild:" + strconv.FormatInt(id, 10) }
func channelTopic(id int64) string {
	return "channel:" + strconv.FormatInt(id, 10)
}

func (s *Session) subLocked(topic string) {
	if _, ok := s.topics[topic]; ok {
		return
	}
	s.topics[topic] = struct{}{}
	s.hub.subscribe(s, topic)
}

func (s *Session) unsubLocked(topic string) {
	if _, ok := s.topics[topic]; !ok {
		return
	}
	delete(s.topics, topic)
	s.hub.unsubscribe(s, topic)
}

// subscribeUser inscreve a sessão no tópico do próprio usuário.
func (s *Session) subscribeUser() {
	s.stMu.Lock()
	s.subLocked(userTopic(s.userID))
	s.stMu.Unlock()
}

// setGuild (re)define o estado de um servidor: assina guild:<id> e, com VIEW_CHANNEL, cada canal.
func (s *Session) setGuild(gid int64, view bool, channels []int64) {
	s.stMu.Lock()
	defer s.stMu.Unlock()
	if old := s.guilds[gid]; old != nil {
		for ch := range old.channels {
			s.unsubLocked(channelTopic(ch))
		}
	}
	st := &guildState{view: view, channels: map[int64]struct{}{}}
	s.guilds[gid] = st
	s.subLocked(guildTopic(gid))
	if view {
		for _, ch := range channels {
			st.channels[ch] = struct{}{}
			s.subLocked(channelTopic(ch))
		}
	}
}

// dmAdded inscreve a sessão no canal de uma DM de que o usuário participa.
func (s *Session) dmAdded(ch int64) {
	s.stMu.Lock()
	s.subLocked(channelTopic(ch))
	s.stMu.Unlock()
}

// dropGuild remove o servidor e todos os seus tópicos (saiu, foi expulso ou o servidor foi excluído).
func (s *Session) dropGuild(gid int64) {
	s.stMu.Lock()
	defer s.stMu.Unlock()
	st := s.guilds[gid]
	if st == nil {
		return
	}
	for ch := range st.channels {
		s.unsubLocked(channelTopic(ch))
	}
	delete(s.guilds, gid)
	s.unsubLocked(guildTopic(gid))
}

// canView diz se a sessão tem VIEW_CHANNEL no servidor (a base; o que vale por canal é canSee).
func (s *Session) canView(gid int64) bool {
	s.stMu.Lock()
	defer s.stMu.Unlock()
	st := s.guilds[gid]
	return st != nil && st.view
}

// channelAdded inscreve a sessão num canal novo, se ela vê os canais do servidor.
func (s *Session) channelAdded(gid, ch int64) {
	s.stMu.Lock()
	defer s.stMu.Unlock()
	st := s.guilds[gid]
	if st == nil || !st.view {
		return
	}
	st.channels[ch] = struct{}{}
	s.subLocked(channelTopic(ch))
}

func (s *Session) channelRemoved(gid, ch int64) {
	s.stMu.Lock()
	defer s.stMu.Unlock()
	if st := s.guilds[gid]; st != nil {
		delete(st.channels, ch)
	}
	s.unsubLocked(channelTopic(ch))
}

// canSee diz se a sessão vê o canal do servidor (está inscrita no tópico dele).
func (s *Session) canSee(gid, ch int64) bool {
	s.stMu.Lock()
	defer s.stMu.Unlock()
	st := s.guilds[gid]
	if st == nil {
		return false
	}
	_, ok := st.channels[ch]
	return ok
}

// syncChannels aplica a visão recalculada do servidor (permissão base + canais que a pessoa vê): sai dos tópicos
// dos canais que deixou de ver e entra nos novos. Devolve os IDs adicionados e removidos.
func (s *Session) syncChannels(gid int64, view bool, visible []int64) (added, removed []int64) {
	s.stMu.Lock()
	defer s.stMu.Unlock()
	st := s.guilds[gid]
	if st == nil {
		return nil, nil
	}
	st.view = view
	want := make(map[int64]struct{}, len(visible))
	for _, ch := range visible {
		want[ch] = struct{}{}
	}
	for ch := range st.channels {
		if _, ok := want[ch]; !ok {
			s.unsubLocked(channelTopic(ch))
			delete(st.channels, ch)
			removed = append(removed, ch)
		}
	}
	for _, ch := range visible {
		if _, ok := st.channels[ch]; !ok {
			st.channels[ch] = struct{}{}
			s.subLocked(channelTopic(ch))
			added = append(added, ch)
		}
	}
	return added, removed
}

// release remove todas as assinaturas da sessão.
func (s *Session) release() {
	s.stMu.Lock()
	defer s.stMu.Unlock()
	for t := range s.topics {
		s.hub.unsubscribe(s, t)
	}
	clear(s.topics)
	clear(s.guilds)
}
