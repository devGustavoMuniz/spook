package invite

import (
	"context"
	"strings"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/limits"
)

func TestInviteLimitPerGuild(t *testing.T) {
	svc, st, _ := setup()
	svc.SetLimits(limits.Limits{InvitesPerGuild: 3})
	st.count = 2
	if _, err := svc.Create(context.Background(), owner, 1, CreateParams{}); err != nil {
		t.Fatalf("abaixo do limite: %v", err)
	}
	st.count = 3
	_, err := svc.Create(context.Background(), owner, 1, CreateParams{})
	if !apperr.IsKind(err, apperr.KindConflict) || !strings.Contains(err.Error(), "3 convites") {
		t.Fatalf("no limite: %v", err)
	}
}

type fakeJoiner struct{ calls [][2]int64 }

func (f *fakeJoiner) MemberJoined(_ context.Context, g, u int64) error {
	f.calls = append(f.calls, [2]int64{g, u})
	return nil
}

func TestJoinAnnouncesOnlyNewMembers(t *testing.T) {
	svc, st, _ := setup()
	j := &fakeJoiner{}
	svc.SetJoiner(j)
	ctx := context.Background()
	st.redeemRes = RedeemResult{GuildID: 1, Joined: true}
	if _, err := svc.Join(ctx, stranger, "valido12"); err != nil || len(j.calls) != 1 || j.calls[0] != [2]int64{1, stranger} {
		t.Fatalf("entrada nova: %v %v", j.calls, err)
	}
	st.redeemRes = RedeemResult{GuildID: 1}
	if _, err := svc.Join(ctx, member, "valido12"); err != nil || len(j.calls) != 1 {
		t.Fatalf("quem já era membro não gera mensagem: %v %v", j.calls, err)
	}
}
