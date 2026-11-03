package message

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

type fakeSystem struct {
	channel int64
	enabled bool
	err     error
}

func (f fakeSystem) SystemChannel(context.Context, int64) (int64, bool, error) {
	return f.channel, f.enabled, f.err
}

func TestMemberJoinedPostsSystemMessage(t *testing.T) {
	svc, st, _, _, rec := setup()
	svc.SetSystemChannels(fakeSystem{channel: 20, enabled: true})
	if err := svc.MemberJoined(context.Background(), 7, 42); err != nil {
		t.Fatal(err)
	}
	if st.inserts != 1 || st.lastInsert.Kind != KindMemberJoin || st.lastInsert.AuthorID != 42 || st.lastInsert.Content != "" {
		t.Fatalf("insert: %+v", st.lastInsert)
	}
	if len(st.lastInsert.MentionIDs) != 0 || st.lastInsert.MentionEveryone {
		t.Fatalf("mensagem de sistema não menciona ninguém: %+v", st.lastInsert)
	}
	if len(rec.evs) != 1 {
		t.Fatalf("eventos: %v", rec.evs)
	}
	p := rec.evs[0].Data.(MessagePayload)
	if p.Kind != KindMemberJoin || p.Author.ID != "42" {
		t.Fatalf("payload: %+v", p)
	}
}

func TestMemberJoinedSkips(t *testing.T) {
	cases := map[string]fakeSystem{
		"desligada": {channel: 20, enabled: false},
		"sem canal": {channel: 0, enabled: true},
	}
	for name, sys := range cases {
		svc, st, _, _, rec := setup()
		svc.SetSystemChannels(sys)
		if err := svc.MemberJoined(context.Background(), 7, 42); err != nil || st.inserts != 0 || len(rec.evs) != 0 {
			t.Errorf("%s: err=%v inserts=%d", name, err, st.inserts)
		}
	}
	// reentrada no mesmo minuto não duplica
	svc, st, _, _, _ := setup()
	svc.SetSystemChannels(fakeSystem{channel: 20, enabled: true})
	st.recentJoin = map[int64]bool{42: true}
	if err := svc.MemberJoined(context.Background(), 7, 42); err != nil || st.inserts != 0 {
		t.Fatalf("reentrada: err=%v inserts=%d", err, st.inserts)
	}
	// erro ao descobrir o canal sobe (o chamador só registra o aviso)
	svc.SetSystemChannels(fakeSystem{err: errors.New("db")})
	if err := svc.MemberJoined(context.Background(), 7, 43); err == nil {
		t.Fatal("erro deveria subir")
	}
}

func TestSystemMessageCannotBeEditedOrRepliedTo(t *testing.T) {
	svc, st, _, _, _ := setup()
	st.msgs[600] = Message{ID: 600, ChannelID: 20, Kind: KindMemberJoin, Author: Author{ID: 1, Username: "u"}}
	if _, err := svc.Edit(context.Background(), 1, 20, 600, "novo"); !errors.Is(err, ErrSystemMsg) || !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("editar: %v", err)
	}
	st.recentJoin = nil
	if _, err := svc.Send(context.Background(), 1, 20, "oi", nil, SendOptions{ReplyTo: 600}); err == nil {
		t.Fatal("responder mensagem de sistema deveria falhar")
	}
}

func TestSystemMessageDeleteNeedsManageMessages(t *testing.T) {
	svc, st, ch, _, _ := setup()
	st.msgs[600] = Message{ID: 600, ChannelID: 20, Kind: KindMemberJoin, Author: Author{ID: 1, Username: "u"}}
	// o próprio "autor" (quem entrou) não apaga a mensagem de sistema sem MANAGE_MESSAGES
	if err := svc.Delete(context.Background(), 1, 20, 600); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("sem permissão: %v", err)
	}
	ch.member = perm.NewMember(1, false, perm.DefaultEveryone|perm.ManageMessages, 0)
	if err := svc.Delete(context.Background(), 1, 20, 600); err != nil {
		t.Fatalf("moderador: %v", err)
	}
}

func TestSendMassMentionsPermissionAndRateLimit(t *testing.T) {
	svc, st, ch, _, _ := setup()
	fm := &fakeMentions{}
	svc.SetMentions(fm)
	ev := &fakeLimiter{ok: true}
	svc.SetEveryoneLimiter(ev)

	// sem MENTION_EVERYONE: o service pergunta com canAll=false e nada é marcado
	if _, err := svc.Send(context.Background(), 1, 20, "oi @everyone", nil, SendOptions{}); err != nil {
		t.Fatal(err)
	}
	if fm.canAll[0] || st.lastInsert.MentionEveryone || len(ev.keys) != 0 {
		t.Fatalf("sem permissão: canAll=%v insert=%+v limiter=%v", fm.canAll, st.lastInsert, ev.keys)
	}

	// com a permissão: marca e consome o limite 1x/30s por usuário e canal
	ch.member = perm.NewMember(1, false, perm.DefaultEveryone|perm.MentionEveryone, 0)
	m, err := svc.Send(context.Background(), 1, 20, "oi @everyone", nil, SendOptions{})
	if err != nil || !m.MentionEveryone || !st.lastInsert.MentionEveryone {
		t.Fatalf("com permissão: %+v %v", m, err)
	}
	if len(ev.keys) != 1 || ev.keys[0] != "everyone:1:20" {
		t.Fatalf("chave do limite: %v", ev.keys)
	}
	before := st.inserts
	ev.ok, ev.wait = false, 20*time.Second
	if _, err := svc.Send(context.Background(), 1, 20, "@everyone de novo", nil, SendOptions{}); !apperr.IsKind(err, apperr.KindRateLimited) || st.inserts != before {
		t.Fatalf("segundo @everyone: %v (inserts %d→%d)", err, before, st.inserts)
	}
	// mensagem sem menção em massa não consome o limite
	if _, err := svc.Send(context.Background(), 1, 20, "oi", nil, SendOptions{}); err != nil {
		t.Fatal(err)
	}
}
