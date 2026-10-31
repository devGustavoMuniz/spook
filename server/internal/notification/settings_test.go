package notification

import (
	"context"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

func lvl(s string) *string { return &s }

func TestResolveInheritance(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	past, future := now.Add(-time.Minute), now.Add(time.Hour)
	cases := []struct {
		name         string
		ch, gu       *Setting
		isGuild      bool
		wantMuted    bool
		wantLevel    string
		mention      bool
		wantNotifies bool
	}{
		{"padrão de servidor = só menções (menção avisa)", nil, nil, true, false, LevelMentions, true, true},
		{"padrão de servidor sem menção não avisa", nil, nil, true, false, LevelMentions, false, false},
		{"padrão de DM = tudo", nil, nil, false, false, LevelAll, false, true},
		{"servidor 'nada' vale para o canal sem nível", nil, &Setting{Level: lvl(LevelNone)}, true, false, LevelNone, true, false},
		{"canal sobrepõe o servidor", &Setting{Level: lvl(LevelAll)}, &Setting{Level: lvl(LevelNone)}, true, false, LevelAll, false, true},
		{"silêncio do servidor vale para o canal", nil, &Setting{Muted: true}, true, true, LevelMentions, true, false},
		{"silêncio do canal com nível tudo não avisa", &Setting{Muted: true, Level: lvl(LevelAll)}, nil, true, true, LevelAll, true, false},
		{"silêncio vencido deixa de valer", &Setting{Muted: true, MutedUntil: &past}, nil, true, false, LevelMentions, true, true},
		{"silêncio com prazo futuro vale", &Setting{Muted: true, MutedUntil: &future}, nil, true, true, LevelMentions, true, false},
		{"DM só menções sem menção não avisa", &Setting{Level: lvl(LevelMentions)}, nil, false, false, LevelMentions, false, false},
	}
	for _, c := range cases {
		muted, level := Resolve(now, c.ch, c.gu, c.isGuild)
		if muted != c.wantMuted || level != c.wantLevel {
			t.Errorf("%s: muted=%v level=%s, esperado %v %s", c.name, muted, level, c.wantMuted, c.wantLevel)
		}
		if got := Allows(muted, level, c.mention); got != c.wantNotifies {
			t.Errorf("%s: avisa=%v, esperado %v", c.name, got, c.wantNotifies)
		}
	}
}

func TestPushRespectsDNDMuteAndLevel(t *testing.T) {
	f := newFixture(t, true)
	// 2 mencionado e livre; 3 em DND; 4 canal silenciado; 5 nível "nada" no servidor; 6 canal com nível "tudo" mas não mencionado
	for i := int64(1); i <= 6; i++ {
		f.store.subs[i] = Subscription{ID: i, UserID: i + 1}
	}
	f.store.filters = map[int64]NotifyFilter{
		3: {DND: true},
		4: {Channel: &Setting{Muted: true}},
		5: {Guild: &Setting{Level: lvl(LevelNone)}},
	}
	if err := f.svc.onMessage(context.Background(), msgEvent(100, 300, 1, 901, 2, 3, 4, 5)); err != nil {
		t.Fatal(err)
	}
	if len(f.queue.args) != 1 || f.queue.args[0].SubscriptionID != 1 {
		t.Fatalf("só o usuário 2 recebe push: %+v", f.queue.args)
	}
	// A contagem de menções continua para todos, silenciados ou não.
	if len(f.store.mentionLog) != 1 || len(f.store.mentionLog[0].users) != 4 {
		t.Fatalf("menções somadas a todos: %+v", f.store.mentionLog)
	}
}

func TestPushDMMentionsLevelNeedsDirectMention(t *testing.T) {
	f := newFixture(t, true)
	f.store.recipients[500] = []int64{1, 2, 3}
	f.store.subs[1] = Subscription{ID: 1, UserID: 2}
	f.store.subs[2] = Subscription{ID: 2, UserID: 3}
	f.store.filters = map[int64]NotifyFilter{2: {Channel: &Setting{Level: lvl(LevelMentions)}}}
	if err := f.svc.onMessage(context.Background(), msgEvent(0, 500, 1, 901, 3)); err != nil {
		t.Fatal(err)
	}
	// 2 pediu "só menções" e não foi citado; 3 foi citado (e o padrão de DM é tudo).
	if len(f.queue.args) != 1 || f.queue.args[0].SubscriptionID != 2 {
		t.Fatalf("push: %+v", f.queue.args)
	}
}

func TestPutSettingValidatesAndPublishes(t *testing.T) {
	f := newFixture(t, false)
	f.store.members = map[int64]bool{100: true}
	ctx := context.Background()
	soon := time.Now().Add(time.Hour)

	p, err := f.svc.PutSetting(ctx, 7, ScopeGuild, 100, SettingInput{Muted: true, MutedUntil: &soon, Level: lvl(LevelNone)})
	if err != nil || !p.Muted || p.MutedUntil == nil || *p.Level != LevelNone || p.TargetID != "100" {
		t.Fatalf("put: %+v %v", p, err)
	}
	if len(f.pub.evs) != 1 || f.pub.evs[0].Type != events.NotificationSettingsUpdate || f.pub.evs[0].Topics[0] != "user:7" {
		t.Fatalf("evento: %+v", f.pub.evs)
	}
	list, _ := f.svc.ListSettings(ctx, 7)
	if len(list) != 1 {
		t.Fatalf("lista: %+v", list)
	}

	past := time.Now().Add(-time.Minute)
	bad := []struct {
		name  string
		scope string
		in    SettingInput
	}{
		{"prazo no passado", ScopeGuild, SettingInput{Muted: true, MutedUntil: &past}},
		{"prazo sem silêncio", ScopeGuild, SettingInput{MutedUntil: &soon}},
		{"nível inválido", ScopeGuild, SettingInput{Level: lvl("tudo")}},
		{"escopo inválido", "user", SettingInput{Muted: true}},
	}
	for _, c := range bad {
		if _, err := f.svc.PutSetting(ctx, 7, c.scope, 100, c.in); !apperr.IsKind(err, apperr.KindInvalid) {
			t.Errorf("%s: %v", c.name, err)
		}
	}
	if _, err := f.svc.PutSetting(ctx, 7, ScopeGuild, 999, SettingInput{Muted: true}); !apperr.IsKind(err, apperr.KindNotFound) {
		t.Errorf("servidor sem participação: %v", err)
	}
	f.svc.Channels = fakeChannels{err: channel.ErrNotFound}
	if _, err := f.svc.PutSetting(ctx, 7, ScopeChannel, 300, SettingInput{Muted: true}); err == nil {
		t.Error("canal sem acesso deveria falhar")
	}

	// Sem silêncio e sem nível = padrão: apaga a linha.
	if _, err := f.svc.PutSetting(ctx, 7, ScopeGuild, 100, SettingInput{}); err != nil {
		t.Fatal(err)
	}
	if list, _ := f.svc.ListSettings(ctx, 7); len(list) != 0 {
		t.Fatalf("depois de resetar: %+v", list)
	}
}

func TestListSettingsDropsExpiredMutes(t *testing.T) {
	f := newFixture(t, false)
	past := time.Now().Add(-time.Hour)
	f.store.settings = map[string]Setting{
		"channel:1": {Scope: ScopeChannel, TargetID: 1, Muted: true, MutedUntil: &past},
		"channel:2": {Scope: ScopeChannel, TargetID: 2, Muted: true, MutedUntil: &past, Level: lvl(LevelNone)},
		"guild:3":   {Scope: ScopeGuild, TargetID: 3, Muted: true},
	}
	list, err := f.svc.ListSettings(context.Background(), 7)
	if err != nil || len(list) != 2 {
		t.Fatalf("esperado 2 (o vencido sem nível some): %+v %v", list, err)
	}
	for _, p := range list {
		if p.TargetID == "2" && p.Muted {
			t.Fatal("silêncio vencido não deve aparecer como silenciado")
		}
	}
}
