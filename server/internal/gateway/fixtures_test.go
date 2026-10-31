package gateway

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/message"
	"github.com/devGustavoMuniz/spook/server/internal/notification"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
	"github.com/devGustavoMuniz/spook/server/internal/typing"
	voicepkg "github.com/devGustavoMuniz/spook/server/internal/voice"
)

var update = flag.Bool("update", false, "regrava packages/shared/fixtures/gateway-events.json")

const fixturePath = "../../../packages/shared/fixtures/gateway-events.json"

func ptr[T any](v T) *T { return &v }

// control monta um frame de controle exatamente como o servidor o escreve.
func control(t *testing.T, op Op, ev string, d any) json.RawMessage {
	t.Helper()
	f := Frame{Op: op}
	if ev != "" {
		f.T = &ev
	}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	f.D = b
	out, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// dispatch monta um dispatch exatamente como o writeLoop o escreve.
func dispatch(t *testing.T, seq int64, ev string, d any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	return appendDispatch(nil, event{Seq: seq, T: ev, D: b})
}

// buildFixtures reúne um exemplo de cada frame do protocolo. O arquivo é o contrato que o front
// valida com Zod (packages/shared); mudou um payload, rode `go test ./internal/gateway -run Fixtures -update`.
func buildFixtures(t *testing.T) map[string]any {
	t.Helper()
	at := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	ch := channel.ChannelPayload{
		ID: "300", Type: 0, GuildID: ptr("100"), ParentID: ptr("200"), Name: "geral", Position: 0,
		LastMessageID: ptr("900"), CreatedAt: at,
	}
	voice := channel.ChannelPayload{ID: "301", Type: 1, GuildID: ptr("100"), ParentID: ptr("200"), Name: "Geral", Position: 1, CreatedAt: at}
	cat := channel.ChannelPayload{ID: "200", Type: 2, GuildID: ptr("100"), Name: "Canais", Position: 0, CreatedAt: at}
	everyone := guild.RolePayload{ID: "100", GuildID: "100", Name: "@everyone", Position: 0, Permissions: 7904, IsEveryone: true}
	mod := guild.RolePayload{ID: "400", GuildID: "100", Name: "Moderador", Color: ptr(int32(0xFF8800)), Position: 1, Permissions: 320}
	g := guild.GuildPayload{ID: "100", Name: "Spook HQ", IconKey: nil, OwnerID: "10", CreatedAt: at}
	detail := guild.DetailPayload{
		GuildPayload: g, Roles: []guild.RolePayload{mod, everyone}, Channels: []channel.ChannelPayload{cat, ch, voice},
		Permissions: 7904, IsOwner: false, MyRoleIDs: []string{"400"},
	}
	dm := channel.ChannelPayload{
		ID: "500", Type: 4, Name: "Estudo de Go", CreatedAt: at, LastMessageID: ptr("901"), OwnerID: ptr("11"),
		Recipients: []channel.RecipientPayload{
			{ID: "11", Username: "gustavo", DisplayName: "Gustavo"}, {ID: "12", Username: "maria"}, {ID: "13", Username: "joao"},
		},
	}
	msg := message.MessagePayload{
		ID: "901", ChannelID: "300", Content: "Olá, Spook!", CreatedAt: at,
		Author: message.AuthorPayload{ID: "10", Username: "gustavo"},
	}
	msg.MentionIDs = []string{"11"}
	// Resposta a outra mensagem (a prévia da original) e fixada: o MESSAGE_UPDATE de fixar traz pinned = true.
	msg.ReplyTo = &message.ReplyPayload{
		ID: "899", Content: "Quem vai ao estudo de Go?", HasAttachments: true,
		Author: message.ReplyAuthorPayload{ID: "11", Username: "maria", DisplayName: "Maria"},
	}
	msg.Pinned = true
	msg.Attachments = []attachment.AttachmentPayload{
		{ID: "950", Filename: "foto.jpg", ContentType: "image/jpeg", Size: 123456, URL: "https://files.spook.example/attachments/300/950/foto.jpg?X-Amz-Signature=abc"},
		{ID: "951", Filename: "notas.pdf", ContentType: "application/pdf", Size: 2048, URL: "https://files.spook.example/attachments/300/951/notas.pdf?X-Amz-Signature=abc"},
	}
	edited := msg
	edited.Content = "Olá, Spook! (editada)"
	edited.EditedAt = ptr(at.Add(time.Minute))
	// MESSAGE_UPDATE depois do job de thumbnail: o anexo de imagem ganha thumbnail_url e dimensões.
	edited.Attachments = []attachment.AttachmentPayload{
		{
			ID: "950", Filename: "foto.jpg", ContentType: "image/jpeg", Size: 123456, URL: "https://files.spook.example/attachments/300/950/foto.jpg?X-Amz-Signature=abc",
			ThumbnailURL: "https://files.spook.example/thumbnails/950.jpg?X-Amz-Signature=abc", Width: ptr(int32(4032)), Height: ptr(int32(3024)),
		},
		msg.Attachments[1],
	}
	member := guild.MemberPayload{
		GuildID: "100", UserID: "11", Nickname: ptr("Gu"), JoinedAt: at, Username: "gustavo",
		DisplayName: "Gustavo", RoleIDs: []string{"400"},
	}

	dispatches := []struct {
		name string
		data any
	}{
		{events.MessageCreate, msg},
		{events.MessageUpdate, edited},
		{events.MessageDelete, message.DeletePayload{ID: "901", ChannelID: "300", GuildID: "100"}},
		{events.GuildCreate, detail},
		{events.GuildUpdate, g},
		{events.GuildDelete, guild.GuildDeletePayload{ID: "100"}},
		{events.GuildMemberAdd, member},
		{events.GuildMemberUpdate, member},
		{events.GuildMemberRemove, guild.MemberRemovePayload{GuildID: "100", UserID: "11"}},
		{events.ChannelCreate, ch},
		{events.ChannelUpdate, ch},
		{events.ChannelDelete, ch},
		{events.RoleCreate, mod},
		{events.RoleUpdate, mod},
		{events.RoleDelete, guild.RoleDeletePayload{GuildID: "100", RoleID: "400"}},
		{EventTypingStart, typing.StartPayload{ChannelID: "300", GuildID: ptr("100"), UserID: "11", Timestamp: at.Unix()}},
		{EventPresenceUpdate, presence.UpdatePayload{UserID: "11", Status: presence.StatusOnline}},
		{EventVoiceStateUpdate, VoiceStateUpdate{GuildID: ptr("100"), ChannelID: ptr("301"), UserID: "11", SelfMute: true, SelfVideo: true}},
		{EventReadStateUpdate, ReadStateUpdate{ChannelID: "300", LastReadMessageID: "901", MentionCount: 2}},
	}
	disp := map[string]json.RawMessage{}
	for i, d := range dispatches {
		disp[d.name] = dispatch(t, int64(i+2), d.name, d.data)
	}

	return map[string]any{
		"hello":           control(t, OpHello, "", Hello{HeartbeatInterval: 41000}),
		"ack":             control(t, OpAck, "", nil),
		"invalid_session": control(t, OpInvalidSession, "", false),
		"heartbeat":       control(t, OpHeartbeat, "", 42),
		"identify":        control(t, OpIdentify, "", Identify{Client: "web"}),
		"resume":          control(t, OpResume, "", Resume{SessionID: "c2Vzc2lvbi1pZA", Seq: 42}),
		"ready": dispatch(t, 1, EventReady, Ready{
			SessionID: "c2Vzc2lvbi1pZA", User: ReadyUser{ID: "11"}, Guilds: []guild.DetailPayload{detail},
			PrivateChannels: []channel.ChannelPayload{dm},
			Presences:       []presence.UpdatePayload{{UserID: "12", Status: presence.StatusOnline}, {UserID: "13", Status: presence.StatusIdle}},
			VoiceStates:     []voicepkg.StatePayload{{GuildID: ptr("100"), ChannelID: ptr("301"), UserID: "12", SelfVideo: true}},
			ReadStates: []notification.ReadStatePayload{
				{ChannelID: "300", GuildID: "100", LastReadMessageID: "890", MentionCount: 2, UnreadCount: 12},
				{ChannelID: "500", LastReadMessageID: "880", UnreadCount: 100},
			},
		}),
		"set_presence":      control(t, OpPresence, "", SetPresence{Status: presence.StatusIdle}),
		"dm_channel_create": dispatch(t, 2, events.ChannelCreate, dm),
		"resumed":           control(t, OpDispatch, EventResumed, Resumed{SessionID: "c2Vzc2lvbi1pZA", Replayed: 3}),
		"dispatch":          disp,
		"close_codes": map[string]int{
			"going_away": CloseGoingAway, "unknown": CloseUnknown, "invalid_op": CloseInvalidOp,
			"session_taken_over": CloseSessionTakenOver, "not_identified": CloseNotIdentified,
			"already_identified": CloseAlreadyIdent, "identify_timeout": CloseIdentifyTimeout,
			"slow_consumer": CloseSlowConsumer, "heartbeat_timeout": CloseHeartbeatTimeout, "rate_limited": CloseRateLimited,
		},
	}
}

func TestGatewayEventsFixtures(t *testing.T) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(buildFixtures(t)); err != nil {
		t.Fatal(err)
	}
	path := filepath.FromSlash(fixturePath)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		if _, serr := os.Stat(filepath.Dir(filepath.Dir(path))); serr != nil {
			t.Skip("packages/shared fora do alcance (o código foi copiado sem o monorepo)")
		}
		t.Fatalf("%s não existe: rode `go test ./internal/gateway -run Fixtures -update`", fixturePath)
	}
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, buf.Bytes()) {
		t.Fatalf("%s está desatualizado: rode `go test ./internal/gateway -run Fixtures -update` e commite", fixturePath)
	}
}
