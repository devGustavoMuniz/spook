package dmcall

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

// ---- falsos ----

type fakeTimer struct {
	at      time.Time
	f       func()
	stopped bool
}

func (t *fakeTimer) Stop() bool { was := !t.stopped; t.stopped = true; return was }

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }

// advance move o relógio e dispara os temporizadores vencidos e não cancelados.
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var due []*fakeTimer
	for _, t := range c.timers {
		if !t.stopped && !t.at.After(c.now) {
			t.stopped = true
			due = append(due, t)
		}
	}
	c.mu.Unlock()
	for _, t := range due {
		t.f()
	}
}

func (c *fakeClock) pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if !t.stopped {
			n++
		}
	}
	return n
}

type recorder struct {
	mu  sync.Mutex
	evs []events.Event
}

func (r *recorder) Publish(e events.Event) { r.mu.Lock(); r.evs = append(r.evs, e); r.mu.Unlock() }

// to devolve os eventos do tipo entregues ao usuário.
func (r *recorder) to(typ string, user string) []Call {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Call
	for _, e := range r.evs {
		if e.Type == typ && slices.Contains(e.Topics, "user:"+user) {
			out = append(out, e.Data.(Call))
		}
	}
	return out
}

func (r *recorder) reset() { r.mu.Lock(); r.evs = nil; r.mu.Unlock() }

type fakeDMs struct{ chans map[int64]channel.Channel }

func (f fakeDMs) Get(_ context.Context, userID, channelID int64) (channel.Channel, error) {
	c, ok := f.chans[channelID]
	if !ok {
		return channel.Channel{}, apperr.NotFound("canal não encontrado")
	}
	for _, r := range c.Recipients {
		if r.ID == userID {
			return c, nil
		}
	}
	return channel.Channel{}, apperr.NotFound("canal não encontrado")
}

type fakeVoice struct {
	enabled   bool
	occupants map[int64]int
	issued    []int64
}

func (f *fakeVoice) Enabled() bool { return f.enabled }
func (f *fakeVoice) IssueToken(_ context.Context, userID, _ int64) (voice.TokenResponse, error) {
	f.issued = append(f.issued, userID)
	return voice.TokenResponse{URL: "ws://lk", Token: "tok", ExpiresIn: 600}, nil
}
func (f *fakeVoice) Occupants(c int64) int { return f.occupants[c] }

type fakeBlocks struct{ pairs [][2]int64 } // {bloqueador, bloqueado}

func (f fakeBlocks) BlockedAmong(_ context.Context, u int64, cands []int64) ([]int64, error) {
	var out []int64
	for _, p := range f.pairs {
		for _, c := range cands {
			if (p[0] == u && p[1] == c) || (p[1] == u && p[0] == c) {
				out = append(out, c)
			}
		}
	}
	return out, nil
}

func (f fakeBlocks) BlockersOf(_ context.Context, u int64, cands []int64) ([]int64, error) {
	var out []int64
	for _, p := range f.pairs {
		if p[1] == u && slices.Contains(cands, p[0]) {
			out = append(out, p[0])
		}
	}
	return out, nil
}

type fakeNotify struct {
	silent  []int64 // dnd ou DM silenciada
	pushed  [][]int64
	callers []string
}

func (f *fakeNotify) CallRecipients(_ context.Context, _ int64, cands []int64) ([]int64, error) {
	var out []int64
	for _, c := range cands {
		if !slices.Contains(f.silent, c) {
			out = append(out, c)
		}
	}
	return out, nil
}

func (f *fakeNotify) PushCall(_ context.Context, name string, _ int64, rec []int64, _ time.Time) {
	f.pushed = append(f.pushed, rec)
	f.callers = append(f.callers, name)
}

type env struct {
	svc   *Service
	clock *fakeClock
	rec   *recorder
	voice *fakeVoice
	notif *fakeNotify
}

const (
	A, B, C = int64(1), int64(2), int64(3)
	dm      = int64(100)
	group   = int64(200)
)

func rec(ids ...int64) []channel.Recipient {
	var out []channel.Recipient
	for _, id := range ids {
		out = append(out, channel.Recipient{ID: id, Username: "u" + string(rune('0'+id))})
	}
	return out
}

func setup(blocks ...[2]int64) *env {
	clock := &fakeClock{now: time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)}
	e := &env{clock: clock, rec: &recorder{}, voice: &fakeVoice{enabled: true, occupants: map[int64]int{}}, notif: &fakeNotify{}}
	e.svc = NewService(Deps{
		DMs: fakeDMs{chans: map[int64]channel.Channel{
			dm:    {ID: dm, Type: channel.TypeDM, Recipients: rec(A, B)},
			group: {ID: group, Type: channel.TypeGroupDM, Name: "grupo", Recipients: rec(A, B, C)},
		}},
		Voice: e.voice, Blocks: fakeBlocks{pairs: blocks}, Notify: e.notif, Pub: e.rec, Clock: clock, Now: clock.Now,
	})
	return e
}

func ctx() context.Context { return context.Background() }

func kind(err error) apperr.Kind {
	if e, ok := apperr.As(err); ok {
		return e.Kind
	}
	return -1
}

// ---- testes ----

func TestRingNotifiesCalleesOnlyAndExpires(t *testing.T) {
	e := setup()
	call, err := e.svc.Ring(ctx(), A, dm)
	if err != nil || call.State != "ringing" || call.ExpiresAt == nil {
		t.Fatalf("ring = %+v %v", call, err)
	}
	if got := e.rec.to(events.CallRing, "2"); len(got) != 1 || got[0].Caller == nil || got[0].Caller.ID != "1" {
		t.Fatalf("CALL_RING de B = %+v", got)
	}
	if len(e.rec.to(events.CallRing, "1")) != 0 || len(e.rec.to(events.CallUpdate, "1")) != 1 {
		t.Fatal("quem liga recebe só o estado, nunca o toque")
	}
	if len(e.notif.pushed) != 1 || !slices.Equal(e.notif.pushed[0], []int64{B}) {
		t.Fatalf("push = %v", e.notif.pushed)
	}
	if rs := e.svc.Ringing(B); len(rs) != 1 || rs[0].ChannelID != "100" {
		t.Fatalf("Ringing(B) = %v", rs)
	}
	if len(e.svc.Ringing(A)) != 0 {
		t.Fatal("A não toca para si")
	}

	// 44 s: ainda toca; 45 s: sem resposta, acaba para todos e o estado é limpo.
	e.clock.advance(44 * time.Second)
	if len(e.rec.to(events.CallEnd, "2")) != 0 {
		t.Fatal("ainda não deveria ter expirado")
	}
	e.clock.advance(time.Second)
	for _, u := range []string{"1", "2"} {
		end := e.rec.to(events.CallEnd, u)
		if len(end) != 1 || end[0].Reason != ReasonMissed || end[0].State != "ended" {
			t.Fatalf("CALL_END de %s = %+v", u, end)
		}
	}
	if len(e.svc.calls) != 0 || e.clock.pending() != 0 {
		t.Fatal("estado e temporizadores deveriam estar limpos")
	}
	// Depois do fim, dá para ligar de novo.
	if _, err := e.svc.Ring(ctx(), B, dm); err != nil {
		t.Fatal(err)
	}
}

func TestRingRules(t *testing.T) {
	e := setup()
	if _, err := e.svc.Ring(ctx(), C, dm); kind(err) != apperr.KindNotFound {
		t.Fatalf("não participante: %v", err)
	}
	e.voice.enabled = false
	if _, err := e.svc.Ring(ctx(), A, dm); err == nil {
		t.Fatal("voz desligada deve recusar")
	}
	e.voice.enabled = true
	if _, err := e.svc.Ring(ctx(), A, dm); err != nil {
		t.Fatal(err)
	}
	// Idempotente para quem ligou; 409 para o outro participante.
	if _, err := e.svc.Ring(ctx(), A, dm); err != nil {
		t.Fatalf("repetir: %v", err)
	}
	if _, err := e.svc.Ring(ctx(), B, dm); kind(err) != apperr.KindConflict {
		t.Fatalf("outro ligando: %v", err)
	}
	if len(e.clock.timers) != 1 {
		t.Fatalf("um só temporizador por chamada, há %d", len(e.clock.timers))
	}
}

func TestAnswerStopsTimerAndTellsEveryone(t *testing.T) {
	e := setup()
	_, _ = e.svc.Ring(ctx(), A, dm)
	e.rec.reset()
	call, tok, err := e.svc.Accept(ctx(), B, dm)
	if err != nil || call.State != "active" || tok.Token != "tok" || !slices.Equal(e.voice.issued, []int64{B}) {
		t.Fatalf("accept = %+v %+v %v", call, tok, err)
	}
	for _, u := range []string{"1", "2"} {
		up := e.rec.to(events.CallUpdate, u)
		if len(up) != 1 || up[0].Reason != ReasonAnswered || up[0].UserID == nil || *up[0].UserID != "2" || up[0].State != "active" {
			t.Fatalf("CALL_UPDATE de %s = %+v", u, up)
		}
	}
	if e.clock.pending() != 0 {
		t.Fatal("ninguém mais toca: o temporizador deve parar")
	}
	e.clock.advance(time.Minute)
	if len(e.rec.to(events.CallEnd, "1")) != 0 {
		t.Fatal("chamada atendida não expira")
	}
	if _, _, err := e.svc.Accept(ctx(), A, dm); kind(err) != apperr.KindInvalid {
		t.Fatalf("quem ligou não atende: %v", err)
	}
	if _, err := e.svc.Ring(ctx(), A, dm); kind(err) != apperr.KindConflict {
		t.Fatalf("ligar com chamada em andamento: %v", err)
	}
}

func TestAcceptWithoutCall(t *testing.T) {
	e := setup()
	if _, _, err := e.svc.Accept(ctx(), B, dm); kind(err) != apperr.KindNotFound {
		t.Fatalf("accept sem chamada: %v", err)
	}
	if err := e.svc.Decline(ctx(), B, dm); err != nil {
		t.Fatalf("decline é idempotente: %v", err)
	}
	if err := e.svc.Cancel(ctx(), A, dm); err != nil {
		t.Fatalf("cancel é idempotente: %v", err)
	}
}

func TestDeclineAndCancel(t *testing.T) {
	e := setup()
	_, _ = e.svc.Ring(ctx(), A, dm)
	if err := e.svc.Decline(ctx(), A, dm); kind(err) != apperr.KindInvalid {
		t.Fatalf("quem liga não recusa: %v", err)
	}
	if err := e.svc.Cancel(ctx(), B, dm); kind(err) != apperr.KindForbidden {
		t.Fatalf("só quem liga cancela: %v", err)
	}
	e.rec.reset()
	if err := e.svc.Decline(ctx(), B, dm); err != nil {
		t.Fatal(err)
	}
	if end := e.rec.to(events.CallEnd, "1"); len(end) != 1 || end[0].Reason != ReasonDeclined {
		t.Fatalf("recusa 1:1 acaba a chamada: %+v", end)
	}
	if e.clock.pending() != 0 || len(e.svc.calls) != 0 {
		t.Fatal("estado deveria estar limpo")
	}

	_, _ = e.svc.Ring(ctx(), A, dm)
	e.rec.reset()
	if err := e.svc.Cancel(ctx(), A, dm); err != nil {
		t.Fatal(err)
	}
	if end := e.rec.to(events.CallEnd, "2"); len(end) != 1 || end[0].Reason != ReasonCancelled {
		t.Fatalf("cancelar: %+v", end)
	}
	if e.clock.pending() != 0 || len(e.svc.calls) != 0 {
		t.Fatal("estado deveria estar limpo")
	}
}

func TestSilentCalleesNeverHearRingAndCallerSeesNoAnswer(t *testing.T) {
	// DND ou DM silenciada: B não toca, mas a chamada existe e termina sem resposta.
	e := setup()
	e.notif.silent = []int64{B}
	if _, err := e.svc.Ring(ctx(), A, dm); err != nil {
		t.Fatal(err)
	}
	if len(e.rec.to(events.CallRing, "2")) != 0 || len(e.notif.pushed) != 0 {
		t.Fatal("B em DND não deveria tocar nem receber push")
	}
	e.clock.advance(RingDuration)
	if end := e.rec.to(events.CallEnd, "1"); len(end) != 1 || end[0].Reason != ReasonMissed {
		t.Fatalf("fim = %+v", end)
	}

	// Bloqueio: quem foi bloqueado liga e ninguém toca, sem erro (não revela); quem bloqueou recebe erro claro.
	e = setup([2]int64{A, B}) // A bloqueou B
	if _, err := e.svc.Ring(ctx(), A, dm); kind(err) != apperr.KindForbidden {
		t.Fatalf("quem bloqueou: %v", err)
	}
	if _, err := e.svc.Ring(ctx(), B, dm); err != nil {
		t.Fatalf("bloqueado liga em silêncio: %v", err)
	}
	if len(e.rec.to(events.CallRing, "1")) != 0 || len(e.notif.pushed) != 0 {
		t.Fatal("o bloqueador não deveria tocar")
	}
}

func TestGroupCall(t *testing.T) {
	e := setup([2]int64{C, A}) // C bloqueou A: C não toca para A
	call, err := e.svc.Ring(ctx(), A, group)
	if err != nil || !call.Group || call.ChannelName != "grupo" {
		t.Fatalf("ring = %+v %v", call, err)
	}
	if len(e.rec.to(events.CallRing, "2")) != 1 || len(e.rec.to(events.CallRing, "3")) != 0 {
		t.Fatal("B toca; C (que bloqueou A) não")
	}
	// B recusa: com C ainda pendente (em silêncio), a chamada segue tocando para quem ligou.
	e.rec.reset()
	if err := e.svc.Decline(ctx(), B, group); err != nil {
		t.Fatal(err)
	}
	if len(e.rec.to(events.CallEnd, "1")) != 0 {
		t.Fatal("ainda há pendentes")
	}
	if up := e.rec.to(events.CallUpdate, "1"); len(up) != 1 || up[0].Reason != ReasonDeclined {
		t.Fatalf("A deveria ver a recusa: %+v", up)
	}
	e.clock.advance(RingDuration)
	if end := e.rec.to(events.CallEnd, "1"); len(end) != 1 || end[0].Reason != ReasonMissed {
		t.Fatalf("sem resposta de C: %+v", end)
	}
}

func TestGroupAnsweredKeepsRingingForOthersUntilTimeout(t *testing.T) {
	e := setup()
	_, _ = e.svc.Ring(ctx(), A, group)
	if _, _, err := e.svc.Accept(ctx(), B, group); err != nil {
		t.Fatal(err)
	}
	if e.clock.pending() != 1 {
		t.Fatal("C ainda toca: o temporizador continua")
	}
	e.rec.reset()
	e.clock.advance(RingDuration)
	if end := e.rec.to(events.CallEnd, "3"); len(end) != 1 || end[0].Reason != ReasonMissed {
		t.Fatalf("C para de tocar: %+v", end)
	}
	if len(e.rec.to(events.CallEnd, "1")) != 0 {
		t.Fatal("a chamada em andamento não acaba por tempo")
	}
	if len(e.svc.calls) != 1 {
		t.Fatal("a chamada continua ativa")
	}
}

func voiceEvent(channelID int64, user string, joined bool) events.Event {
	p := voice.StatePayload{UserID: user}
	if joined {
		c := "100"
		p.ChannelID = &c
	}
	return events.Event{Type: events.VoiceStateUpdate, ChannelID: channelID, Data: p}
}

func TestVoiceEventsDriveTheCall(t *testing.T) {
	e := setup()
	_, _ = e.svc.Ring(ctx(), A, dm)
	// Quem ligou entrando na sala não atende nada.
	e.svc.OnEvent(voiceEvent(dm, "1", true))
	if s := e.svc.calls[dm].state; s != StateRinging {
		t.Fatalf("estado = %s", s)
	}
	// B entra na sala (sem usar /accept): o toque acaba.
	e.rec.reset()
	e.svc.OnEvent(voiceEvent(dm, "2", true))
	if e.svc.calls[dm].state != StateActive || len(e.rec.to(events.CallUpdate, "2")) != 1 || e.clock.pending() != 0 {
		t.Fatal("entrar na sala atende a chamada")
	}
	// Sai um, fica um: continua. Esvazia: acaba.
	e.voice.occupants[dm] = 1
	e.svc.OnEvent(voiceEvent(dm, "2", false))
	if len(e.svc.calls) != 1 {
		t.Fatal("ainda há gente na sala")
	}
	e.voice.occupants[dm] = 0
	e.svc.OnEvent(voiceEvent(dm, "1", false))
	if end := e.rec.to(events.CallEnd, "1"); len(end) != 1 || end[0].Reason != ReasonEnded || len(e.svc.calls) != 0 {
		t.Fatalf("fim = %+v", end)
	}
	// Eventos de servidor e de canais sem chamada são ignorados.
	e.svc.OnEvent(events.Event{Type: events.VoiceStateUpdate, GuildID: 5, ChannelID: dm, Data: voice.StatePayload{UserID: "2"}})
	e.svc.OnEvent(voiceEvent(group, "2", true))
}

func TestStarterLeavingBeforeAnswerCancels(t *testing.T) {
	e := setup()
	_, _ = e.svc.Ring(ctx(), A, dm)
	e.svc.OnEvent(voiceEvent(dm, "1", true))
	e.voice.occupants[dm] = 0
	e.rec.reset()
	e.svc.OnEvent(voiceEvent(dm, "1", false))
	if end := e.rec.to(events.CallEnd, "2"); len(end) != 1 || end[0].Reason != ReasonCancelled {
		t.Fatalf("fim = %+v", end)
	}
	if e.clock.pending() != 0 {
		t.Fatal("temporizador deveria parar")
	}
}

func TestRingRateLimit(t *testing.T) {
	e := setup()
	e.svc.Limiter = denyAll{}
	if _, err := e.svc.Ring(ctx(), A, dm); kind(err) != apperr.KindRateLimited {
		t.Fatalf("limite: %v", err)
	}
}

type denyAll struct{}

func (denyAll) Take(string) (bool, time.Duration) { return false, time.Second }

func TestCloseStopsTimers(t *testing.T) {
	e := setup()
	_, _ = e.svc.Ring(ctx(), A, dm)
	_, _ = e.svc.Ring(ctx(), A, group)
	e.svc.Close()
	if e.clock.pending() != 0 || len(e.svc.calls) != 0 {
		t.Fatal("Close deve parar todos os temporizadores (sem goroutines vazando)")
	}
}
