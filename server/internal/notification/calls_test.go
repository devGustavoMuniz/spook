package notification

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

type fakeBlocks struct{ blockers []int64 }

func (f fakeBlocks) BlockersOf(_ context.Context, _ int64, cands []int64) ([]int64, error) {
	var out []int64
	for _, c := range cands {
		if slices.Contains(f.blockers, c) {
			out = append(out, c)
		}
	}
	return out, nil
}

func TestBlockersDoNotCountMentionsOrGetPushInDMsAndServers(t *testing.T) {
	f := newFixture(t, true)
	f.svc.SetBlocks(fakeBlocks{blockers: []int64{2}}) // 2 bloqueou o autor (1)
	f.store.recipients[500] = []int64{1, 2, 3}
	f.store.subs[1] = Subscription{ID: 1, UserID: 2}
	f.store.subs[2] = Subscription{ID: 2, UserID: 3}
	if err := f.svc.onMessage(context.Background(), msgEvent(0, 500, 1, 901)); err != nil {
		t.Fatal(err)
	}
	if len(f.store.mentionLog) != 1 || fmt.Sprint(f.store.mentionLog[0].users) != "[3]" {
		t.Fatalf("DM em grupo: só 3 soma aviso: %+v", f.store.mentionLog)
	}
	if len(f.queue.args) != 1 || f.queue.args[0].SubscriptionID != 2 {
		t.Fatalf("push só para quem não bloqueou: %+v", f.queue.args)
	}
	// Servidor: a menção a 2 e 3 só vale para 3.
	f2 := newFixture(t, true)
	f2.svc.SetBlocks(fakeBlocks{blockers: []int64{2}})
	if err := f2.svc.onMessage(context.Background(), msgEvent(100, 300, 1, 902, 2, 3)); err != nil {
		t.Fatal(err)
	}
	if len(f2.store.mentionLog) != 1 || fmt.Sprint(f2.store.mentionLog[0].users) != "[3]" {
		t.Fatalf("menção: %+v", f2.store.mentionLog)
	}
}

func TestResolveDropsMentionsOfBlockers(t *testing.T) {
	f := newFixture(t, false)
	f.svc.SetBlocks(fakeBlocks{blockers: []int64{5}})
	f.store.resolved = []int64{3, 5, 9}
	ch := channel.Channel{ID: 500, Type: channel.TypeDM}
	res, err := f.svc.Resolve(context.Background(), ch, 1, "oi @a1 @b2 @c3", false)
	if err != nil || fmt.Sprint(res.UserIDs) != "[3 9]" {
		t.Fatalf("Resolve = %v %v", res.UserIDs, err)
	}
}

func TestCallRecipientsSkipsDNDAndMutedDM(t *testing.T) {
	f := newFixture(t, false)
	f.store.filters = map[int64]NotifyFilter{
		2: {DND: true},
		3: {Channel: &Setting{Muted: true}},
		4: {Channel: &Setting{Muted: true, MutedUntil: ptr(time.Now().Add(-time.Hour))}}, // silêncio vencido não vale
	}
	got, err := f.svc.CallRecipients(context.Background(), 500, []int64{2, 3, 4, 5})
	if err != nil || fmt.Sprint(got) != "[4 5]" {
		t.Fatalf("CallRecipients = %v %v", got, err)
	}
	if got, _ := f.svc.CallRecipients(context.Background(), 500, nil); len(got) != 0 {
		t.Fatal("sem candidatos")
	}
}

type fakeCallQueue struct {
	fakeQueue
	calls []CallPushArgs
}

func (q *fakeCallQueue) EnqueueCallPush(_ context.Context, a []CallPushArgs) error {
	q.calls = append(q.calls, a...)
	return nil
}

func TestPushCallOnlyForOfflineSubscribers(t *testing.T) {
	f := newFixture(t, true)
	q := &fakeCallQueue{}
	f.svc.Queue = q
	f.store.subs[1] = Subscription{ID: 1, UserID: 2} // offline
	f.store.subs[2] = Subscription{ID: 2, UserID: 3} // online: ouve pelo gateway
	f.store.subs[3] = Subscription{ID: 3, UserID: 4} // offline, mas não é destinatário
	f.pres[3] = presence.StatusOnline
	exp := time.Now().Add(45 * time.Second)
	f.svc.PushCall(context.Background(), "Maria", 500, []int64{2, 3}, exp)
	if len(q.calls) != 1 || q.calls[0].SubscriptionID != 1 || q.calls[0].CallerName != "Maria" || q.calls[0].ExpiresAt != exp.Unix() {
		t.Fatalf("pushes de chamada = %+v", q.calls)
	}
	// Push desligado ou sem fila de chamadas: nada acontece.
	f2 := newFixture(t, false)
	f2.svc.PushCall(context.Background(), "Maria", 500, []int64{2}, exp)
	f3 := newFixture(t, true) // fakeQueue comum não implementa CallPushQueue
	f3.store.subs[1] = Subscription{ID: 1, UserID: 2}
	f3.svc.PushCall(context.Background(), "Maria", 500, []int64{2}, exp)
}

func TestDeliverCallWithFakeSender(t *testing.T) {
	f := newFixture(t, true)
	f.store.subs[1] = Subscription{ID: 1, UserID: 2}
	args := CallPushArgs{SubscriptionID: 1, ChannelID: 500, CallerName: "Maria", ExpiresAt: time.Now().Add(30 * time.Second).Unix()}

	res, err := f.svc.deliverCall(context.Background(), args)
	if err != nil || res != resSent || f.sender.calls != 1 {
		t.Fatalf("envio = %s %v (chamadas %d)", res, err, f.sender.calls)
	}
	p := string(f.sender.last)
	for _, want := range []string{`"title":"Maria"`, "Chamada de voz recebida", `"url":"/channels/@me/500"`, `"tag":"call:500"`} {
		if !strings.Contains(p, want) {
			t.Fatalf("payload sem %s: %s", want, p)
		}
	}

	// Chamada que já parou de tocar, usuário que voltou a ficar online e inscrição apagada: descartados.
	old := args
	old.ExpiresAt = time.Now().Add(-time.Second).Unix()
	if res, _ := f.svc.deliverCall(context.Background(), old); res != resSkipped || f.sender.calls != 1 {
		t.Fatalf("expirado = %s", res)
	}
	f.pres[2] = presence.StatusOnline
	if res, _ := f.svc.deliverCall(context.Background(), args); res != resSkipped || f.sender.calls != 1 {
		t.Fatalf("online = %s", res)
	}
	delete(f.pres, 2)
	args.SubscriptionID = 99
	if res, _ := f.svc.deliverCall(context.Background(), args); res != resSkipped {
		t.Fatalf("sem inscrição = %s", res)
	}

	// 410 remove a inscrição; 503 pede nova tentativa; 400 é permanente.
	args.SubscriptionID = 1
	f.sender.status = 410
	if res, err := f.svc.deliverCall(context.Background(), args); res != resRemoved || err != nil || !slices.Contains(f.store.deleted, 1) {
		t.Fatalf("410 = %s %v", res, err)
	}
	f.store.subs[1] = Subscription{ID: 1, UserID: 2}
	f.sender.status = 503
	if res, err := f.svc.deliverCall(context.Background(), args); res != resFailed || err == nil || errors.Is(err, errPermanent) {
		t.Fatalf("503 = %s %v", res, err)
	}
	f.sender.status = 400
	if _, err := f.svc.deliverCall(context.Background(), args); !errors.Is(err, errPermanent) {
		t.Fatalf("400 deveria ser permanente: %v", err)
	}
}
