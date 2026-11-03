package message

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type recorder struct {
	mu  sync.Mutex
	evs []events.Event
}

func (r *recorder) Publish(e events.Event) { r.mu.Lock(); r.evs = append(r.evs, e); r.mu.Unlock() }

type fakeStore struct {
	pinMax     int // limite visto na última fixação
	msgs       map[int64]Message
	deleted    map[int64]bool
	inserts    int
	lastInsert InsertParams
	insertErr  error
	lastBefore int64
	lastLimit  int
	refCalls   int
	recentJoin map[int64]bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{msgs: map[int64]Message{}, deleted: map[int64]bool{}}
}

func (f *fakeStore) Insert(_ context.Context, p InsertParams) (Message, []attachment.Attachment, error) {
	f.inserts++
	f.lastInsert = p
	if f.insertErr != nil {
		return Message{}, nil, f.insertErr
	}
	m := Message{ID: p.ID, ChannelID: p.ChannelID, Content: p.Content, MentionIDs: p.MentionIDs, ReferenceID: p.ReferenceID, Kind: kindOrDefault(p.Kind), MentionEveryone: p.MentionEveryone, MentionHere: p.MentionHere, MentionRoleIDs: p.MentionRoleIDs, Author: Author{ID: p.AuthorID, Username: "u"}}
	f.msgs[p.ID] = m
	var atts []attachment.Attachment
	for _, id := range p.AttachmentIDs {
		atts = append(atts, attachment.Attachment{ID: id, Filename: "f.png", ContentType: "image/png", Size: 3})
	}
	return m, atts, nil
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

// References devolve a prévia das mensagens do canal 20 (o fake só tem esse canal) incluindo as apagadas.
func (f *fakeStore) References(_ context.Context, channelID int64, ids []int64) (map[int64]Reply, error) {
	f.refCalls++
	out := map[int64]Reply{}
	for _, id := range ids {
		m, ok := f.msgs[id]
		if !ok || m.ChannelID != channelID {
			continue
		}
		r := Reply{ID: id, Author: m.Author, Deleted: f.deleted[id], Kind: m.Kind}
		if !r.Deleted {
			r.Content = truncateRunes(m.Content, ReplyPreviewRunes)
		}
		out[id] = r
	}
	return out, nil
}

func (f *fakeStore) ListPinned(context.Context, int64, int) ([]Message, error) {
	var out []Message
	for id, m := range f.msgs {
		if m.PinnedAt != nil && !f.deleted[id] {
			out = append(out, m)
		}
	}
	slices.SortFunc(out, func(a, b Message) int { return b.PinnedAt.Compare(*a.PinnedAt) })
	return out, nil
}

func (f *fakeStore) Pin(_ context.Context, id, _, _ int64, max int) (bool, error) {
	f.pinMax = max
	n := 0
	for mid, m := range f.msgs {
		if m.PinnedAt != nil && !f.deleted[mid] {
			n++
		}
	}
	m := f.msgs[id]
	if m.PinnedAt != nil || n >= max {
		return false, nil
	}
	now := time.Now()
	m.PinnedAt = &now
	f.msgs[id] = m
	return true, nil
}

func (f *fakeStore) HasRecentJoin(_ context.Context, _, u int64) (bool, error) {
	return f.recentJoin[u], nil
}

func (f *fakeStore) Unpin(_ context.Context, id, _ int64) (bool, error) {
	m := f.msgs[id]
	if m.PinnedAt == nil {
		return false, nil
	}
	m.PinnedAt = nil
	f.msgs[id] = m
	return true, nil
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

func (f *fakeChannels) Get(context.Context, int64) (channel.Channel, error) { return f.ch, f.err }

type fakeAtts struct {
	verifyErr error
	verified  [][]int64
	byMsg     map[int64][]attachment.AttachmentPayload
	listCalls int
}

func (f *fakeAtts) Verify(_ context.Context, _, _ int64, ids []int64) error {
	f.verified = append(f.verified, ids)
	return f.verifyErr
}

func (f *fakeAtts) Payloads(_ context.Context, as []attachment.Attachment) ([]attachment.AttachmentPayload, error) {
	out := make([]attachment.AttachmentPayload, len(as))
	for i, a := range as {
		out[i] = attachment.AttachmentPayload{ID: strconv.FormatInt(a.ID, 10), Filename: a.Filename, URL: "http://x/" + a.Filename}
	}
	return out, nil
}

func (f *fakeAtts) ForMessages(_ context.Context, ids []int64) (map[int64][]attachment.AttachmentPayload, error) {
	f.listCalls++
	return f.byMsg, nil
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

func setupAtts() (*Service, *fakeStore, *fakeChannels, *fakeAtts, *recorder) {
	svc, st, ch, _, rec := setup()
	fa := &fakeAtts{}
	svc.atts = fa
	return svc, st, ch, fa, rec
}

func setup() (*Service, *fakeStore, *fakeChannels, *fakeLimiter, *recorder) {
	gid := int64(7)
	st, ch, lim, rec := newFakeStore(), &fakeChannels{
		ch:     channel.Channel{ID: 20, Type: channel.TypeText, GuildID: &gid},
		member: perm.NewMember(1, false, perm.DefaultEveryone, 0),
	}, &fakeLimiter{ok: true}, &recorder{}
	return NewService(st, ch, lim, noAvatars{}, &fakeAtts{}, &seq{}, rec), st, ch, lim, rec
}

func TestSendPublishesAndPersists(t *testing.T) {
	svc, st, ch, lim, rec := setup()
	m, err := svc.Send(context.Background(), 1, 20, "  olá  ", nil, SendOptions{})
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
			_, err := svc.Send(context.Background(), 1, 20, tt.content, nil, SendOptions{})
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
	if _, err := svc.Send(context.Background(), 1, 20, "oi", nil, SendOptions{}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("canal de voz: %v", err)
	}
	ch.ch.Type = channel.TypeText
	for _, want := range []error{channel.ErrNotFound, channel.ErrForbidden} {
		ch.err = want
		if _, err := svc.Send(context.Background(), 1, 20, "oi", nil, SendOptions{}); !errors.Is(err, want) {
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
	_, err := svc.Send(context.Background(), 1, 20, "oi", nil, SendOptions{})
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

func dmSetup() (*Service, *fakeStore, *fakeChannels, *recorder) {
	svc, st, ch, _, rec := setup()
	ch.ch = channel.Channel{ID: 30, Type: channel.TypeDM} // DM: sem servidor
	ch.member = perm.Member{}
	return svc, st, ch, rec
}

func TestSendInDMPublishesWithoutGuild(t *testing.T) {
	svc, st, _, rec := dmSetup()
	for _, typ := range []channel.Type{channel.TypeDM, channel.TypeGroupDM} {
		rec.evs = nil
		svc.channels.(*fakeChannels).ch.Type = typ
		m, err := svc.Send(context.Background(), 1, 30, "oi", nil, SendOptions{})
		if err != nil || m.Content != "oi" {
			t.Fatalf("tipo %d: %v", typ, err)
		}
		ev := rec.evs[0]
		if ev.Type != events.MessageCreate || ev.GuildID != 0 || ev.Topics[0] != "channel:30" {
			t.Fatalf("evento: %+v", ev)
		}
	}
	if st.inserts != 2 {
		t.Fatalf("inserts = %d", st.inserts)
	}
}

func TestDMEditAndDeleteAreAuthorOnly(t *testing.T) {
	svc, st, ch, rec := dmSetup()
	st.msgs[5] = Message{ID: 5, ChannelID: 30, Author: Author{ID: 1}}
	// mesmo um perm.Member com tudo (como um dono de servidor) não apaga mensagem alheia em DM
	ch.member = perm.NewMember(2, true, perm.All, 99)
	if err := svc.Delete(context.Background(), 2, 30, 5); !apperr.IsKind(err, apperr.KindForbidden) || st.deleted[5] {
		t.Fatalf("outro participante não apaga: %v", err)
	}
	if _, err := svc.Edit(context.Background(), 2, 30, 5, "x"); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("outro participante não edita: %v", err)
	}
	rec.evs = nil
	if err := svc.Delete(context.Background(), 1, 30, 5); err != nil {
		t.Fatal(err)
	}
	p := rec.evs[0].Data.(DeletePayload)
	if p.GuildID != "" || p.ChannelID != "30" || rec.evs[0].GuildID != 0 {
		t.Fatalf("payload da DM: %+v", p)
	}
	b, _ := json.Marshal(p)
	if strings.Contains(string(b), "guild_id") {
		t.Fatalf("guild_id deve ser omitido em DMs: %s", b)
	}
}

func TestListInDMUsesAuthorization(t *testing.T) {
	svc, _, ch, _ := dmSetup()
	ch.err = channel.ErrNotFound // não participante
	if _, _, err := svc.List(context.Background(), 9, 30, 0, 10); !errors.Is(err, channel.ErrNotFound) {
		t.Fatalf("não participante lê o histórico: %v", err)
	}
}

func TestSendWithAttachments(t *testing.T) {
	svc, st, ch, fa, rec := setupAtts()
	m, err := svc.Send(context.Background(), 1, 20, "", []int64{11, 12}, SendOptions{})
	if err != nil {
		t.Fatalf("conteúdo vazio com anexo deveria passar: %v", err)
	}
	if ch.need != perm.SendMessages|perm.AttachFiles {
		t.Fatalf("com anexo exige SEND_MESSAGES e ATTACH_FILES, exigiu %b", ch.need)
	}
	if len(fa.verified) != 1 || len(fa.verified[0]) != 2 {
		t.Fatalf("verify: %v", fa.verified)
	}
	if st.lastInsert.KeyPrefix != "attachments/20/" || len(st.lastInsert.AttachmentIDs) != 2 || st.lastInsert.Since.IsZero() {
		t.Fatalf("insert: %+v", st.lastInsert)
	}
	if len(m.Attachments) != 2 {
		t.Fatalf("anexos na mensagem: %+v", m.Attachments)
	}
	p := rec.evs[0].Data.(MessagePayload)
	if len(p.Attachments) != 2 || p.Content != "" {
		t.Fatalf("payload do evento: %+v", p)
	}
}

func TestSendAttachmentRules(t *testing.T) {
	ids := func(n int) []int64 {
		out := make([]int64, n)
		for i := range out {
			out[i] = int64(100 + i)
		}
		return out
	}
	t.Run("10 anexos passam, 11 não", func(t *testing.T) {
		svc, st, _, _, _ := setupAtts()
		if _, err := svc.Send(context.Background(), 1, 20, "x", ids(10), SendOptions{}); err != nil {
			t.Fatal(err)
		}
		st.inserts = 0
		if _, err := svc.Send(context.Background(), 1, 20, "x", ids(11), SendOptions{}); !errors.Is(err, ErrTooManyAttachments) || st.inserts != 0 {
			t.Fatalf("11 anexos: %v", err)
		}
	})
	t.Run("sem conteúdo e sem anexo", func(t *testing.T) {
		svc, st, _, _, _ := setupAtts()
		if _, err := svc.Send(context.Background(), 1, 20, "  ", nil, SendOptions{}); !errors.Is(err, ErrEmptyMessage) || st.inserts != 0 {
			t.Fatalf("vazio: %v", err)
		}
	})
	t.Run("anexo repetido", func(t *testing.T) {
		svc, st, _, _, _ := setupAtts()
		if _, err := svc.Send(context.Background(), 1, 20, "x", []int64{5, 5}, SendOptions{}); !apperr.IsKind(err, apperr.KindInvalid) || st.inserts != 0 {
			t.Fatalf("repetido: %v", err)
		}
	})
	t.Run("anexo de outro usuário, de outro canal ou expirado", func(t *testing.T) {
		svc, st, _, fa, rec := setupAtts()
		fa.verifyErr = attachment.ErrInvalidAttachments
		if _, err := svc.Send(context.Background(), 1, 20, "x", []int64{5}, SendOptions{}); !errors.Is(err, attachment.ErrInvalidAttachments) || st.inserts != 0 || len(rec.evs) != 0 {
			t.Fatalf("inválido: %v", err)
		}
	})
	t.Run("corrida: a associação na transação falha", func(t *testing.T) {
		svc, st, _, _, rec := setupAtts()
		st.insertErr = attachment.ErrInvalidAttachments
		if _, err := svc.Send(context.Background(), 1, 20, "x", []int64{5}, SendOptions{}); !errors.Is(err, attachment.ErrInvalidAttachments) || len(rec.evs) != 0 {
			t.Fatalf("corrida: %v", err)
		}
	})
	t.Run("sem ATTACH_FILES não anexa mas envia texto", func(t *testing.T) {
		svc, _, ch, _, _ := setupAtts()
		ch.err = channel.ErrForbidden
		if _, err := svc.Send(context.Background(), 1, 20, "x", []int64{5}, SendOptions{}); !errors.Is(err, channel.ErrForbidden) {
			t.Fatalf("esperava 403: %v", err)
		}
	})
}

func TestListLoadsAttachmentsInOneBatch(t *testing.T) {
	svc, _, _, fa, _ := setupAtts()
	fa.byMsg = map[int64][]attachment.AttachmentPayload{3: {{ID: "9", Filename: "a.png"}}}
	msgs, _, err := svc.List(context.Background(), 1, 20, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if fa.listCalls != 1 {
		t.Fatalf("anexos devem vir numa chamada só, vieram %d", fa.listCalls)
	}
	for _, m := range msgs {
		if m.ID == 3 && len(m.Attachments) != 1 {
			t.Fatalf("mensagem 3 sem anexo: %+v", m)
		}
		if m.ID != 3 && len(m.Attachments) != 0 {
			t.Fatalf("anexo na mensagem errada: %+v", m)
		}
		if m.Payload().Attachments == nil {
			t.Fatal("attachments no JSON deve ser [] e não null")
		}
	}
}

func TestRepublishUpdate(t *testing.T) {
	svc, st, _, fa, rec := setupAtts()
	st.msgs[5] = Message{ID: 5, ChannelID: 20, Content: "oi", Author: Author{ID: 1}}
	fa.byMsg = map[int64][]attachment.AttachmentPayload{5: {{ID: "9", ThumbnailURL: "http://t"}}}
	if err := svc.RepublishUpdate(context.Background(), 20, 5); err != nil {
		t.Fatal(err)
	}
	if len(rec.evs) != 1 || rec.evs[0].Type != events.MessageUpdate || rec.evs[0].GuildID != 7 {
		t.Fatalf("eventos: %+v", rec.evs)
	}
	if p := rec.evs[0].Data.(MessagePayload); len(p.Attachments) != 1 || p.Attachments[0].ThumbnailURL == "" {
		t.Fatalf("payload: %+v", p)
	}
	rec.evs = nil
	st.deleted[5] = true // apagada no meio do caminho: nada a publicar
	if err := svc.RepublishUpdate(context.Background(), 20, 5); err != nil || len(rec.evs) != 0 {
		t.Fatalf("apagada: %v %v", err, rec.evs)
	}
}

type fakeMentions struct {
	ids    []int64
	err    error
	seen   []string
	canAll []bool
}

func (f *fakeMentions) Resolve(_ context.Context, _ channel.Channel, _ int64, content string, canAll bool) (MentionResult, error) {
	f.seen = append(f.seen, content)
	f.canAll = append(f.canAll, canAll)
	if f.err != nil {
		return MentionResult{}, f.err
	}
	res := MentionResult{UserIDs: f.ids}
	if canAll && strings.Contains(content, "@everyone") {
		res.Everyone = true
	}
	return res, nil
}

func TestSendResolvesMentionsIntoPayload(t *testing.T) {
	svc, st, _, _, rec := setup()
	fm := &fakeMentions{ids: []int64{5, 9}}
	svc.SetMentions(fm)
	m, err := svc.Send(context.Background(), 1, 20, " oi @a @b ", nil, SendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(fm.seen) != 1 || fm.seen[0] != "oi @a @b" {
		t.Fatalf("resolveu o texto já sem espaços: %v", fm.seen)
	}
	if len(st.lastInsert.MentionIDs) != 2 || len(m.MentionIDs) != 2 {
		t.Fatalf("mention_ids deve ser gravado: %+v", st.lastInsert.MentionIDs)
	}
	p := rec.evs[0].Data.(MessagePayload)
	if len(p.MentionIDs) != 2 || p.MentionIDs[0] != "5" || p.MentionIDs[1] != "9" {
		t.Fatalf("payload: %+v", p.MentionIDs)
	}
}

func TestSendPayloadAlwaysHasMentionIDsArray(t *testing.T) {
	svc, _, _, _, rec := setup() // sem Mentions ligado
	if _, err := svc.Send(context.Background(), 1, 20, "oi", nil, SendOptions{}); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(rec.evs[0].Data)
	if !strings.Contains(string(b), `"mention_ids":[]`) {
		t.Fatalf("mention_ids deve ser [] e não null: %s", b)
	}
}

func TestSendSurvivesMentionResolutionFailure(t *testing.T) {
	svc, st, _, _, _ := setup()
	svc.SetMentions(&fakeMentions{err: errors.New("banco fora")})
	m, err := svc.Send(context.Background(), 1, 20, "oi @alguem", nil, SendOptions{})
	if err != nil || st.inserts != 1 || len(m.MentionIDs) != 0 {
		t.Fatalf("a mensagem sai sem destaque: %v %+v", err, m)
	}
}

func TestSendWithoutTextSkipsMentionResolution(t *testing.T) {
	svc, _, _, _, _ := setupAtts()
	fm := &fakeMentions{}
	svc.SetMentions(fm)
	if _, err := svc.Send(context.Background(), 1, 20, "", []int64{3}, SendOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(fm.seen) != 0 {
		t.Fatal("só anexo não tem menção para resolver")
	}
}

// ---- responder ----

func seedMessage(st *fakeStore, id, channelID, authorID int64, content string) {
	st.msgs[id] = Message{ID: id, ChannelID: channelID, Content: content, Author: Author{ID: authorID, Username: "autor" + strconv.FormatInt(authorID, 10)}}
}

// replyMentions simula a resolução do username do autor respondido (quem vê o canal).
type replyMentions struct {
	visible map[int64]bool
	seen    []string
	byName  map[string]int64
}

func (f *replyMentions) Resolve(_ context.Context, _ channel.Channel, _ int64, content string, _ bool) (MentionResult, error) {
	f.seen = append(f.seen, content)
	name := strings.TrimPrefix(content, "@")
	if id, ok := f.byName[name]; ok && f.visible[id] {
		return MentionResult{UserIDs: []int64{id}}, nil
	}
	return MentionResult{}, nil
}

func TestSendReplyBuildsPreviewAndMentionsAuthor(t *testing.T) {
	svc, st, _, _, rec := setup()
	seedMessage(st, 500, 20, 9, strings.Repeat("ã", 150))
	svc.SetMentions(&replyMentions{visible: map[int64]bool{9: true}, byName: map[string]int64{"autor9": 9}})
	m, err := svc.Send(context.Background(), 1, 20, "concordo", nil, SendOptions{ReplyTo: 500, MentionReply: true})
	if err != nil {
		t.Fatal(err)
	}
	if st.lastInsert.ReferenceID == nil || *st.lastInsert.ReferenceID != 500 {
		t.Fatalf("reference_id: %+v", st.lastInsert.ReferenceID)
	}
	if len(st.lastInsert.MentionIDs) != 1 || st.lastInsert.MentionIDs[0] != 9 {
		t.Fatalf("o autor respondido deve ser mencionado: %v", st.lastInsert.MentionIDs)
	}
	p := rec.evs[0].Data.(MessagePayload)
	if p.ReplyTo == nil || p.ReplyTo.ID != "500" || p.ReplyTo.Author.Username != "autor9" || httpx.Runes(p.ReplyTo.Content) != ReplyPreviewRunes || p.ReplyTo.Deleted {
		t.Fatalf("reply_to: %+v", p.ReplyTo)
	}
	if m.Reply == nil {
		t.Fatal("m.Reply deveria vir preenchido")
	}
}

func TestSendReplyWithoutMentionOrToSelfOrInvisibleAuthor(t *testing.T) {
	cases := []struct {
		name    string
		opts    SendOptions
		author  int64
		visible bool
	}{
		{"mention_reply desligado", SendOptions{ReplyTo: 500}, 9, true},
		{"respondendo a si mesmo", SendOptions{ReplyTo: 500, MentionReply: true}, 1, true},
		{"autor não vê o canal", SendOptions{ReplyTo: 500, MentionReply: true}, 9, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			svc, st, _, _, _ := setup()
			seedMessage(st, 500, 20, c.author, "oi")
			svc.SetMentions(&replyMentions{visible: map[int64]bool{c.author: c.visible}, byName: map[string]int64{"autor" + strconv.FormatInt(c.author, 10): c.author}})
			if _, err := svc.Send(context.Background(), 1, 20, "x", nil, c.opts); err != nil {
				t.Fatal(err)
			}
			if len(st.lastInsert.MentionIDs) != 0 {
				t.Fatalf("não deveria mencionar: %v", st.lastInsert.MentionIDs)
			}
			if st.lastInsert.ReferenceID == nil {
				t.Fatal("ainda é uma resposta")
			}
		})
	}
}

func TestSendReplyMentionKeepsTextMentionsAndCapsAtTwenty(t *testing.T) {
	svc, st, _, _, _ := setup()
	seedMessage(st, 500, 20, 99, "oi")
	many := make([]int64, 20)
	for i := range many {
		many[i] = int64(i + 1)
	}
	svc.SetMentions(&compositeMentions{text: many, reply: replyMentions{visible: map[int64]bool{99: true}, byName: map[string]int64{"autor99": 99}}})
	if _, err := svc.Send(context.Background(), 1, 20, "@x", nil, SendOptions{ReplyTo: 500, MentionReply: true}); err != nil {
		t.Fatal(err)
	}
	got := st.lastInsert.MentionIDs
	if len(got) != 20 || !slices.Contains(got, 99) || !slices.IsSorted(got) {
		t.Fatalf("máximo de 20 com o respondido incluído: %v", got)
	}
}

type compositeMentions struct {
	text  []int64
	reply replyMentions
}

func (c *compositeMentions) Resolve(ctx context.Context, ch channel.Channel, a int64, content string, canAll bool) (MentionResult, error) {
	if content == "@x" {
		return MentionResult{UserIDs: c.text}, nil
	}
	return c.reply.Resolve(ctx, ch, a, content, canAll)
}

func TestSendReplyRejectsInvalidTargets(t *testing.T) {
	svc, st, _, _, rec := setup()
	seedMessage(st, 500, 20, 9, "ok")
	seedMessage(st, 501, 21, 9, "outro canal")
	seedMessage(st, 502, 20, 9, "apagada")
	st.deleted[502] = true
	for name, id := range map[string]int64{"inexistente": 999, "outro canal": 501, "apagada": 502} {
		_, err := svc.Send(context.Background(), 1, 20, "x", nil, SendOptions{ReplyTo: id})
		if !errors.Is(err, ErrReplyTarget) || !apperr.IsKind(err, apperr.KindInvalid) {
			t.Errorf("%s: esperava ErrReplyTarget (422), veio %v", name, err)
		}
	}
	if st.inserts != 0 || len(rec.evs) != 0 {
		t.Fatalf("nada deve ser gravado nem publicado: inserts=%d evs=%d", st.inserts, len(rec.evs))
	}
}

func TestListLoadsRepliesInOneBatch(t *testing.T) {
	svc, st, _, _, _ := setup()
	seedMessage(st, 500, 20, 9, "original")
	seedMessage(st, 501, 20, 9, "apagada depois")
	st.deleted[501] = true
	ref := func(id int64) *int64 { return &id }
	msgs := []Message{
		{ID: 5, ChannelID: 20, ReferenceID: ref(500), Author: Author{ID: 1}},
		{ID: 4, ChannelID: 20, ReferenceID: ref(500), Author: Author{ID: 1}},
		{ID: 3, ChannelID: 20, ReferenceID: ref(501), Author: Author{ID: 1}},
		{ID: 2, ChannelID: 20, ReferenceID: ref(777), Author: Author{ID: 1}}, // sumiu de vez
		{ID: 1, ChannelID: 20, Author: Author{ID: 1}},
	}
	if err := svc.attach(context.Background(), msgs); err != nil {
		t.Fatal(err)
	}
	if st.refCalls != 1 {
		t.Fatalf("esperava 1 consulta para as respondidas, foram %d", st.refCalls)
	}
	if msgs[0].Reply == nil || msgs[0].Reply.Content != "original" || msgs[0].Reply.Deleted {
		t.Fatalf("reply 0: %+v", msgs[0].Reply)
	}
	if !msgs[2].Reply.Deleted || msgs[2].Reply.Content != "" || !msgs[3].Reply.Deleted || msgs[4].Reply != nil {
		t.Fatalf("apagadas/ausentes: %+v %+v %+v", msgs[2].Reply, msgs[3].Reply, msgs[4].Reply)
	}
	if p := msgs[4].Payload(); p.ReplyTo != nil {
		t.Fatalf("sem referência = reply_to null: %+v", p.ReplyTo)
	}
}

// ---- fixar ----

func TestPinPublishesUpdateAndIsIdempotent(t *testing.T) {
	svc, st, ch, _, rec := setup()
	seedMessage(st, 500, 20, 9, "importante")
	if err := svc.Pin(context.Background(), 1, 20, 500); err != nil {
		t.Fatal(err)
	}
	if ch.need != perm.ManageMessages {
		t.Fatalf("fixar exige MANAGE_MESSAGES, exigiu %b", ch.need)
	}
	if len(rec.evs) != 1 || rec.evs[0].Type != events.MessageUpdate {
		t.Fatalf("eventos: %+v", rec.evs)
	}
	if p := rec.evs[0].Data.(MessagePayload); !p.Pinned || p.ID != "500" {
		t.Fatalf("payload: %+v", p)
	}
	if err := svc.Pin(context.Background(), 1, 20, 500); err != nil || len(rec.evs) != 1 {
		t.Fatalf("fixar de novo não muda nada nem publica: %v evs=%d", err, len(rec.evs))
	}
	if err := svc.Unpin(context.Background(), 1, 20, 500); err != nil || len(rec.evs) != 2 {
		t.Fatalf("desafixar: %v evs=%d", err, len(rec.evs))
	}
	if p := rec.evs[1].Data.(MessagePayload); p.Pinned {
		t.Fatal("pinned deveria voltar a false")
	}
	if err := svc.Unpin(context.Background(), 1, 20, 500); err != nil || len(rec.evs) != 2 {
		t.Fatalf("desafixar de novo é no-op: %v evs=%d", err, len(rec.evs))
	}
}

func TestPinPermissionsAndTargets(t *testing.T) {
	svc, st, ch, _, rec := setup()
	seedMessage(st, 500, 20, 9, "x")
	seedMessage(st, 501, 20, 9, "apagada")
	st.deleted[501] = true
	ch.err = channel.ErrForbidden
	if err := svc.Pin(context.Background(), 1, 20, 500); !errors.Is(err, channel.ErrForbidden) {
		t.Fatalf("sem MANAGE_MESSAGES: %v", err)
	}
	ch.err = channel.ErrNotFound
	if err := svc.Unpin(context.Background(), 1, 20, 500); !errors.Is(err, channel.ErrNotFound) {
		t.Fatalf("sem acesso: %v", err)
	}
	ch.err = nil
	for _, id := range []int64{501, 999} {
		if err := svc.Pin(context.Background(), 1, 20, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("mensagem %d apagada/inexistente não fixa: %v", id, err)
		}
	}
	if len(rec.evs) != 0 {
		t.Fatalf("sem eventos: %+v", rec.evs)
	}
}

func TestPinInDMNeedsOnlyParticipation(t *testing.T) {
	svc, st, ch, rec := dmSetup()
	seedMessage(st, 500, 30, 2, "oi")
	if err := svc.Pin(context.Background(), 1, 30, 500); err != nil {
		t.Fatal(err)
	}
	if ch.ch.GuildID != nil || len(rec.evs) != 1 || rec.evs[0].GuildID != 0 {
		t.Fatalf("evento de DM sem guild: %+v", rec.evs)
	}
}

func TestPinLimitIsFifty(t *testing.T) {
	svc, st, _, _, _ := setup()
	for i := int64(1); i <= MaxPins+1; i++ {
		seedMessage(st, i, 20, 9, "x")
	}
	for i := int64(1); i <= MaxPins; i++ {
		if err := svc.Pin(context.Background(), 1, 20, i); err != nil {
			t.Fatalf("fixar %d: %v", i, err)
		}
	}
	err := svc.Pin(context.Background(), 1, 20, MaxPins+1)
	if !errors.Is(err, ErrTooManyPins) || !apperr.IsKind(err, apperr.KindConflict) {
		t.Fatalf("a 51ª deve dar 409: %v", err)
	}
	if st.pinMax != MaxPins {
		t.Fatalf("limite passado ao store: %d", st.pinMax)
	}
	// Apagar uma fixada libera espaço.
	st.deleted[1] = true
	if err := svc.Pin(context.Background(), 1, 20, MaxPins+1); err != nil {
		t.Fatalf("depois de apagar uma fixada cabe outra: %v", err)
	}
}

func TestListPinsAuthorizesAndReturnsPinned(t *testing.T) {
	svc, st, ch, _, _ := setup()
	seedMessage(st, 500, 20, 9, "a")
	seedMessage(st, 501, 20, 9, "b")
	if err := svc.Pin(context.Background(), 1, 20, 501); err != nil {
		t.Fatal(err)
	}
	got, err := svc.ListPins(context.Background(), 1, 20)
	if err != nil || len(got) != 1 || got[0].ID != 501 || got[0].PinnedAt == nil {
		t.Fatalf("fixadas: %+v err=%v", got, err)
	}
	ch.err = channel.ErrNotFound
	if _, err := svc.ListPins(context.Background(), 1, 20); !errors.Is(err, channel.ErrNotFound) {
		t.Fatalf("sem acesso: %v", err)
	}
}

type fakeGate struct {
	blocked bool
	err     error
	calls   int
}

func (g *fakeGate) PairBlocked(context.Context, int64) (bool, error) {
	g.calls++
	return g.blocked, g.err
}

func TestSendRefusesNewMessagesInBlockedDM1to1(t *testing.T) {
	svc, st, ch, lim, rec := setup()
	ch.ch = channel.Channel{ID: 20, Type: channel.TypeDM}
	gate := &fakeGate{}
	svc.SetDMGate(gate)
	if _, err := svc.Send(context.Background(), 1, 20, "oi", nil, SendOptions{}); err != nil {
		t.Fatal(err)
	}
	gate.blocked = true
	_, err := svc.Send(context.Background(), 1, 20, "de novo", nil, SendOptions{})
	if !apperr.IsKind(err, apperr.KindForbidden) || strings.Contains(strings.ToLower(err.Error()), "bloque") {
		t.Fatalf("erro deveria ser 403 genérico: %v", err)
	}
	if st.inserts != 1 || len(rec.evs) != 1 {
		t.Fatal("a mensagem recusada não pode ser gravada nem publicada")
	}
	if len(lim.keys) != 1 {
		t.Fatal("a recusa vem antes do limite de envio")
	}
	gate.err = errors.New("banco fora")
	if _, err := svc.Send(context.Background(), 1, 20, "x", nil, SendOptions{}); err == nil {
		t.Fatal("falha de infraestrutura não deve liberar o envio")
	}
	// DMs em grupo e canais de servidor nunca consultam o bloqueio.
	gate.err, gate.calls = nil, 0
	ch.ch = channel.Channel{ID: 21, Type: channel.TypeGroupDM}
	if _, err := svc.Send(context.Background(), 1, 21, "grupo", nil, SendOptions{}); err != nil || gate.calls != 0 {
		t.Fatalf("grupo: %v (consultas %d)", err, gate.calls)
	}
}
