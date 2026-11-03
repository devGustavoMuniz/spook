package voice

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// Espectadores da transmissão (adicional, ver SPEC 5.5 "Adicional: voz no backend, histórico do admin e rate
// limits"). O LiveKit não diz quem assina uma faixa por webhook; quem sabe é o cliente, que já escolhe o que
// assistir (setScreenWatching). Ele avisa o backend com PUT/DELETE .../voice/screen-watch/{user_id} e renova por
// heartbeat; o registro fica em memória, com TTL, e não tem goroutine própria (a varredura roda no Run).
const (
	// WatchTTL é por quanto tempo um "estou assistindo" vale sem renovação (o cliente renova a cada ~20 s).
	WatchTTL = 45 * time.Second
	// MaxViewersListed é o máximo de IDs na lista de espectadores do payload (viewer_count é sempre o total).
	MaxViewersListed = 50
)

var (
	errWatchSelf    = apperr.Invalid("você já vê a sua própria tela")
	errWatchMissing = apperr.NotFound("transmissão não encontrada")
)

type watchEntry struct {
	since   time.Time
	expires time.Time
}

// watchers guarda, por transmissor, quem assiste (com validade).
type watchers struct {
	mu sync.Mutex
	by map[int64]map[int64]watchEntry // transmissor → espectador → entrada
}

func newWatchers() *watchers { return &watchers{by: map[int64]map[int64]watchEntry{}} }

// touch registra ou renova; added diz se o espectador é novo (ou estava vencido).
func (w *watchers) touch(streamer, viewer int64, now time.Time) (added bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	m := w.by[streamer]
	if m == nil {
		m = map[int64]watchEntry{}
		w.by[streamer] = m
	}
	e, ok := m[viewer]
	if !ok || !now.Before(e.expires) {
		e = watchEntry{since: now}
		added = true
	}
	e.expires = now.Add(WatchTTL)
	m[viewer] = e
	return added
}

func (w *watchers) remove(streamer, viewer int64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	m := w.by[streamer]
	if _, ok := m[viewer]; !ok {
		return false
	}
	delete(m, viewer)
	if len(m) == 0 {
		delete(w.by, streamer)
	}
	return true
}

// dropStreamer apaga todos os espectadores de um transmissor; devolve se havia algum.
func (w *watchers) dropStreamer(streamer int64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.by[streamer]
	delete(w.by, streamer)
	return ok
}

// dropViewer tira o espectador de todas as transmissões; devolve os transmissores afetados.
func (w *watchers) dropViewer(viewer int64) []int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []int64
	for st, m := range w.by {
		if _, ok := m[viewer]; ok {
			delete(m, viewer)
			out = append(out, st)
			if len(m) == 0 {
				delete(w.by, st)
			}
		}
	}
	return out
}

// expire apaga as entradas vencidas e devolve os transmissores que mudaram.
func (w *watchers) expire(now time.Time) []int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []int64
	for st, m := range w.by {
		changed := false
		for v, e := range m {
			if !now.Before(e.expires) {
				delete(m, v)
				changed = true
			}
		}
		if len(m) == 0 {
			delete(w.by, st)
		}
		if changed {
			out = append(out, st)
		}
	}
	return out
}

// list devolve até max espectadores válidos (os mais antigos primeiro) e o total.
func (w *watchers) list(streamer int64, now time.Time, max int) (ids []int64, total int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	type row struct {
		id    int64
		since time.Time
	}
	var rows []row
	for v, e := range w.by[streamer] {
		if now.Before(e.expires) {
			rows = append(rows, row{v, e.since})
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if !rows[i].since.Equal(rows[j].since) {
			return rows[i].since.Before(rows[j].since)
		}
		return rows[i].id < rows[j].id
	})
	total = len(rows)
	if len(rows) > max {
		rows = rows[:max]
	}
	for _, r := range rows {
		ids = append(ids, r.id)
	}
	return ids, total
}

// stats conta transmissores com espectador e espectadores (métrica).
func (w *watchers) stats() (streamers, viewers int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, m := range w.by {
		streamers++
		viewers += len(m)
	}
	return streamers, viewers
}

// statePayload monta o payload do estado com a contagem e a lista de espectadores de quem transmite.
func (s *Service) statePayload(st State) StatePayload {
	p := st.Payload()
	if !st.Screen {
		return p
	}
	ids, total := s.watch.list(st.UserID, s.now(), MaxViewersListed)
	p.ViewerCount = total
	for _, id := range ids {
		p.Viewers = append(p.Viewers, strconv.FormatInt(id, 10))
	}
	return p
}

// payloadsFor monta os payloads de um snapshot para userID: só o próprio transmissor recebe a lista de espectadores.
func (s *Service) payloadsFor(userID int64, sts []State) []StatePayload {
	out := make([]StatePayload, 0, len(sts))
	for _, st := range sts {
		p := s.statePayload(st)
		if st.UserID != userID {
			p.Viewers = nil
		}
		out = append(out, p)
	}
	return out
}

// republishStreamer avisa a mudança de espectadores de quem transmite. Sem a trava do usuário (quem chama pode
// estar segurando outra trava da mesma faixa); o payload é montado na hora a partir do estado e do registro.
func (s *Service) republishStreamer(streamer int64) {
	if st, ok := s.store.Get(streamer); ok && st.Screen {
		s.publish(st, false)
	}
}

// SetScreenWatch registra (on) ou remove (!on) que viewerID assiste à tela de streamerID no canal. Quem chama
// precisa estar na chamada do canal (404 se não vê o canal, 403 se não está nela); streamerID precisa estar
// transmitindo para registrar. Remover é idempotente.
func (s *Service) SetScreenWatch(ctx context.Context, viewerID, channelID, streamerID int64, on bool) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	ctx, span := tracer.Start(ctx, "voice.SetScreenWatch", trace.WithAttributes(
		attribute.Int64("channel.id", channelID), attribute.Bool("watch", on)))
	defer span.End()
	if _, err := s.access.Channel(ctx, viewerID, channelID); err != nil {
		if denied(err) {
			return errWatchMissing
		}
		return err
	}
	if viewerID == streamerID {
		return errWatchSelf
	}
	me, ok := s.store.Get(viewerID)
	if !ok || me.ChannelID != channelID {
		return errNotInChannel
	}
	s.watchMu.Lock() // ordena registro + publicação: dois espectadores simultâneos não invertem a contagem nos clientes
	defer s.watchMu.Unlock()
	if !on {
		if s.watch.remove(streamerID, viewerID) {
			s.republishStreamer(streamerID)
		}
		return nil
	}
	target, ok := s.store.Get(streamerID)
	if !ok || target.ChannelID != channelID || !target.Screen {
		return errWatchMissing
	}
	if s.watch.touch(streamerID, viewerID, s.now()) {
		s.republishStreamer(streamerID)
	}
	return nil
}

// SweepWatchers apaga as marcas vencidas (viewer sem heartbeat) e avisa os transmissores afetados.
func (s *Service) SweepWatchers() {
	s.watchMu.Lock()
	defer s.watchMu.Unlock()
	for _, st := range s.watch.expire(s.now()) {
		s.republishStreamer(st)
	}
}
