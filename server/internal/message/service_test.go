package message

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

type recorder struct {
	mu  sync.Mutex
	evs []events.Event
}

func (r *recorder) Publish(e events.Event) { r.mu.Lock(); r.evs = append(r.evs, e); r.mu.Unlock() }

type fakeStore struct {
	msgs       map[int64]Message
	deleted    map[int64]bool
	inserts    int
	lastBefore int64
	lastLimit  int
}

func newFakeStore() *fakeStore {
	return &fakeStore{msgs: map[int64]Message{}, deleted: map[int64]bool{}}
}

func (f *fakeStore) Insert(_ context.Context, id, channelID, authorID int64, content string) (Message, error) {
	f.inserts++
	m := Message{ID: id, ChannelID: channelID, Content: content, Author: Author{ID: authorID, Username: "u"}}
	f.msgs[id] = m
	return m, nil
}

func (f *fakeStore) Get(_ context.Context, id, _ int64) (Message, error) {
	m, ok := f.msgs[id]
	if !ok || f.deleted[id] {
		return Message{}, ErrNotFound
	}
	return m, nil
}

func (f *fakeStore) List(_ context.Context, _, before int64, limit int) ([]Message, error) {
	f.lastBefore, f.lastLimit = before, limit
	var out []Message
	for i := int64(limit); i >= 1; i-- { // sempre devolve "limit" itens para exercitar has_more
		out = append(out, Message{ID: i, Author: Author{ID: 1}})
	}
	return out, nil
}

func (f *fakeStore) UpdateContent(_ context.Context, id, _ int64, content string) error {
	m, ok := f.msgs[id]
	if !ok || f.deleted[id] {
		return ErrNotFound
	}
	now := time.Now()
	m.Content, m.EditedAt = content, &now
	f.msgs[id] = m
	return nil
}

func (f *fakeStore) Delete(_ context.Context, id, _ int64) error {
	if _, ok := f.msgs[id]; !ok || f.deleted[id] {
		return ErrNotFound
	}
	f.deleted[id] = true
	return nil
}

type fakeChannels struct {
	ch     channel.Channel
	member perm.Member
	err    error
	need   perm.Perm
}

func (f *fakeChannels) Authorize(_ context.Context, _, _ int64, need perm.Perm) (channel.Channel, perm.Member, error) {
	f.need = need
	return f.ch, f.member, f.err
}

type fakeLimiter struct {
	ok   bool
	wait time.Duration
	keys []string
}

func (f *fakeLimiter) Take(key string) (bool, time.Duration) {
	f.keys = append(f.keys, key)
	return f.ok, f.wait
}

type noAvatars struct{}

func (noAvatars) AvatarURLForKey(context.Context, *string) string { return "" }

type seq struct{ n int64 }

func (s *seq) Next() int64 { s.n++; return 1000 + s.n }

func setup() (*Service, *fakeStore, *fakeChannels, *fakeLimiter, *recorder) {
	gid := int64(7)
	st, ch, lim, rec := newFakeStore(), &fakeChannels{
		ch:     channel.Channel{ID: 20, Type: channel.TypeText, GuildID: &gid},
		member: perm.NewMember(1, false, perm.DefaultEveryone, 0),
	}, &fakeLimiter{ok: true}, &recorder{}
	return NewService(st, ch, lim, noAvatars{}, &seq{}, rec), st, ch, lim, rec
}

func TestSendPublishesAndPersists(t *testing.T) {
	svc, st, ch, lim, rec := setup()
	m, err := svc.Send(context.Background(), 1, 20, "  olá  ")
	if err != nil {
		t.Fatal(err)
	}
	if m.Content != "olá" || m.ID == 0 || st.inserts != 1 {
		t.Fatalf("mensagem: %+v inserts=%d", m, st.inserts)
	}
	if ch.need != perm.SendMessages {
		t.Fatalf("deveria exigir SEND_MESSAGES, exigiu %b", ch.need)
	}
	if len(lim.keys) != 1 || lim.keys[0] != "msg:1:20" {
		t.Fatalf("chave do limitador: %v", lim.keys)
	}
	if len(rec.evs) != 1 {
		t.Fatalf("eventos: %v", rec.evs)
	}
	ev := rec.evs[0]
	if ev.Type != events.MessageCreate || ev.GuildID != 7 || ev.ChannelID != 20 || len(ev.Topics) != 1 || ev.Topics[0] != "channel:20" {
		t.Fatalf("evento: %+v", ev)
	}
	if p, ok := ev.Data.(MessagePayload); !ok || p.ID == "" || p.Content != "olá" {
		t.Fatalf("payload: %#v", ev.Data)
	}
}

func TestSendValidation(t *testing.T) {
	tests := []struct {
		name    string
		content string
		wantErr bool
	}{
		{"vazio", "", true},
		{"só espaços", "  \n\t  ", true},
		{"1 caractere", "a", false},
		{"2000 runes multibyte", strings.Repeat("é", 2000), false},
		{"2000 emojis", strings.Repeat("😀", 2000), false},
		{"2001 runes", strings.Repeat("é", 2001), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, st, _, _, rec := setup()
			_, err := svc.Send(context.Background(), 1, 20, tt.content)
			if tt.wantErr {
				if !apperr.IsKind(err, apperr.KindInvalid) || st.inserts != 0 || len(rec.evs) != 0 {
					t.Fatalf("esperava erro de validação sem efeitos, veio %v (inserts=%d)", err, st.inserts)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSendRejectsNonTextChannelAndAuthErrors(t *testing.T) {
	svc, st, ch, _, _ := setup()
	ch.ch.Type = channel.TypeVoice
	if _, err := svc.Send(context.Background(), 1, 20, "oi"); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("canal de voz: %v", err)
	}
	ch.ch.Type = channel.TypeText
	for _, want := range []error{channel.ErrNotFound, channel.ErrForbidden} {
		ch.err = want
		if _, err := svc.Send(context.Background(), 1, 20, "oi"); !errors.Is(err, want) {
			t.Fatalf("esperava %v, veio %v", want, err)
		}
	}
	if st.inserts != 0 {
		t.Fatal("não deveria gravar sem autorização")
	}
}

func TestSendRateLimited(t *testing.T) {
	svc, st, _, lim, rec := setup()
	lim.ok, lim.wait = false, 1500*time.Millisecond
	_, err := svc.Send(context.Background(), 1, 20, "oi")
	e, ok := apperr.As(err)
	if !ok || e.Kind != apperr.KindRateLimited || e.RetryAfter != 1500*time.Millisecond {
		t.Fatalf("esperava 429 com RetryAfter, veio %v", err)
	}
	if st.inserts != 0 || len(rec.evs) != 0 {
		t.Fatal("limitado não grava nem publica")
	}
}

func TestListClampsLimitAndComputesHasMore(t *testing.T) {
	svc, st, _, _, _ := setup()
	msgs, more, err := svc.List(context.Background(), 1, 20, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	// o service pede limit+1 ao store; o fake devolve exatamente isso
	if st.lastLimit != DefaultPageSize+1 || st.lastBefore != 1<<63-1 || len(msgs) != DefaultPageSize || !more {
		t.Fatalf("padrão: limit=%d before=%d len=%d more=%v", st.lastLimit, st.lastBefore, len(msgs), more)
	}
	if _, _, err := svc.List(context.Background(), 1, 20, 99, 5000); err != nil {
		t.Fatal(err)
	}
	if st.lastLimit != MaxPageSize+1 || st.lastBefore != 99 {
		t.Fatalf("limite deve ser limitado a %d: %d", MaxPageSize, st.lastLimit)
	}
}

func TestEditOnlyByAuthor(t *testing.T) {
	svc, st, ch, _, rec := setup()
	st.msgs[5] = Message{ID: 5, ChannelID: 20, Content: "antes", Author: Author{ID: 1}}

	ch.member = perm.NewMember(2, true, 0, 0) // até o dono do servidor não edita a dos outros
	if _, err := svc.Edit(context.Background(), 2, 20, 5, "x"); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("não-autor: %v", err)
	}
	ch.member = perm.NewMember(1, false, perm.DefaultEveryone, 0)
	m, err := svc.Edit(context.Background(), 1, 20, 5, "depois")
	if err != nil || m.Content != "depois" || m.EditedAt == nil {
		t.Fatalf("edição: %+v %v", m, err)
	}
	if len(rec.evs) != 1 || rec.evs[0].Type != events.MessageUpdate || rec.evs[0].Topics[0] != "channel:20" {
		t.Fatalf("eventos: %+v", rec.evs)
	}
	if _, err := svc.Edit(context.Background(), 1, 20, 5, "  "); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("vazio: %v", err)
	}
	st.deleted[5] = true
	if _, err := svc.Edit(context.Background(), 1, 20, 5, "ressuscitar"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("apagada deve dar 404: %v", err)
	}
}

func TestDeleteAuthorOrManageMessages(t *testing.T) {
	tests := []struct {
		name   string
		member perm.Member
		want   bool // true = esperava 403
	}{
		{"autor", perm.NewMember(1, false, perm.DefaultEveryone, 0), false},
		{"outro sem permissão", perm.NewMember(2, false, perm.DefaultEveryone, 0), true},
		{"outro com MANAGE_MESSAGES", perm.NewMember(2, false, perm.DefaultEveryone|perm.ManageMessages, 1), false},
		{"dono do servidor", perm.NewMember(2, true, 0, 0), false},
		{"administrador", perm.NewMember(2, false, perm.Administrator, 1), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, st, ch, _, rec := setup()
			st.msgs[5] = Message{ID: 5, ChannelID: 20, Author: Author{ID: 1}}
			ch.member = tt.member
			err := svc.Delete(context.Background(), tt.member.UserID, 20, 5)
			if tt.want {
				if !apperr.IsKind(err, apperr.KindForbidden) || st.deleted[5] {
					t.Fatalf("esperava 403 sem apagar, veio %v", err)
				}
				return
			}
			if err != nil || !st.deleted[5] {
				t.Fatalf("esperava apagar: %v", err)
			}
			if len(rec.evs) != 1 || rec.evs[0].Type != events.MessageDelete || rec.evs[0].GuildID != 7 || rec.evs[0].ChannelID != 20 {
				t.Fatalf("evento: %+v", rec.evs)
			}
			if p := rec.evs[0].Data.(DeletePayload); p.ID != "5" || p.GuildID != "7" || p.ChannelID != "20" {
				t.Fatalf("payload: %+v", p)
			}
			if err := svc.Delete(context.Background(), tt.member.UserID, 20, 5); !errors.Is(err, ErrNotFound) {
				t.Fatalf("apagar duas vezes: %v", err)
			}
		})
	}
}
