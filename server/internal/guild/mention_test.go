package guild

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/limits"
)

func TestRoleMentionableAndReservedNames(t *testing.T) {
	f := rolesFixture()
	svc, _ := newSvc(f)
	ctx := context.Background()
	aud := &auditRec{}
	svc.SetAudit(aud)

	for _, name := range []string{"everyone", "@everyone", "Here", "@HERE"} {
		if _, err := svc.CreateRole(ctx, 1, 1, RoleParams{Name: sp(name)}); !apperr.IsKind(err, apperr.KindInvalid) {
			t.Errorf("nome reservado %q: %v", name, err)
		}
	}
	yes := true
	r, err := svc.CreateRole(ctx, 1, 1, RoleParams{Name: sp("Equipe"), Mentionable: &yes})
	if err != nil || !r.Mentionable || !r.Payload().Mentionable {
		t.Fatalf("criar mencionável: %+v %v", r, err)
	}
	no := false
	r, err = svc.UpdateRole(ctx, 1, 1, r.ID, RoleParams{Mentionable: &no})
	if err != nil || r.Mentionable {
		t.Fatalf("desligar: %+v %v", r, err)
	}
	last := aud.entries[len(aud.entries)-1]
	ch, _ := last.Changes["mentionable"].(map[string]any)
	if last.Action != audit.RoleUpdate || ch["from"] != true || ch["to"] != false {
		t.Fatalf("auditoria da mudança de mentionable: %+v", last)
	}
	// MENTION_EVERYONE: quem não tem a permissão não a concede a um cargo
	if _, err = svc.CreateRole(ctx, 2, 1, RoleParams{Name: sp("x"), Position: i32(4), Permissions: pp(perm.MentionEveryone)}); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("conceder sem ter: %v", err)
	}
	if perm.DefaultEveryone.Has(perm.MentionEveryone) {
		t.Fatal("o @everyone do servidor não recebe MENTION_EVERYONE por padrão")
	}
}

func TestRoleLimitIsConfigurable(t *testing.T) {
	f := rolesFixture() // @everyone + 3 cargos
	svc, _ := newSvc(f)
	svc.SetLimits(limits.Limits{RolesPerGuild: 4})
	_, err := svc.CreateRole(context.Background(), 1, 1, RoleParams{Name: sp("novo")})
	if !apperr.IsKind(err, apperr.KindConflict) || !strings.Contains(err.Error(), "4 cargos") {
		t.Fatalf("limite de cargos: %v", err)
	}
}

func TestGuildGuildCreateLimitMessage(t *testing.T) {
	if err := TooManyGuilds(limits.DefaultGuildsPerUser); !errors.Is(err, ErrTooManyGuilds) {
		t.Fatal("o padrão do SPEC mantém o erro sentinela")
	}
	if err := TooManyGuilds(3); !apperr.IsKind(err, apperr.KindConflict) || !strings.Contains(err.Error(), "3 servidores") {
		t.Fatalf("personalizado: %v", err)
	}
}

func TestUpdateGuildSystemChannel(t *testing.T) {
	f := newFake()
	f.members = map[int64]Access{1: {}}
	svc, _ := newSvc(f)
	aud := &auditRec{}
	svc.SetAudit(aud)
	ctx := context.Background()
	five := int64(5)
	g, err := svc.Update(ctx, 1, 1, UpdateParams{SystemChannelID: &five})
	if err != nil || g.SystemChannelID == nil || *g.SystemChannelID != 5 {
		t.Fatalf("definir canal: %+v %v", g, err)
	}
	bad := int64(99)
	if _, err = svc.Update(ctx, 1, 1, UpdateParams{SystemChannelID: &bad}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("canal que não é de texto do servidor: %v", err)
	}
	off := false
	if g, err = svc.Update(ctx, 1, 1, UpdateParams{SystemJoinEnabled: &off}); err != nil || g.SystemJoinEnabled || g.SystemChannelID == nil {
		t.Fatalf("desligar mantém o canal: %+v %v", g, err)
	}
	zero := int64(0)
	if g, err = svc.Update(ctx, 1, 1, UpdateParams{SystemChannelID: &zero}); err != nil || g.SystemChannelID != nil {
		t.Fatalf("voltar ao padrão: %+v %v", g, err)
	}
	last := aud.entries[len(aud.entries)-1]
	if _, ok := last.Changes["system_channel_id"]; !ok {
		t.Fatalf("auditoria: %+v", last.Changes)
	}
}
