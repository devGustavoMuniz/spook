package channel

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/limits"
)

func TestUpdateTopic(t *testing.T) {
	svc, st, rec := setup()
	ctx := context.Background()
	topic := "  Regras do canal\nsem spam  "
	if _, err := svc.Update(ctx, plain, 11, UpdateParams{Topic: &topic}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("sem MANAGE_CHANNELS: %v", err)
	}
	rec.evs = nil
	c, err := svc.Update(ctx, owner, 11, UpdateParams{Topic: &topic})
	if err != nil || c.Topic == nil || *c.Topic != "Regras do canal\nsem spam" || c.Name != "geral" {
		t.Fatalf("definir: %+v %v", c, err)
	}
	if got := rec.types(); len(got) != 1 || got[0] != events.ChannelUpdate {
		t.Fatalf("evento de atualização: %v", got)
	}
	// sem o campo, o tópico fica como está (renomear não apaga)
	n := "outro"
	if c, _ = svc.Update(ctx, owner, 11, UpdateParams{Name: &n}); c.Topic == nil {
		t.Fatal("renomear não pode apagar o tópico")
	}
	// vazio remove
	empty := "   "
	if c, err = svc.Update(ctx, owner, 11, UpdateParams{Topic: &empty}); err != nil || c.Topic != nil || st.chans[11].Topic != nil {
		t.Fatalf("remover: %+v %v", c, err)
	}
	// limites e tipos
	long := strings.Repeat("ã", MaxTopicRunes+1)
	if _, err = svc.Update(ctx, owner, 11, UpdateParams{Topic: &long}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("1025 caracteres: %v", err)
	}
	ok := strings.Repeat("ã", MaxTopicRunes)
	if _, err = svc.Update(ctx, owner, 11, UpdateParams{Topic: &ok}); err != nil {
		t.Fatalf("1024 caracteres valem: %v", err)
	}
	ctrl := "a\x00b"
	if _, err = svc.Update(ctx, owner, 11, UpdateParams{Topic: &ctrl}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("controle: %v", err)
	}
	if _, err = svc.Update(ctx, owner, 12, UpdateParams{Topic: &ok}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("canal de voz não tem tópico: %v", err)
	}
}

func TestChannelLimitIsConfigurable(t *testing.T) {
	svc, _, _ := setup()
	svc.SetLimits(limits.Limits{ChannelsPerGuild: 5}) // o servidor de teste já tem 3 canais
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if _, err := svc.Create(ctx, owner, guildID, CreateParams{Type: TypeText, Name: "x"}); err != nil {
			t.Fatalf("criar %d: %v", i, err)
		}
	}
	_, err := svc.Create(ctx, owner, guildID, CreateParams{Type: TypeText, Name: "x"})
	if !apperr.IsKind(err, apperr.KindConflict) || !strings.Contains(err.Error(), "5 canais") {
		t.Fatalf("limite: %v", err)
	}
}
