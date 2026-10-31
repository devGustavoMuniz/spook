package gateway

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

type fakeDMs struct {
	mu  sync.Mutex
	dms map[int64][]channel.Channel
	err error
}

func (f *fakeDMs) List(_ context.Context, u int64) ([]channel.Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dms[u], f.err
}

type presCall struct {
	op   string
	user int64
	sess string
	idle bool
}

type fakePresence struct {
	mu    sync.Mutex
	calls []presCall
	snap  []presence.UpdatePayload
	err   error
}

func (f *fakePresence) add(c presCall) { f.mu.Lock(); f.calls = append(f.calls, c); f.mu.Unlock() }

func (f *fakePresence) Connect(u int64, s string) { f.add(presCall{op: "connect", user: u, sess: s}) }
func (f *fakePresence) Disconnect(u int64, s string) {
	f.add(presCall{op: "disconnect", user: u, sess: s})
}
func (f *fakePresence) SetIdle(u int64, s string, i bool) {
	f.add(presCall{op: "idle", user: u, sess: s, idle: i})
}
func (f *fakePresence) Snapshot(context.Context, int64) ([]presence.UpdatePayload, error) {
	return f.snap, f.err
}

func (f *fakePresence) Self(context.Context, int64) (presence.SelfPayload, error) {
	return presence.SelfPayload{StatusPref: presence.PrefOnline}, nil
}

func (f *fakePresence) ops() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = c.op
	}
	return out
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("não atingiu a tempo: %s", what)
}

func dmChannel(id int64) channel.Channel {
	return channel.Channel{ID: id, Type: channel.TypeDM, Recipients: []channel.Recipient{{ID: 1, Username: "a"}, {ID: 2, Username: "b"}}}
}

func TestReadyCarriesPrivateChannelsAndPresences(t *testing.T) {
	dms := &fakeDMs{dms: map[int64][]channel.Channel{1: {dmChannel(500)}}}
	pres := &fakePresence{snap: []presence.UpdatePayload{{UserID: "2", Status: "idle"}}}
	r := newRig(t, fastCfg(), WithDMs(dms), WithPresence(pres))
	_, ready := r.dial("tok-1").identify()
	var d struct {
		PrivateChannels []channel.ChannelPayload `json:"private_channels"`
		Presences       []presence.UpdatePayload `json:"presences"`
	}
	if err := json.Unmarshal(ready.D, &d); err != nil {
		t.Fatal(err)
	}
	if len(d.PrivateChannels) != 1 || d.PrivateChannels[0].ID != "500" || len(d.PrivateChannels[0].Recipients) != 2 {
		t.Fatalf("private_channels = %+v", d.PrivateChannels)
	}
	if len(d.Presences) != 1 || d.Presences[0].UserID != "2" || d.Presences[0].Status != "idle" {
		t.Fatalf("presences = %+v", d.Presences)
	}
}

func TestReadyWithoutDMsOrPresenceHasEmptyArrays(t *testing.T) {
	r := newRig(t, fastCfg())
	_, ready := r.dial("tok-1").identify()
	var d map[string]json.RawMessage
	_ = json.Unmarshal(ready.D, &d)
	if string(d["private_channels"]) != "[]" || string(d["presences"]) != "[]" {
		t.Fatalf("arrays vazios, não nulos: %s %s", d["private_channels"], d["presences"])
	}
}

func TestPresenceSnapshotFailureStillSendsReady(t *testing.T) {
	pres := &fakePresence{err: context.DeadlineExceeded}
	r := newRig(t, fastCfg(), WithPresence(pres))
	_, ready := r.dial("tok-1").identify()
	var d map[string]json.RawMessage
	_ = json.Unmarshal(ready.D, &d)
	if string(d["presences"]) != "[]" {
		t.Fatalf("presences = %s", d["presences"])
	}
}

func TestDMSubscriptionLifecycle(t *testing.T) {
	dms := &fakeDMs{dms: map[int64][]channel.Channel{1: {dmChannel(500)}}}
	r := newRig(t, fastCfg(), WithDMs(dms))
	c1, c2 := r.dial("tok-1"), r.dial("tok-2")
	c1.identify()
	c2.identify()

	msg := func(ch int64) {
		r.bus.Publish(events.Event{Type: events.MessageCreate, ChannelID: ch, Topics: []string{channelTopic(ch)}, Data: map[string]string{"id": "1"}})
	}
	chEvent := func(typ string, ch int64, users ...int64) {
		topics := make([]string, len(users))
		for i, u := range users {
			topics[i] = userTopic(u)
		}
		r.bus.Publish(events.Event{Type: typ, ChannelID: ch, Topics: topics, Data: dmChannel(ch).Payload()})
	}

	// no IDENTIFY a sessão assina as DMs; quem não participa não recebe
	msg(500)
	c1.expectEvent("MESSAGE_CREATE")
	c2.expectNone(100 * time.Millisecond)

	// CHANNEL_CREATE em user:<id> assina o canal novo
	chEvent(events.ChannelCreate, 501, 2)
	c2.expectEvent("CHANNEL_CREATE")
	msg(501)
	c2.expectEvent("MESSAGE_CREATE")
	c1.expectNone(100 * time.Millisecond)

	// CHANNEL_UPDATE também assina (participante adicionado a uma DM existente)
	chEvent(events.ChannelUpdate, 502, 2)
	c2.expectEvent("CHANNEL_UPDATE")
	msg(502)
	c2.expectEvent("MESSAGE_CREATE")

	// CHANNEL_DELETE entrega e cancela: removido não recebe mais nada
	chEvent(events.ChannelDelete, 501, 2)
	c2.expectEvent("CHANNEL_DELETE")
	msg(501)
	msg(502) // continua participante de 502
	f := c2.expectEvent("MESSAGE_CREATE")
	var m map[string]string
	_ = json.Unmarshal(f.D, &m)
	c2.expectNone(100 * time.Millisecond)
}

func TestPresenceHooksFollowTheSocket(t *testing.T) {
	pres := &fakePresence{}
	r := newRig(t, fastCfg(), WithPresence(pres))
	c := r.dial("tok-1")
	sid, _ := c.identify()
	eventually(t, "connect", func() bool { return len(pres.ops()) == 1 })

	c.send(OpPresence, SetPresence{Status: "idle"})
	eventually(t, "idle", func() bool {
		pres.mu.Lock()
		defer pres.mu.Unlock()
		return len(pres.calls) == 2 && pres.calls[1].op == "idle" && pres.calls[1].idle && pres.calls[1].sess == sid && pres.calls[1].user == 1
	})
	c.send(OpPresence, SetPresence{Status: "online"})
	eventually(t, "online", func() bool {
		pres.mu.Lock()
		defer pres.mu.Unlock()
		return len(pres.calls) == 3 && !pres.calls[2].idle
	})

	_ = c.ws.Close(websocket.StatusNormalClosure, "")
	eventually(t, "disconnect", func() bool { return len(pres.ops()) == 4 && pres.ops()[3] == "disconnect" })

	// resume numa conexão nova: a sessão volta a contar como conectada
	c2 := r.dial("tok-1")
	if h := c2.mustRead(); h.Op != OpHello {
		t.Fatalf("hello: %+v", h)
	}
	c2.send(OpResume, Resume{SessionID: sid, Seq: 1})
	c2.expectEvent(EventResumed)
	eventually(t, "connect de novo", func() bool { return len(pres.ops()) == 5 && pres.ops()[4] == "connect" })
}

func TestPresenceOpValidation(t *testing.T) {
	pres := &fakePresence{}
	r := newRig(t, fastCfg(), WithPresence(pres))

	c := r.dial("tok-1")
	c.mustRead() // HELLO
	c.send(OpPresence, SetPresence{Status: "idle"})
	c.expectClose(CloseNotIdentified, 2*time.Second)

	c = r.dial("tok-1")
	c.identify()
	c.send(OpPresence, SetPresence{Status: "dnd"})
	c.expectClose(CloseUnknown, 2*time.Second)

	c = r.dial("tok-1")
	c.identify()
	c.send(OpPresence, nil)
	c.expectClose(CloseUnknown, 2*time.Second)
}

func TestPresenceOpIsIgnoredWithoutPresence(t *testing.T) {
	r := newRig(t, fastCfg())
	c := r.dial("tok-1")
	c.identify()
	c.send(OpPresence, SetPresence{Status: "idle"})
	c.send(OpHeartbeat, nil)
	if f := c.mustRead(); f.Op != OpAck {
		t.Fatalf("esperava ACK, veio %+v", f)
	}
}

func TestTypingFollowsViewChannelFilter(t *testing.T) {
	r := newRig(t, fastCfg())
	r.dir.setPerm(10, 1, 0) // membro sem VIEW_CHANNEL: o filtro de defesa vale também para TYPING_START
	r.dir.channels[10] = []int64{20}
	c := r.dial("tok-1")
	c.identify()
	r.bus.Publish(events.Event{Type: events.TypingStart, GuildID: 10, ChannelID: 20, Topics: []string{channelTopic(20)}, Data: map[string]string{}})
	c.expectNone(100 * time.Millisecond)
}
