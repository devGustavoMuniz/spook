package notification

import (
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func ptr[T any](v T) *T { return &v }

func TestTruncate(t *testing.T) {
	if got := Truncate("curto", 10); got != "curto" {
		t.Fatal(got)
	}
	long := strings.Repeat("é", 200)
	got := Truncate(long, 120)
	if utf8.RuneCountInString(got) != 120 || !strings.HasSuffix(got, "…") {
		t.Fatalf("%d runes: %q", utf8.RuneCountInString(got), got)
	}
	if Truncate(strings.Repeat("a", 120), 120) != strings.Repeat("a", 120) {
		t.Fatal("exatamente no limite não corta")
	}
	if got := Truncate("palavra   "+strings.Repeat("b", 200), 9); got != "palavra…" {
		t.Fatalf("espaços antes da reticência: %q", got)
	}
}

func TestBuildPushPayload(t *testing.T) {
	// servidor: título com #canal · servidor, url do canal, tag = canal
	p := BuildPushPayload(PushContext{
		Content: "oi @gustavo,\n  vem   ver isso", Username: "maria", DisplayName: "Maria Silva",
		ChannelName: "geral", GuildID: ptr(int64(100)), GuildName: "Spook HQ",
	}, 300)
	want := PushPayload{Title: "Maria Silva (#geral · Spook HQ)", Body: "oi @gustavo, vem ver isso", URL: "/channels/100/300", Tag: "300"}
	if p != want {
		t.Fatalf("got %+v", p)
	}
	// DM: só o autor (sem nome de exibição, vale o username), url @me
	p = BuildPushPayload(PushContext{Content: "e aí", Username: "joao"}, 500)
	if p != (PushPayload{Title: "joao", Body: "e aí", URL: "/channels/@me/500", Tag: "500"}) {
		t.Fatalf("got %+v", p)
	}
	// só anexo
	p = BuildPushPayload(PushContext{Content: "", Username: "joao", AttachmentCount: 2}, 500)
	if p.Body != "📎 arquivo" {
		t.Fatalf("corpo só-anexo: %q", p.Body)
	}
	// texto longo é truncado em 120 runes
	p = BuildPushPayload(PushContext{Content: strings.Repeat("x", 500), Username: "joao"}, 500)
	if utf8.RuneCountInString(p.Body) != BodyRunes {
		t.Fatalf("corpo com %d runes", utf8.RuneCountInString(p.Body))
	}
}

func TestPushPayloadJSONShape(t *testing.T) {
	got := string(PushPayload{Title: "T", Body: "B", URL: "/channels/@me/1", Tag: "1"}.JSON())
	if got != `{"title":"T","body":"B","url":"/channels/@me/1","tag":"1"}` {
		t.Fatal(got)
	}
}

func TestNotifyTargets(t *testing.T) {
	// servidor: só os mencionados (sem o autor, sem repetição); os participantes não existem
	if got := notifyTargets(1, false, nil, []int64{2, 3, 1, 2}); !reflect.DeepEqual(got, []int64{2, 3}) {
		t.Fatalf("servidor: %v", got)
	}
	// servidor sem menção: ninguém
	if got := notifyTargets(1, false, nil, nil); len(got) != 0 {
		t.Fatalf("sem menção: %v", got)
	}
	// DM: todos os outros participantes, mencionados ou não
	if got := notifyTargets(1, true, []int64{1, 2, 3}, nil); !reflect.DeepEqual(got, []int64{2, 3}) {
		t.Fatalf("DM: %v", got)
	}
	// DM 1:1 com o autor sozinho (outro saiu): ninguém
	if got := notifyTargets(1, true, []int64{1}, []int64{1}); len(got) != 0 {
		t.Fatalf("DM sozinho: %v", got)
	}
}

func TestPushRecipientsOnlyInactive(t *testing.T) {
	online := map[int64]bool{2: true, 4: true}
	got := pushRecipients([]int64{2, 3, 4, 5}, func(id int64) bool { return online[id] })
	if !reflect.DeepEqual(got, []int64{3, 5}) {
		t.Fatalf("got %v", got)
	}
	if got := pushRecipients(nil, func(int64) bool { return false }); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestSummarizeCapsGuildUnreadAndSkipsDMs(t *testing.T) {
	g1, g2 := int64(1), int64(2)
	states := []ReadState{
		{ChannelID: 10, GuildID: &g1, Unread: 60, Mentions: 1},
		{ChannelID: 11, GuildID: &g1, Unread: 60, Mentions: 2},
		{ChannelID: 20, GuildID: &g2, Unread: 3},
		{ChannelID: 30, Unread: 50, Mentions: 9}, // DM: fora do agregado
	}
	got := Summarize(states)
	want := []GuildReadStatePayload{
		{GuildID: "1", UnreadCount: MaxUnread, MentionCount: 3},
		{GuildID: "2", UnreadCount: 3},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	if got := Summarize(nil); got == nil || len(got) != 0 {
		t.Fatalf("sem canais deve ser [] e não nil: %#v", got)
	}
}

func TestPayloadsFilterForReady(t *testing.T) {
	g := int64(1)
	states := []ReadState{{ChannelID: 1, GuildID: &g}, {ChannelID: 2, GuildID: &g, Unread: 1}, {ChannelID: 3, Mentions: 2, LastRead: 7}}
	if all := Payloads(states, true); len(all) != 3 {
		t.Fatalf("GET devolve todos: %d", len(all))
	}
	ready := Payloads(states, false)
	if len(ready) != 2 || ready[0].ChannelID != "2" || ready[1].ChannelID != "3" || ready[1].GuildID != "" || ready[1].LastReadMessageID != "7" {
		t.Fatalf("READY: %+v", ready)
	}
	if Payloads(nil, false) == nil {
		t.Fatal("deve ser [] e não nil")
	}
}
