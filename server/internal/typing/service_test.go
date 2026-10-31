package typing

import (
	"context"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

type fakeChannels struct {
	chans map[int64]channel.Channel
	need  perm.Perm
	deny  bool
}

func (f *fakeChannels) Authorize(_ context.Context, _, id int64, need perm.Perm) (channel.Channel, perm.Member, error) {
	f.need = need
	c, ok := f.chans[id]
	if !ok || f.deny {
		return channel.Channel{}, perm.Member{}, channel.ErrNotFound
	}
	return c, perm.Member{}, nil
}

// fakeLimiter permite 1 chave por "janela"; reset() abre a janela seguinte.
type fakeLimiter struct{ used map[string]bool }

func (l *fakeLimiter) Take(key string) (bool, time.Duration) {
	if l.used[key] {
		return false, time.Second
	}
	l.used[key] = true
	return true, 0
}

type rec struct{ evs []events.Event }

func (r *rec) Publish(ev events.Event) { r.evs = append(r.evs, ev) }

func setup() (*Service, *fakeChannels, *fakeLimiter, *rec) {
	gid := int64(10)
	ch := &fakeChannels{chans: map[int64]channel.Channel{
		1: {ID: 1, Type: channel.TypeText, GuildID: &gid},
		2: {ID: 2, Type: channel.TypeVoice, GuildID: &gid},
		3: {ID: 3, Type: channel.TypeDM},
	}}
	lim, r := &fakeLimiter{used: map[string]bool{}}, &rec{}
	s := NewService(ch, lim, r)
	s.now = func() time.Time { return time.Unix(1700000000, 0) }
	return s, ch, lim, r
}

func TestStartPublishesToChannelTopic(t *testing.T) {
	s, ch, _, r := setup()
	ok, err := s.Start(context.Background(), 5, 1)
	if err != nil || !ok || len(r.evs) != 1 {
		t.Fatalf("ok=%v err=%v evs=%d", ok, err, len(r.evs))
	}
	ev := r.evs[0]
	p := ev.Data.(StartPayload)
	if ev.Type != events.TypingStart || ev.Topics[0] != "channel:1" || ev.GuildID != 10 ||
		p.UserID != "5" || p.ChannelID != "1" || p.GuildID == nil || *p.GuildID != "10" || p.Timestamp != 1700000000 {
		t.Fatalf("evento = %+v", ev)
	}
	if ch.need != perm.SendMessages {
		t.Fatal("deve exigir SEND_MESSAGES (poder escrever no canal)")
	}
}

func TestStartInDMHasNoGuild(t *testing.T) {
	s, _, _, r := setup()
	if ok, err := s.Start(context.Background(), 5, 3); err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	p := r.evs[0].Data.(StartPayload)
	if p.GuildID != nil || r.evs[0].GuildID != 0 {
		t.Fatalf("DM não tem guild_id: %+v", p)
	}
}

func TestThrottleIgnoresExcessPerUserAndChannel(t *testing.T) {
	s, _, lim, r := setup()
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		ok, err := s.Start(ctx, 5, 1)
		if err != nil || ok != (i == 0) {
			t.Fatalf("chamada %d: ok=%v err=%v", i, ok, err)
		}
	}
	if len(r.evs) != 1 {
		t.Fatalf("esperava 1 evento, vieram %d", len(r.evs))
	}
	// outro usuário e outro canal têm balde próprio
	if ok, _ := s.Start(ctx, 6, 1); !ok {
		t.Fatal("outro usuário não é limitado")
	}
	if ok, _ := s.Start(ctx, 5, 3); !ok {
		t.Fatal("outro canal não é limitado")
	}
	lim.used = map[string]bool{} // passou a janela
	if ok, _ := s.Start(ctx, 5, 1); !ok {
		t.Fatal("depois da janela volta a publicar")
	}
}

func TestStartRejectsUnauthorizedAndNonTextChannels(t *testing.T) {
	s, ch, _, r := setup()
	if _, err := s.Start(context.Background(), 5, 99); err == nil {
		t.Fatal("canal inexistente deveria falhar")
	}
	ch.deny = true
	if _, err := s.Start(context.Background(), 5, 1); err == nil {
		t.Fatal("sem acesso deveria falhar")
	}
	ch.deny = false
	if _, err := s.Start(context.Background(), 5, 2); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("canal de voz deveria dar 422: %v", err)
	}
	if len(r.evs) != 0 {
		t.Fatal("nada deveria ser publicado")
	}
}
