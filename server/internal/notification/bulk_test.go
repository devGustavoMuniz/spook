package notification

import (
	"context"
	"reflect"
	"slices"
	"strconv"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/message"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

func TestParseBulk(t *testing.T) {
	roles := []RoleRef{
		{ID: 10, Name: "Time", Mentionable: true},
		{ID: 11, Name: "Time Azul", Mentionable: true},
		{ID: 12, Name: "Café ☕"},
	}
	cases := []struct {
		name, in string
		want     BulkMentions
	}{
		{"everyone", "oi @everyone", BulkMentions{Everyone: true}},
		{"here com pontuação", "atenção @here, reunião", BulkMentions{Here: true}},
		{"sem diferenciar maiúsculas", "@EVERYONE e @Here.", BulkMentions{Everyone: true, Here: true}},
		{"colado a palavra não vale", "x@everyone @everyones @here_", BulkMentions{}},
		{"e-mail não vale", "fale com a@here.com", BulkMentions{}},
		{"cargo simples", "chamando @time!", BulkMentions{RoleIDs: []int64{10}}},
		{"nome mais longo vence", "chamando @Time Azul agora", BulkMentions{RoleIDs: []int64{11}}},
		{"cargos distintos", "@Time e @time azul", BulkMentions{RoleIDs: []int64{10, 11}}},
		{"cargo com emoji e acento", "oi @café ☕ pessoal", BulkMentions{RoleIDs: []int64{12}}},
		{"cargo inexistente", "oi @Fantasma", BulkMentions{}},
		{"prefixo de palavra não vale", "oi @Timeline", BulkMentions{}},
		{"sem arroba", "everyone here", BulkMentions{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseBulk(c.in, roles)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("ParseBulk(%q) = %+v, esperado %+v", c.in, got, c.want)
			}
		})
	}
}

func TestResolveBulkPermissionMatrix(t *testing.T) {
	roles := []RoleRef{{ID: 10, Name: "Equipe", Mentionable: true}, {ID: 11, Name: "Diretoria"}}
	ch := channel.Channel{ID: 300, GuildID: ptr(int64(100))}
	cases := []struct {
		name           string
		text           string
		canMentionAll  bool
		everyone, here bool
		roles          []int64
	}{
		{"sem permissão: @everyone é só texto", "@everyone @here", false, false, false, nil},
		{"com permissão: tudo vale", "@everyone @here @Equipe @Diretoria", true, true, true, []int64{10, 11}},
		{"sem permissão: cargo mencionável vale", "@Equipe @Diretoria", false, false, false, []int64{10}},
		{"com permissão: cargo não mencionável vale", "@Diretoria", true, false, false, []int64{11}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t, false)
			f.store.roles = roles
			res, err := f.svc.Resolve(context.Background(), ch, 1, c.text, c.canMentionAll)
			if err != nil {
				t.Fatal(err)
			}
			if res.Everyone != c.everyone || res.Here != c.here || !slices.Equal(res.RoleIDs, c.roles) {
				t.Fatalf("got %+v", res)
			}
		})
	}
	// everyone/here nunca são consultados como usernames.
	f := newFixture(t, false)
	f.store.resolved = []int64{99}
	res, _ := f.svc.Resolve(context.Background(), ch, 1, "@everyone @here", true)
	if len(res.UserIDs) != 0 {
		t.Fatalf("everyone/here não são usernames: %v", res.UserIDs)
	}
	// DM: sem cargos nem menção em massa.
	res, _ = f.svc.Resolve(context.Background(), channel.Channel{ID: 500}, 1, "@everyone", true)
	if res.Everyone {
		t.Fatal("DM não tem @everyone")
	}
}

// ---- quem notifica quem ----

func bulkEvent(guild, channelID, author, id int64, everyone, here bool, roles ...int64) events.Event {
	ev := msgEvent(guild, channelID, author, id)
	p := ev.Data.(message.MessagePayload)
	p.MentionEveryone, p.MentionHere = everyone, here
	for _, r := range roles {
		p.MentionRoles = append(p.MentionRoles, strconv.FormatInt(r, 10))
	}
	ev.Data = p
	return ev
}

func member(id int64, roles ...int64) perm.Member {
	m := perm.NewMember(id, false, perm.DefaultEveryone, 0)
	m.RoleIDs = roles
	return m
}

func mentionedUsers(f *fixture) []int64 {
	var out []int64
	for _, c := range f.store.mentionLog {
		out = append(out, c.users...)
	}
	slices.Sort(out)
	return out
}

func bulkFixture(t *testing.T, aud ...perm.Member) *fixture {
	f := newFixture(t, true)
	f.svc.Channels = fakeChannels{ch: channel.Channel{ID: 300, Type: channel.TypeText, GuildID: ptr(int64(100))}, audience: aud}
	f.svc.EveryonePushMax = 200
	for _, m := range aud { // todo mundo tem um dispositivo inscrito
		f.store.subs[m.UserID] = Subscription{ID: m.UserID, UserID: m.UserID, Endpoint: "https://push.example/x"}
	}
	return f
}

func pushedUsers(f *fixture) []int64 {
	var out []int64
	for _, a := range f.queue.args {
		out = append(out, a.SubscriptionID)
	}
	slices.Sort(out)
	return out
}

func TestEveryoneNotifiesAudienceExceptAuthor(t *testing.T) {
	f := bulkFixture(t, member(1), member(2), member(3), member(4))
	f.pres[3] = presence.StatusOnline // online: contador sim, push não (já está no app)
	if err := f.svc.onMessage(context.Background(), bulkEvent(100, 300, 1, 900, true, false)); err != nil {
		t.Fatal(err)
	}
	if got := mentionedUsers(f); !slices.Equal(got, []int64{2, 3, 4}) {
		t.Fatalf("contadores: %v", got)
	}
	if got := pushedUsers(f); !slices.Equal(got, []int64{2, 4}) {
		t.Fatalf("push só offline: %v", got)
	}
}

func TestHereNotifiesOnlyOnlineAndInvisibleCountsAsOffline(t *testing.T) {
	f := bulkFixture(t, member(1), member(2), member(3), member(4))
	f.pres[2] = presence.StatusOnline
	f.pres[3] = presence.StatusIdle
	// 4 está invisível: a presença visível dele é offline.
	if err := f.svc.onMessage(context.Background(), bulkEvent(100, 300, 1, 900, false, true)); err != nil {
		t.Fatal(err)
	}
	if got := mentionedUsers(f); !slices.Equal(got, []int64{2, 3}) {
		t.Fatalf("@here só online: %v", got)
	}
	if len(f.queue.args) != 0 {
		t.Fatalf("quem está online não recebe push: %v", pushedUsers(f))
	}
}

func TestRoleMentionReachesOnlyRoleMembersWhoSeeChannel(t *testing.T) {
	// A audiência já vem filtrada pela visibilidade do canal (overwrites): 5 tem o cargo mas não vê o canal.
	f := bulkFixture(t, member(1, 10), member(2, 10), member(3), member(4, 11))
	if err := f.svc.onMessage(context.Background(), bulkEvent(100, 300, 1, 900, false, false, 10)); err != nil {
		t.Fatal(err)
	}
	if got := mentionedUsers(f); !slices.Equal(got, []int64{2}) {
		t.Fatalf("só o cargo 10, sem o autor: %v", got)
	}
}

func TestSuppressEveryoneKeepsRoleAndDirectMentions(t *testing.T) {
	f := bulkFixture(t, member(1), member(2), member(3, 10), member(4))
	f.store.suppressed = []int64{2, 3}
	ev := bulkEvent(100, 300, 1, 900, true, false, 10)
	p := ev.Data.(message.MessagePayload)
	p.MentionIDs = []string{"4"}
	ev.Data = p
	f.store.suppressed = append(f.store.suppressed, 4)
	if err := f.svc.onMessage(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	// 2 suprimiu (some); 3 suprimiu mas tem o cargo (fica); 4 suprimiu mas foi citado direto (fica).
	if got := mentionedUsers(f); !slices.Equal(got, []int64{3, 4}) {
		t.Fatalf("suprimir não afeta cargo nem menção direta: %v", got)
	}
}

func TestBulkPushRespectsDNDMuteAndLevel(t *testing.T) {
	f := bulkFixture(t, member(1), member(2), member(3), member(4), member(5))
	f.store.filters = map[int64]NotifyFilter{
		2: {DND: true},
		3: {Guild: &Setting{Level: ptr(LevelNone)}},
		4: {Channel: &Setting{Muted: true}},
		5: {Guild: &Setting{Level: ptr(LevelMentions)}}, // só menções: @everyone conta como menção
	}
	if err := f.svc.onMessage(context.Background(), bulkEvent(100, 300, 1, 900, true, false)); err != nil {
		t.Fatal(err)
	}
	if got := mentionedUsers(f); !slices.Equal(got, []int64{2, 3, 4, 5}) {
		t.Fatalf("contadores seguem para todos: %v", got)
	}
	if got := pushedUsers(f); !slices.Equal(got, []int64{5}) {
		t.Fatalf("push só para quem permite: %v", got)
	}
}

func TestEveryoneFanOutLimitKeepsCountersAndDirectPush(t *testing.T) {
	var aud []perm.Member
	for i := int64(1); i <= 12; i++ {
		aud = append(aud, member(i))
	}
	f := bulkFixture(t, aud...)
	f.svc.EveryonePushMax = 5
	ev := bulkEvent(100, 300, 1, 900, true, false)
	p := ev.Data.(message.MessagePayload)
	p.MentionIDs = []string{"7"}
	ev.Data = p
	if err := f.svc.onMessage(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if got := mentionedUsers(f); len(got) != 11 {
		t.Fatalf("contadores para os 11: %v", got)
	}
	if got := pushedUsers(f); !slices.Equal(got, []int64{7}) {
		t.Fatalf("acima do limite só o citado diretamente recebe push: %v", got)
	}
	// No limite exato ainda há push.
	f2 := bulkFixture(t, aud[:6]...)
	f2.svc.EveryonePushMax = 5
	if err := f2.svc.onMessage(context.Background(), bulkEvent(100, 300, 1, 901, true, false)); err != nil {
		t.Fatal(err)
	}
	if got := pushedUsers(f2); len(got) != 5 {
		t.Fatalf("5 destinatários = no limite: %v", got)
	}
}

func TestSystemMessageNeverNotifies(t *testing.T) {
	f := bulkFixture(t, member(1), member(2))
	ev := msgEvent(100, 300, 1, 900, 2)
	p := ev.Data.(message.MessagePayload)
	p.Kind = message.KindMemberJoin
	ev.Data = p
	if err := f.svc.onMessage(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if len(f.store.acks) != 0 || len(f.store.mentionLog) != 0 || len(f.queue.args) != 0 {
		t.Fatalf("mensagem de sistema não avança leitura, não soma menção e não avisa: %+v %+v %+v", f.store.acks, f.store.mentionLog, f.queue.args)
	}
}

func TestSuppressEveryoneSetting(t *testing.T) {
	f := newFixture(t, false)
	f.store.members = map[int64]bool{100: true}
	ctx := context.Background()
	p, err := f.svc.PutSetting(ctx, 7, ScopeGuild, 100, SettingInput{SuppressEveryone: true})
	if err != nil || !p.SuppressEveryone {
		t.Fatalf("%+v %v", p, err)
	}
	list, _ := f.svc.ListSettings(ctx, 7)
	if len(list) != 1 || !list[0].SuppressEveryone {
		t.Fatalf("a configuração só com suppress_everyone aparece: %+v", list)
	}
	if _, err := f.svc.PutSetting(ctx, 7, ScopeChannel, 300, SettingInput{SuppressEveryone: true}); err == nil {
		t.Fatal("suppress_everyone só vale para servidor")
	}
	if _, err := f.svc.PutSetting(ctx, 7, ScopeGuild, 100, SettingInput{}); err != nil {
		t.Fatal(err)
	}
	if list, _ = f.svc.ListSettings(ctx, 7); len(list) != 0 {
		t.Fatalf("tudo desligado volta ao padrão: %+v", list)
	}
}
