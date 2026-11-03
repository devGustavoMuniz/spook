package dmcall

import (
	"context"
	"slices"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

var tracer = otel.Tracer("spook/dmcall")

// DMs é o que dmcall precisa das DMs (dm.Service): a conversa com os participantes, só se userID participa.
type DMs interface {
	Get(ctx context.Context, userID, channelID int64) (channel.Channel, error)
}

// Voice é o que dmcall precisa da voz (voice.Service): se está ligada, o token de entrada e quantas pessoas
// estão na sala.
type Voice interface {
	Enabled() bool
	IssueToken(ctx context.Context, userID, channelID int64) (voice.TokenResponse, error)
	Occupants(channelID int64) int
}

// Blocks responde sobre bloqueios (relationship.Service).
type Blocks interface {
	BlockedAmong(ctx context.Context, userID int64, candidates []int64) ([]int64, error) // qualquer sentido
	BlockersOf(ctx context.Context, userID int64, candidates []int64) ([]int64, error)   // quem bloqueou userID
}

// Notifier decide quem pode ser avisado (Não perturbar, DM silenciada) e manda o push de chamada
// (notification.Service). Nulo = todos tocam e não há push.
type Notifier interface {
	CallRecipients(ctx context.Context, channelID int64, candidates []int64) ([]int64, error)
	PushCall(ctx context.Context, callerName string, channelID int64, recipients []int64, expires time.Time)
}

// Limiter limita as ligações por usuário.
type Limiter interface {
	Take(key string) (ok bool, retryAfter time.Duration)
}

// Timer e Clock existem para os testes controlarem o tempo.
type Timer interface{ Stop() bool }

type Clock interface {
	AfterFunc(d time.Duration, f func()) Timer
}

type realClock struct{}

func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// Deps são as dependências do Service.
type Deps struct {
	DMs     DMs
	Voice   Voice
	Blocks  Blocks   // opcional
	Notify  Notifier // opcional
	Pub     events.Publisher
	Limiter Limiter // opcional
	Clock   Clock   // padrão: relógio real
	Now     func() time.Time
	RingFor time.Duration // padrão RingDuration
}

type call struct {
	channelID int64
	startedBy int64
	startedAt time.Time
	expiresAt time.Time
	state     State
	group     bool
	name      string
	caller    CallCaller
	members   []int64        // todos os participantes da DM
	ringing   map[int64]bool // quem está ouvindo o toque
	pending   map[int64]bool // quem ainda não respondeu (inclui quem não toca: bloqueio, dnd, silêncio)
	timer     Timer
	gen       uint64
}

// Service guarda as chamadas tocando ou em andamento, uma por DM.
type Service struct {
	Deps

	mu    sync.Mutex
	calls map[int64]*call
	gen   uint64

	events metric.Int64Counter
}

func NewService(d Deps) *Service {
	if d.Clock == nil {
		d.Clock = realClock{}
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.RingFor <= 0 {
		d.RingFor = RingDuration
	}
	s := &Service{Deps: d, calls: map[int64]*call{}}
	s.events, _ = otel.Meter("spook/dmcall").Int64Counter("spook.dmcall.events",
		metric.WithDescription("Eventos de chamadas em DM, por tipo (ring, answered, declined, cancelled, missed, ended)"))
	return s
}

func userTopic(id int64) string { return "user:" + strconv.FormatInt(id, 10) }

func idStr(id int64) string { return strconv.FormatInt(id, 10) }

func (s *Service) count(ctx context.Context, kind string) {
	s.events.Add(ctx, 1, metric.WithAttributes(attribute.String("event", kind)))
}

// payload monta o estado da chamada (s.mu travado).
func (c *call) payload(reason string) Call {
	p := Call{
		ChannelID: idStr(c.channelID), State: string(c.state), StartedBy: idStr(c.startedBy), StartedAt: c.startedAt,
		ChannelName: c.name, Group: c.group, Reason: reason,
	}
	if c.state == StateRinging {
		t := c.expiresAt
		p.ExpiresAt = &t
	}
	return p
}

func (s *Service) emit(typ string, p Call, users ...int64) {
	if len(users) == 0 {
		return
	}
	topics := make([]string, 0, len(users))
	for _, u := range users {
		topics = append(topics, userTopic(u))
	}
	cid, _ := strconv.ParseInt(p.ChannelID, 10, 64)
	s.Pub.Publish(events.Event{Type: typ, ChannelID: cid, Topics: topics, Data: p})
}

func keys(m map[int64]bool) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func (s *Service) take(userID int64) error {
	if s.Limiter == nil {
		return nil
	}
	if ok, wait := s.Limiter.Take("call.ring:" + idStr(userID)); !ok {
		return apperr.RateLimited("você está ligando rápido demais", wait)
	}
	return nil
}

// Ring inicia a chamada: as outras pessoas da DM tocam por até 45 s, menos quem bloqueou (ou foi bloqueado por)
// você, quem está em "Não perturbar" e quem silenciou a conversa; essas não ouvem nada e a chamada fica sem
// resposta para você (não se revela o bloqueio). Quem bloqueou o destinatário recebe um erro claro. Chamar de novo
// uma chamada sua que ainda toca é idempotente.
func (s *Service) Ring(ctx context.Context, userID, channelID int64) (Call, error) {
	ctx, span := tracer.Start(ctx, "dmcall.Ring")
	defer span.End()
	if !s.Voice.Enabled() {
		return Call{}, voice.ErrDisabled
	}
	if err := s.take(userID); err != nil {
		return Call{}, err
	}
	ch, err := s.DMs.Get(ctx, userID, channelID)
	if err != nil {
		return Call{}, err
	}
	var callees []int64
	var caller CallCaller
	for _, r := range ch.Recipients {
		if r.ID == userID {
			rp := r.Payload()
			caller = CallCaller{ID: rp.ID, Username: rp.Username, DisplayName: rp.DisplayName, AvatarURL: rp.AvatarURL}
			continue
		}
		callees = append(callees, r.ID)
	}
	if len(callees) == 0 {
		return Call{}, ErrNoOneToRing
	}

	// Quem pode ouvir o toque (consultas antes de travar).
	audible := slices.Clone(callees)
	if s.Blocks != nil {
		either, err := s.Blocks.BlockedAmong(ctx, userID, callees)
		if err != nil {
			return Call{}, err
		}
		if len(either) > 0 {
			blockers, err := s.Blocks.BlockersOf(ctx, userID, callees)
			if err != nil {
				return Call{}, err
			}
			if ch.Type == channel.TypeDM {
				if len(blockers) == 0 { // só eu bloqueei: erro claro
					return Call{}, ErrBlockedByMe
				}
			}
			audible = slices.DeleteFunc(audible, func(id int64) bool { return slices.Contains(either, id) })
		}
	}
	if s.Notify != nil {
		if audible, err = s.Notify.CallRecipients(ctx, channelID, audible); err != nil {
			return Call{}, err
		}
	}

	s.mu.Lock()
	if cur := s.calls[channelID]; cur != nil {
		defer s.mu.Unlock()
		switch {
		case cur.state == StateRinging && cur.startedBy == userID:
			return cur.payload(""), nil
		case cur.state == StateRinging:
			return Call{}, ErrAlreadyCall
		default:
			return Call{}, ErrCallActive
		}
	}
	now := s.Now()
	c := &call{
		channelID: channelID, startedBy: userID, startedAt: now, expiresAt: now.Add(s.RingFor), state: StateRinging,
		group: ch.Type == channel.TypeGroupDM, name: ch.Name, caller: caller, members: append([]int64{userID}, callees...),
		ringing: map[int64]bool{}, pending: map[int64]bool{},
	}
	for _, id := range callees {
		c.pending[id] = true
	}
	for _, id := range audible {
		c.ringing[id] = true
	}
	s.calls[channelID] = c
	s.armLocked(c)
	ring := c.payload("")
	ring.Caller = &caller
	s.emit(events.CallRing, ring, keys(c.ringing)...)
	s.emit(events.CallUpdate, c.payload(""), userID)
	out := c.payload("")
	exp := c.expiresAt
	rec := keys(c.ringing)
	s.mu.Unlock()

	s.count(ctx, "ring")
	span.SetAttributes(attribute.Int("ringing", len(rec)), attribute.Bool("group", c.group))
	if s.Notify != nil && len(rec) > 0 {
		name := caller.DisplayName
		if name == "" {
			name = caller.Username
		}
		s.Notify.PushCall(ctx, name, channelID, rec, exp)
	}
	return out, nil
}

// armLocked agenda o fim do toque (s.mu travado).
func (s *Service) armLocked(c *call) {
	s.gen++
	c.gen = s.gen
	gen, channelID := c.gen, c.channelID
	c.timer = s.Clock.AfterFunc(s.RingFor, func() { s.expire(channelID, gen) })
}

func (s *Service) stopTimerLocked(c *call) {
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	c.gen = 0
}

// expire encerra o toque por tempo: sem resposta, a chamada acaba para todos; já atendida, só o toque para para
// quem ainda ouvia.
func (s *Service) expire(channelID int64, gen uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.calls[channelID]
	if c == nil || c.gen != gen {
		return
	}
	c.timer = nil
	s.count(context.Background(), "missed")
	if c.state == StateRinging {
		s.endLocked(c, ReasonMissed, c.members...)
		return
	}
	left := keys(c.ringing)
	clear(c.ringing)
	clear(c.pending)
	s.emit(events.CallEnd, c.payload(ReasonMissed), left...)
}

// endLocked apaga a chamada e avisa os usuários (s.mu travado).
func (s *Service) endLocked(c *call, reason string, users ...int64) {
	s.stopTimerLocked(c)
	delete(s.calls, c.channelID)
	p := c.payload(reason)
	p.State = "ended"
	p.ExpiresAt = nil
	s.emit(events.CallEnd, p, users...)
}

// Accept atende: devolve o token de voz da DM. A chamada passa a "em andamento" e as outras sessões de quem
// atendeu param de tocar.
func (s *Service) Accept(ctx context.Context, userID, channelID int64) (Call, voice.TokenResponse, error) {
	ctx, span := tracer.Start(ctx, "dmcall.Accept")
	defer span.End()
	if !s.Voice.Enabled() {
		return Call{}, voice.TokenResponse{}, voice.ErrDisabled
	}
	if _, err := s.DMs.Get(ctx, userID, channelID); err != nil { // só participantes
		return Call{}, voice.TokenResponse{}, err
	}
	s.mu.Lock()
	c := s.calls[channelID]
	switch {
	case c == nil:
		s.mu.Unlock()
		return Call{}, voice.TokenResponse{}, ErrNoCall
	case c.startedBy == userID:
		s.mu.Unlock()
		return Call{}, voice.TokenResponse{}, ErrCallerAction
	}
	s.mu.Unlock()
	tok, err := s.Voice.IssueToken(ctx, userID, channelID)
	if err != nil {
		return Call{}, voice.TokenResponse{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c = s.calls[channelID]
	if c == nil {
		return Call{}, voice.TokenResponse{}, ErrNoCall
	}
	s.answerLocked(c, userID)
	s.count(ctx, "answered")
	return c.payload(ReasonAnswered), tok, nil
}

// answerLocked marca a chamada como em andamento porque userID atendeu ou entrou na sala (s.mu travado).
func (s *Service) answerLocked(c *call, userID int64) {
	delete(c.ringing, userID)
	delete(c.pending, userID)
	c.state = StateActive
	if len(c.ringing) == 0 {
		s.stopTimerLocked(c)
	}
	uid := idStr(userID)
	p := c.payload(ReasonAnswered)
	p.UserID = &uid
	s.emit(events.CallUpdate, p, c.members...)
}

// Decline recusa: para o toque nas sessões de quem recusou e avisa quem ligou. Se todos recusaram, a chamada acaba.
func (s *Service) Decline(ctx context.Context, userID, channelID int64) error {
	ctx, span := tracer.Start(ctx, "dmcall.Decline")
	defer span.End()
	if _, err := s.DMs.Get(ctx, userID, channelID); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.calls[channelID]
	if c == nil {
		return nil // já acabou: idempotente
	}
	if c.startedBy == userID {
		return ErrCallerAction
	}
	if !c.pending[userID] && !c.ringing[userID] {
		return nil
	}
	delete(c.ringing, userID)
	delete(c.pending, userID)
	s.count(ctx, "declined")
	uid := idStr(userID)
	p := c.payload(ReasonDeclined)
	p.UserID = &uid
	if c.state == StateRinging && len(c.pending) == 0 {
		s.endLocked(c, ReasonDeclined, c.members...)
		return nil
	}
	s.emit(events.CallUpdate, p, userID, c.startedBy)
	if c.state == StateActive && len(c.ringing) == 0 {
		s.stopTimerLocked(c) // ninguém mais toca; na fase "tocando" o prazo segue valendo para quem ligou
	}
	return nil
}

// Cancel é a desistência de quem ligou: o toque para para todos e, se ninguém tinha atendido, a chamada acaba.
func (s *Service) Cancel(ctx context.Context, userID, channelID int64) error {
	ctx, span := tracer.Start(ctx, "dmcall.Cancel")
	defer span.End()
	if _, err := s.DMs.Get(ctx, userID, channelID); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.calls[channelID]
	if c == nil {
		return nil
	}
	if c.startedBy != userID {
		return ErrNotCaller
	}
	s.count(ctx, "cancelled")
	if c.state == StateRinging {
		s.endLocked(c, ReasonCancelled, c.members...)
		return nil
	}
	left := keys(c.ringing)
	clear(c.ringing)
	clear(c.pending)
	s.stopTimerLocked(c)
	s.emit(events.CallEnd, c.payload(ReasonCancelled), left...)
	return nil
}

// OnEvent acompanha a sala de voz das DMs (assinante do barramento): quem entra na sala (que não seja quem ligou)
// atende a chamada; quando a sala esvazia, a chamada acaba (ou, se ainda tocava, é cancelada).
func (s *Service) OnEvent(ev events.Event) {
	if ev.Type != events.VoiceStateUpdate || ev.GuildID != 0 || ev.ChannelID == 0 {
		return
	}
	p, ok := ev.Data.(voice.StatePayload)
	if !ok {
		return
	}
	uid, err := strconv.ParseInt(p.UserID, 10, 64)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.calls[ev.ChannelID]
	if c == nil {
		return
	}
	if p.ChannelID != nil { // entrou
		if uid != c.startedBy && slices.Contains(c.members, uid) && (c.state == StateRinging || c.ringing[uid] || c.pending[uid]) {
			s.answerLocked(c, uid)
			s.count(context.Background(), "answered")
		}
		return
	}
	if s.Voice.Occupants(ev.ChannelID) > 0 {
		return
	}
	if c.state == StateRinging {
		s.count(context.Background(), "cancelled")
		s.endLocked(c, ReasonCancelled, c.members...)
		return
	}
	s.count(context.Background(), "ended")
	s.endLocked(c, ReasonEnded, c.members...)
}

// Ringing devolve as chamadas que estão tocando para o usuário (READY: quem recarregou a página no meio do toque).
func (s *Service) Ringing(userID int64) []Call {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Call
	for _, c := range s.calls {
		if c.ringing[userID] {
			p := c.payload("")
			caller := c.caller
			p.Caller = &caller
			out = append(out, p)
		}
	}
	slices.SortFunc(out, func(a, b Call) int { return a.StartedAt.Compare(b.StartedAt) })
	return out
}

// Close para os temporizadores pendentes (desligamento do servidor).
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.calls {
		s.stopTimerLocked(c)
	}
	clear(s.calls)
}
