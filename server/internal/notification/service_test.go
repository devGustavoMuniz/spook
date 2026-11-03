package notification

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/message"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

// ---- dublês ----

type fakeStore struct {
	mu sync.Mutex

	acks       []ackCall
	ackResult  [2]int64 // last_read, mention_count devolvidos
	mentionLog []mentionCall
	recipients map[int64][]int64
	resolved   []int64
	resolveErr error
	pctx       map[int64]PushContext
	subs       map[int64]Subscription
	subLimit   int
	deleted    []int64
	leftGuilds [][2]int64

	filters  map[int64]NotifyFilter // por usuário; ausente = sem configuração, fora do DND
	settings map[string]Setting     // "scope:target"
	members  map[int64]bool         // servidores dos quais o usuário (qualquer um) é membro
}

type ackCall struct{ user, channel, message int64 }
type mentionCall struct {
	channel int64
	guild   *int64
	users   []int64
}

func newFakeStore() *fakeStore {
	return &fakeStore{recipients: map[int64][]int64{}, pctx: map[int64]PushContext{}, subs: map[int64]Subscription{}}
}

func (f *fakeStore) Ack(_ context.Context, u, c, m int64) (int64, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acks = append(f.acks, ackCall{u, c, m})
	return f.ackResult[0], int(f.ackResult[1]), nil
}

func (f *fakeStore) IncrementMentions(_ context.Context, c int64, g *int64, users []int64) ([]MentionState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mentionLog = append(f.mentionLog, mentionCall{c, g, users})
	out := make([]MentionState, len(users))
	for i, u := range users {
		out[i] = MentionState{UserID: u, LastRead: 5, Mentions: 1}
	}
	return out, nil
}
func (f *fakeStore) DeleteGuildReadStates(_ context.Context, g, u int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.leftGuilds = append(f.leftGuilds, [2]int64{g, u})
	return nil
}
func (f *fakeStore) ReadStates(context.Context, int64) ([]ReadState, error) { return nil, nil }

func (f *fakeStore) ListSettings(context.Context, int64) ([]Setting, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Setting
	for _, s := range f.settings {
		out = append(out, s)
	}
	return out, nil
}
func (f *fakeStore) UpsertSetting(_ context.Context, _ int64, s Setting) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.settings == nil {
		f.settings = map[string]Setting{}
	}
	f.settings[s.Scope+":"+strconv.FormatInt(s.TargetID, 10)] = s
	return nil
}
func (f *fakeStore) DeleteSetting(_ context.Context, _ int64, scope string, target int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.settings, scope+":"+strconv.FormatInt(target, 10))
	return nil
}
func (f *fakeStore) IsGuildMember(_ context.Context, g, _ int64) (bool, error) {
	return f.members[g], nil
}
func (f *fakeStore) NotifyFilters(_ context.Context, users []int64, _ int64, _ *int64) ([]NotifyFilter, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]NotifyFilter, 0, len(users))
	for _, u := range users {
		flt := f.filters[u]
		flt.UserID = u
		out = append(out, flt)
	}
	return out, nil
}
func (f *fakeStore) ResolveGuildMentions(_ context.Context, _, _ int64, _ []string) ([]int64, error) {
	return f.resolved, f.resolveErr
}
func (f *fakeStore) ResolveDMMentions(_ context.Context, _, _ int64, _ []string) ([]int64, error) {
	return f.resolved, f.resolveErr
}
func (f *fakeStore) RecipientIDs(_ context.Context, c int64) ([]int64, error) {
	return f.recipients[c], nil
}
func (f *fakeStore) PushContext(_ context.Context, m int64) (PushContext, error) {
	pc, ok := f.pctx[m]
	if !ok {
		return PushContext{}, ErrNotFound
	}
	return pc, nil
}
func (f *fakeStore) Subscribe(_ context.Context, s Subscription, limit int) error {
	f.subLimit = limit
	f.subs[s.ID] = s
	return nil
}
func (f *fakeStore) Unsubscribe(context.Context, int64, string) error { return nil }
func (f *fakeStore) Subscription(_ context.Context, id int64) (Subscription, error) {
	s, ok := f.subs[id]
	if !ok {
		return Subscription{}, ErrNotFound
	}
	return s, nil
}
func (f *fakeStore) DeleteSubscription(_ context.Context, id int64) error {
	f.deleted = append(f.deleted, id)
	delete(f.subs, id)
	return nil
}
func (f *fakeStore) SubscriptionsOf(_ context.Context, users []int64) ([]Subscription, error) {
	var out []Subscription
	for _, s := range f.subs {
		for _, u := range users {
			if s.UserID == u {
				out = append(out, s)
			}
		}
	}
	return out, nil
}

type fakeChannels struct {
	ch  channel.Channel
	err error
}

func (f fakeChannels) Authorize(_ context.Context, _, _ int64, _ perm.Perm) (channel.Channel, perm.Member, error) {
	return f.ch, perm.Member{}, f.err
}

func (f fakeChannels) ViewableIDs(context.Context, int64, int64) ([]int64, error) {
	return []int64{f.ch.ID}, f.err
}

type fakePresence map[int64]string

func (f fakePresence) Status(id int64) string {
	if s, ok := f[id]; ok {
		return s
	}
	return presence.StatusOffline
}

type pubLog struct {
	mu  sync.Mutex
	evs []events.Event
}

func (p *pubLog) Publish(e events.Event) { p.mu.Lock(); p.evs = append(p.evs, e); p.mu.Unlock() }

type fakeQueue struct{ args []PushArgs }

func (q *fakeQueue) EnqueuePush(_ context.Context, a []PushArgs) error {
	q.args = append(q.args, a...)
	return nil
}

type fakeSender struct {
	status int
	err    error
	calls  int
	last   []byte
}

func (f *fakeSender) Send(_ context.Context, _ Subscription, payload []byte) (int, error) {
	f.calls++
	f.last = payload
	return f.status, f.err
}

type seqIDs struct{ n int64 }

func (s *seqIDs) Next() int64 { s.n++; return s.n }

type fixture struct {
	svc    *Service
	store  *fakeStore
	pub    *pubLog
	queue  *fakeQueue
	sender *fakeSender
	pres   fakePresence
}

func newFixture(t *testing.T, push bool) *fixture {
	t.Helper()
	f := &fixture{store: newFakeStore(), pub: &pubLog{}, queue: &fakeQueue{}, sender: &fakeSender{status: 201}, pres: fakePresence{}}
	d := Deps{
		Store: f.store, Channels: fakeChannels{ch: channel.Channel{ID: 300, Type: channel.TypeText, GuildID: ptr(int64(100))}},
		Presence: f.pres, Pub: f.pub, IDs: &seqIDs{},
	}
	if push {
		d.Push = PushConfig{PublicKey: "k", PrivateKey: "p", Subject: "mailto:a@b"}
		d.Sender, d.Queue = f.sender, f.queue
		d.Policy = EndpointPolicy{Resolver: fakeResolver{"push.example": {"8.8.8.8"}}}
	}
	f.svc = NewService(d)
	return f
}

func msgEvent(guild int64, channelID, author, id int64, mentions ...int64) events.Event {
	ms := make([]string, len(mentions))
	for i, m := range mentions {
		ms[i] = strconv.FormatInt(m, 10)
	}
	return events.Event{
		Type: events.MessageCreate, GuildID: guild, ChannelID: channelID,
		Data: message.MessagePayload{
			ID: strconv.FormatInt(id, 10), ChannelID: strconv.FormatInt(channelID, 10),
			Author: message.AuthorPayload{ID: strconv.FormatInt(author, 10)}, MentionIDs: ms,
		},
	}
}

// ---- Ack ----

func TestAckPublishesToOwnUserTopic(t *testing.T) {
	f := newFixture(t, false)
	f.store.ackResult = [2]int64{900, 0}
	up, err := f.svc.Ack(context.Background(), 7, 300, 901)
	if err != nil {
		t.Fatal(err)
	}
	if up != (UpdatePayload{ChannelID: "300", LastReadMessageID: "900", MentionCount: 0}) {
		t.Fatalf("got %+v", up)
	}
	if len(f.pub.evs) != 1 || f.pub.evs[0].Type != events.ReadStateUpdate || f.pub.evs[0].Topics[0] != "user:7" || f.pub.evs[0].GuildID != 100 {
		t.Fatalf("eventos: %+v", f.pub.evs)
	}
	if f.store.acks[0] != (ackCall{7, 300, 901}) {
		t.Fatalf("store: %+v", f.store.acks)
	}
}

func TestAckRules(t *testing.T) {
	f := newFixture(t, false)
	if _, err := f.svc.Ack(context.Background(), 7, 300, 0); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("message_id 0: %v", err)
	}
	f.svc.Channels = fakeChannels{err: channel.ErrNotFound}
	if _, err := f.svc.Ack(context.Background(), 7, 300, 1); !errors.Is(err, channel.ErrNotFound) {
		t.Fatalf("sem acesso: %v", err)
	}
	f.svc.Channels = fakeChannels{ch: channel.Channel{ID: 301, Type: channel.TypeVoice, GuildID: ptr(int64(100))}}
	if _, err := f.svc.Ack(context.Background(), 7, 301, 1); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("canal de voz: %v", err)
	}
	f.svc.Channels = fakeChannels{ch: channel.Channel{ID: 500, Type: channel.TypeDM}}
	if _, err := f.svc.Ack(context.Background(), 7, 500, 1); err != nil {
		t.Fatalf("DM: %v", err)
	}
	if n := len(f.pub.evs); n != 1 || f.pub.evs[0].GuildID != 0 {
		t.Fatalf("DM publica sem guild: %+v", f.pub.evs)
	}
	if len(f.store.acks) != 1 {
		t.Fatalf("só o ack da DM chega ao store: %+v", f.store.acks)
	}
}

// ---- Resolve ----

func TestResolveSortsDedupesAndCaps(t *testing.T) {
	f := newFixture(t, false)
	ch := channel.Channel{ID: 300, GuildID: ptr(int64(100))}
	if ids, err := f.svc.Resolve(context.Background(), ch, 1, "sem menção"); err != nil || ids != nil {
		t.Fatalf("sem @: %v %v", ids, err)
	}
	f.store.resolved = []int64{9, 3, 3, 5}
	ids, err := f.svc.Resolve(context.Background(), ch, 1, "oi @a1 @b2")
	if err != nil || fmt.Sprint(ids) != "[3 5 9]" {
		t.Fatalf("ids %v err %v", ids, err)
	}
	f.store.resolved = nil
	for i := 1; i <= 30; i++ {
		f.store.resolved = append(f.store.resolved, int64(100-i))
	}
	if ids, _ := f.svc.Resolve(context.Background(), ch, 1, "@aa"); len(ids) != MaxMentions || ids[0] != 70 {
		t.Fatalf("limite de 20: %d %v", len(ids), ids)
	}
	f.store.resolveErr = errors.New("db fora")
	if _, err := f.svc.Resolve(context.Background(), ch, 1, "@aa"); err == nil {
		t.Fatal("erro do banco deve subir")
	}
	dm := channel.Channel{ID: 500} // sem guild: usa a consulta de DM
	f.store.resolveErr, f.store.resolved = nil, []int64{4}
	if ids, _ := f.svc.Resolve(context.Background(), dm, 1, "@aa"); fmt.Sprint(ids) != "[4]" {
		t.Fatal(ids)
	}
}

// ---- MESSAGE_CREATE ----

func TestOnMessageGuildWithoutMentionOnlyAdvancesAuthor(t *testing.T) {
	f := newFixture(t, true)
	if err := f.svc.onMessage(context.Background(), msgEvent(100, 300, 1, 901)); err != nil {
		t.Fatal(err)
	}
	if len(f.store.acks) != 1 || f.store.acks[0] != (ackCall{1, 300, 901}) {
		t.Fatalf("o autor deve ter a leitura avançada: %+v", f.store.acks)
	}
	if len(f.store.mentionLog) != 0 || len(f.pub.evs) != 0 || len(f.queue.args) != 0 {
		t.Fatalf("mensagem comum em servidor não notifica: %+v %+v %+v", f.store.mentionLog, f.pub.evs, f.queue.args)
	}
}

func TestOnMessageMentionCountsAndPushesOnlyOfflineWithSubscription(t *testing.T) {
	f := newFixture(t, true)
	f.store.subs[1] = Subscription{ID: 1, UserID: 2} // offline, inscrito
	f.store.subs[2] = Subscription{ID: 2, UserID: 3} // online: sem push
	f.store.subs[3] = Subscription{ID: 3, UserID: 4} // offline mas sem mencionado: nada
	f.pres[3] = presence.StatusIdle                  // idle conta como ativo
	// mencionados: 2, 3 e o próprio autor (1) por engano no payload
	if err := f.svc.onMessage(context.Background(), msgEvent(100, 300, 1, 901, 2, 3, 1)); err != nil {
		t.Fatal(err)
	}
	if len(f.store.mentionLog) != 1 || fmt.Sprint(f.store.mentionLog[0].users) != "[2 3]" || *f.store.mentionLog[0].guild != 100 {
		t.Fatalf("menções somadas a quem não é o autor: %+v", f.store.mentionLog)
	}
	if len(f.pub.evs) != 2 || f.pub.evs[0].Topics[0] != "user:2" || f.pub.evs[1].Topics[0] != "user:3" {
		t.Fatalf("READ_STATE_UPDATE por mencionado: %+v", f.pub.evs)
	}
	if len(f.queue.args) != 1 || f.queue.args[0] != (PushArgs{SubscriptionID: 1, MessageID: 901, ChannelID: 300}) {
		t.Fatalf("push só para o offline inscrito: %+v", f.queue.args)
	}
}

func TestOnMessageDMNotifiesEveryoneButAuthor(t *testing.T) {
	f := newFixture(t, true)
	f.store.recipients[500] = []int64{1, 2, 3}
	f.store.subs[1] = Subscription{ID: 1, UserID: 1}
	f.store.subs[2] = Subscription{ID: 2, UserID: 2}
	f.store.subs[3] = Subscription{ID: 3, UserID: 3}
	f.pres[3] = presence.StatusOnline
	if err := f.svc.onMessage(context.Background(), msgEvent(0, 500, 1, 901)); err != nil {
		t.Fatal(err)
	}
	if len(f.store.mentionLog) != 1 || fmt.Sprint(f.store.mentionLog[0].users) != "[2 3]" || f.store.mentionLog[0].guild != nil {
		t.Fatalf("DM soma para os outros: %+v", f.store.mentionLog)
	}
	if len(f.queue.args) != 1 || f.queue.args[0].SubscriptionID != 2 {
		t.Fatalf("push: %+v", f.queue.args)
	}
}

func TestOnMessageWithPushDisabledNeverEnqueues(t *testing.T) {
	f := newFixture(t, false)
	f.store.recipients[500] = []int64{1, 2}
	f.store.subs[1] = Subscription{ID: 1, UserID: 2}
	if f.svc.PushEnabled() {
		t.Fatal("push deveria estar desligado")
	}
	if err := f.svc.onMessage(context.Background(), msgEvent(0, 500, 1, 901)); err != nil {
		t.Fatal(err)
	}
	if len(f.store.mentionLog) != 1 || len(f.queue.args) != 0 {
		t.Fatalf("a menção conta, o push não: %+v %+v", f.store.mentionLog, f.queue.args)
	}
}

func TestOnMessageIgnoresOtherPayloads(t *testing.T) {
	f := newFixture(t, true)
	if err := f.svc.onMessage(context.Background(), events.Event{Type: events.MessageCreate, Data: "x"}); err != nil {
		t.Fatal(err)
	}
	if len(f.store.acks) != 0 {
		t.Fatal("não deveria agir")
	}
}

// ---- entrega do push ----

func pushFixture(t *testing.T) *fixture {
	f := newFixture(t, true)
	f.store.subs[1] = Subscription{ID: 1, UserID: 2, Endpoint: "https://push.example/x"}
	f.store.pctx[901] = PushContext{Content: "oi", Username: "ana", ChannelName: "geral", GuildID: ptr(int64(100)), GuildName: "HQ"}
	return f
}

func TestDeliverResults(t *testing.T) {
	args := PushArgs{SubscriptionID: 1, MessageID: 901, ChannelID: 300}
	ctx := context.Background()

	f := pushFixture(t)
	if res, err := f.svc.deliver(ctx, args); res != resSent || err != nil || f.sender.calls != 1 {
		t.Fatalf("enviado: %s %v", res, err)
	}
	if string(f.sender.last) != `{"title":"ana (#geral · HQ)","body":"oi","url":"/channels/100/300","tag":"300"}` {
		t.Fatalf("payload: %s", f.sender.last)
	}

	for _, status := range []int{404, 410} {
		f = pushFixture(t)
		f.sender.status = status
		if res, err := f.svc.deliver(ctx, args); res != resRemoved || err != nil || len(f.store.deleted) != 1 {
			t.Fatalf("%d: %s %v %v", status, res, err, f.store.deleted)
		}
	}
	for _, status := range []int{429, 500, 503} {
		f = pushFixture(t)
		f.sender.status = status
		if res, err := f.svc.deliver(ctx, args); res != resFailed || err == nil || errors.Is(err, errPermanent) || len(f.store.deleted) != 0 {
			t.Fatalf("%d deve retentar sem apagar: %s %v", status, res, err)
		}
	}
	f = pushFixture(t)
	f.sender.status = 403
	if res, err := f.svc.deliver(ctx, args); res != resFailed || !errors.Is(err, errPermanent) {
		t.Fatalf("403 é definitivo: %s %v", res, err)
	}
	f = pushFixture(t)
	f.sender.err = errors.New("timeout")
	if res, err := f.svc.deliver(ctx, args); res != resFailed || err == nil || errors.Is(err, errPermanent) {
		t.Fatalf("timeout retenta: %s %v", res, err)
	}
	f = pushFixture(t)
	f.sender.err = fmt.Errorf("enviar: %w", ErrBlockedAddress)
	if res, err := f.svc.deliver(ctx, args); res != resRemoved || err != nil || len(f.store.deleted) != 1 {
		t.Fatalf("SSRF no envio remove a inscrição: %s %v", res, err)
	}
}

func TestDeliverSkips(t *testing.T) {
	args := PushArgs{SubscriptionID: 1, MessageID: 901, ChannelID: 300}
	ctx := context.Background()
	f := pushFixture(t)
	f.pres[2] = presence.StatusOnline // voltou antes da retentativa
	if res, err := f.svc.deliver(ctx, args); res != resSkipped || err != nil || f.sender.calls != 0 {
		t.Fatalf("online: %s %v", res, err)
	}
	f = pushFixture(t)
	delete(f.store.pctx, 901) // mensagem apagada
	if res, _ := f.svc.deliver(ctx, args); res != resSkipped || f.sender.calls != 0 {
		t.Fatalf("mensagem apagada: %s", res)
	}
	f = pushFixture(t)
	delete(f.store.subs, 1) // inscrição removida
	if res, _ := f.svc.deliver(ctx, args); res != resSkipped || f.sender.calls != 0 {
		t.Fatalf("sem inscrição: %s", res)
	}
}

// ---- inscrições ----

func TestSubscribeValidation(t *testing.T) {
	ctx := context.Background()
	p, a := newBrowserKeys(t)

	off := newFixture(t, false)
	if err := off.svc.Subscribe(ctx, 1, "https://push.example/x", p, a); !apperr.IsKind(err, apperr.KindUnavailable) {
		t.Fatalf("desligado: %v", err)
	}
	if _, err := off.svc.VAPIDPublicKey(1); !apperr.IsKind(err, apperr.KindUnavailable) {
		t.Fatalf("chave desligado: %v", err)
	}

	f := newFixture(t, true)
	if err := f.svc.Subscribe(ctx, 1, "https://push.example/x", p, a); err != nil {
		t.Fatal(err)
	}
	if f.store.subLimit != MaxSubscriptions || len(f.store.subs) != 1 {
		t.Fatalf("limite %d subs %d", f.store.subLimit, len(f.store.subs))
	}
	if err := f.svc.Subscribe(ctx, 1, "http://push.example/x", p, a); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("http: %v", err)
	}
	if err := f.svc.Subscribe(ctx, 1, "https://127.0.0.1/x", p, a); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("loopback: %v", err)
	}
	if err := f.svc.Subscribe(ctx, 1, "https://push.example/x", "ruim", a); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("chaves: %v", err)
	}
	if key, err := f.svc.VAPIDPublicKey(1); err != nil || key != "k" {
		t.Fatalf("chave pública: %q %v", key, err)
	}
}

type denyLimiter struct{}

func (denyLimiter) Take(string) (bool, time.Duration) { return false, 3 * time.Second }

func TestPushEndpointsAreRateLimited(t *testing.T) {
	f := newFixture(t, true)
	f.svc.Limiter = denyLimiter{}
	p, a := newBrowserKeys(t)
	if err := f.svc.Subscribe(context.Background(), 1, "https://push.example/x", p, a); !apperr.IsKind(err, apperr.KindRateLimited) {
		t.Fatalf("subscribe: %v", err)
	}
	if err := f.svc.Unsubscribe(context.Background(), 1, "https://push.example/x"); !apperr.IsKind(err, apperr.KindRateLimited) {
		t.Fatalf("unsubscribe: %v", err)
	}
	if _, err := f.svc.VAPIDPublicKey(1); !apperr.IsKind(err, apperr.KindRateLimited) {
		t.Fatalf("chave: %v", err)
	}
}

// ---- fila do barramento ----

type fakeBus struct{ fn func(events.Event) }

func (b *fakeBus) Subscribe(fn func(events.Event)) func() { b.fn = fn; return func() {} }

func TestStartProcessesOnlyMessageCreateAndStopDrains(t *testing.T) {
	f := newFixture(t, false)
	bus := &fakeBus{}
	f.svc.Start(context.Background(), bus)
	bus.fn(events.Event{Type: events.MessageUpdate, Data: msgEvent(100, 300, 1, 5).Data})
	bus.fn(msgEvent(100, 300, 1, 901))
	bus.fn(msgEvent(100, 300, 2, 902))
	f.svc.Stop()
	f.svc.Stop() // idempotente
	f.store.mu.Lock()
	defer f.store.mu.Unlock()
	if len(f.store.acks) != 2 {
		t.Fatalf("Stop deve esperar os eventos já enfileirados (2 acks do autor), got %d", len(f.store.acks))
	}
}

func TestMemberRemoveDropsReadStates(t *testing.T) {
	f := newFixture(t, false)
	bus := &fakeBus{}
	f.svc.Start(context.Background(), bus)
	bus.fn(events.Event{Type: events.GuildMemberRemove, GuildID: 100, Data: guild.MemberRemovePayload{GuildID: "100", UserID: "7"}})
	f.svc.Stop()
	if len(f.store.leftGuilds) != 1 || f.store.leftGuilds[0] != [2]int64{100, 7} {
		t.Fatalf("got %v", f.store.leftGuilds)
	}
}
