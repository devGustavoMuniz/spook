package livekit

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	lk "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

const (
	key    = "devkey"
	secret = "um-segredo-de-teste-com-mais-de-32-bytes"
)

func newTestProvider(internal string) *Provider {
	return New(Config{PublicURL: "ws://localhost:7880", InternalURL: internal, APIKey: key, APISecret: secret})
}

func verify(t *testing.T, token string) *auth.ClaimGrants {
	t.Helper()
	v, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if v.APIKey() != key {
		t.Fatalf("api key = %q", v.APIKey())
	}
	_, claims, err := v.Verify(secret)
	if err != nil {
		t.Fatal(err)
	}
	return claims
}

func TestIssuedTokenClaims(t *testing.T) {
	p := newTestProvider("http://x")
	before := time.Now()
	tok, err := p.IssueToken(voice.TokenRequest{
		Room: "301", Identity: "11", Name: "alice", TTL: voice.TokenTTL,
		Grants: voice.GrantsFor(true, true),
	})
	if err != nil {
		t.Fatal(err)
	}
	v, _ := auth.ParseAPIToken(tok)
	_, claims, err := v.Verify(secret)
	if err != nil {
		t.Fatal(err)
	}
	g := claims.Video
	if g == nil || !g.RoomJoin || g.Room != "301" || g.RoomAdmin || g.RoomCreate || g.RoomList {
		t.Fatalf("grant = %+v", g)
	}
	if claims.Identity != "11" || claims.Name != "alice" {
		t.Fatalf("claims = %+v", claims)
	}
	if g.CanSubscribe == nil || !*g.CanSubscribe || g.CanPublish == nil || !*g.CanPublish {
		t.Fatalf("publish/subscribe = %+v", g)
	}
	want := map[string]bool{"microphone": true, "camera": true, "screen_share": true, "screen_share_audio": true}
	if len(g.CanPublishSources) != 4 {
		t.Fatalf("origens = %v", g.CanPublishSources)
	}
	for _, s := range g.CanPublishSources {
		if !want[s] {
			t.Fatalf("origem inesperada %q em %v", s, g.CanPublishSources)
		}
	}
	// exp = agora + 10 min (tolerância de alguns segundos).
	exp, err := tokenExp(tok)
	if err != nil {
		t.Fatal(err)
	}
	if d := exp.Sub(before); d < 10*time.Minute-5*time.Second || d > 10*time.Minute+5*time.Second {
		t.Fatalf("exp = %v (%v a partir de agora)", exp, d)
	}
}

func tokenExp(tok string) (time.Time, error) {
	v, err := auth.ParseAPIToken(tok)
	if err != nil {
		return time.Time{}, err
	}
	_, claims, err := v.Verify(secret)
	if err != nil {
		return time.Time{}, err
	}
	_ = claims
	parts := strings.Split(tok, ".")
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, err
	}
	var m struct {
		Exp int64 `json:"exp"`
	}
	if err := jsonUnmarshal(raw, &m); err != nil {
		return time.Time{}, err
	}
	return time.Unix(m.Exp, 0), nil
}

func TestIssuedTokenSourcesAndNoPublish(t *testing.T) {
	p := newTestProvider("http://x")
	tok, _ := p.IssueToken(voice.TokenRequest{Room: "301", Identity: "11", TTL: time.Minute, Grants: voice.GrantsFor(true, false)})
	g := verify(t, tok).Video
	if len(g.CanPublishSources) != 1 || g.CanPublishSources[0] != "microphone" || !*g.CanPublish {
		t.Fatalf("só SPEAK: %+v", g)
	}
	tok, _ = p.IssueToken(voice.TokenRequest{Room: "301", Identity: "11", TTL: time.Minute, Grants: voice.GrantsFor(false, true)})
	g = verify(t, tok).Video
	if len(g.CanPublishSources) != 3 {
		t.Fatalf("só VIDEO: %+v", g)
	}
	for _, s := range g.CanPublishSources {
		if s == "microphone" {
			t.Fatal("VIDEO sozinho não libera o microfone")
		}
	}
	tok, _ = p.IssueToken(voice.TokenRequest{Room: "301", Identity: "11", TTL: time.Minute, Grants: voice.GrantsFor(false, false)})
	g = verify(t, tok).Video
	if g.CanPublish == nil || *g.CanPublish || len(g.CanPublishSources) != 0 || g.CanSubscribe == nil || !*g.CanSubscribe {
		t.Fatalf("sem permissões: canPublish=false e canSubscribe=true, veio %+v", g)
	}
}

func signed(t *testing.T, body []byte, sec string) string {
	t.Helper()
	sum := sha256.Sum256(body)
	tok, err := auth.NewAccessToken(key, sec).SetSha256(base64.StdEncoding.EncodeToString(sum[:])).SetValidFor(time.Minute).ToJWT()
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func TestVerifyWebhook(t *testing.T) {
	p := newTestProvider("http://x")
	ev := &lk.WebhookEvent{
		Event: "participant_joined", Id: "EV_1", Room: &lk.Room{Name: "301"},
		Participant: &lk.ParticipantInfo{Sid: "PA_1", Identity: "11", Tracks: []*lk.TrackInfo{{Source: lk.TrackSource_CAMERA}}},
	}
	body, err := protojsonMarshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	got, ok, err := p.VerifyWebhook(signed(t, body, secret), body)
	if err != nil || !ok {
		t.Fatalf("assinatura válida: ok=%v err=%v", ok, err)
	}
	if got.ID != "EV_1" || got.Type != "participant_joined" || got.Room != "301" || got.Identity != "11" || got.SID != "PA_1" ||
		len(got.Tracks) != 1 || got.Tracks[0] != voice.SourceCamera {
		t.Fatalf("evento = %+v", got)
	}

	trk := &lk.WebhookEvent{Event: "track_published", Room: &lk.Room{Name: "301"},
		Participant: &lk.ParticipantInfo{Identity: "11"}, Track: &lk.TrackInfo{Source: lk.TrackSource_SCREEN_SHARE, Sid: "TR_9", Width: 1920, Height: 1080}}
	body, _ = protojsonMarshal(trk)
	got, ok, err = p.VerifyWebhook(signed(t, body, secret), body)
	if err != nil || !ok || got.Source != voice.SourceScreenShare || got.TrackSID != "TR_9" || got.TrackWidth != 1920 || got.TrackHeight != 1080 {
		t.Fatalf("track: %+v ok=%v err=%v", got, ok, err)
	}

	other, _ := protojsonMarshal(&lk.WebhookEvent{Event: "room_started", Room: &lk.Room{Name: "301"}})
	if _, ok, err := p.VerifyWebhook(signed(t, other, secret), other); err != nil || ok {
		t.Fatalf("room_started deve ser ignorado: ok=%v err=%v", ok, err)
	}

	for name, c := range map[string]struct {
		auth string
		body []byte
	}{
		"sem header":       {"", body},
		"segredo errado":   {signed(t, body, "outro-segredo-de-teste-com-mais-de-32-bytes"), body},
		"corpo adulterado": {signed(t, body, secret), append([]byte(" "), body...)},
		"lixo":             {"abc", body},
	} {
		if _, _, err := p.VerifyWebhook(c.auth, c.body); !errors.Is(err, voice.ErrInvalidSignature) {
			t.Errorf("%s: err = %v, quer ErrInvalidSignature", name, err)
		}
	}
}

// fakeLiveKit atende o twirp do RoomService e confere a autenticação de administração.
func fakeLiveKit(t *testing.T, handler func(method string, body []byte) (proto.Message, int)) (*httptest.Server, *[]string) {
	t.Helper()
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := strings.TrimPrefix(r.URL.Path, "/twirp/livekit.RoomService/")
		calls = append(calls, method)
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		claims := verify(t, tok)
		if method == "ListRooms" {
			if !claims.Video.RoomList {
				t.Errorf("ListRooms sem roomList: %+v", claims.Video)
			}
		} else if !claims.Video.RoomAdmin || claims.Video.Room == "" {
			t.Errorf("%s sem roomAdmin da sala: %+v", method, claims.Video)
		}
		buf := make([]byte, 1<<16)
		n, _ := r.Body.Read(buf)
		msg, status := handler(method, buf[:n])
		if status != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"code":"not_found","msg":"não existe"}`))
			return
		}
		out, _ := proto.Marshal(msg)
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write(out)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestAdminCalls(t *testing.T) {
	srv, calls := fakeLiveKit(t, func(method string, body []byte) (proto.Message, int) {
		switch method {
		case "RemoveParticipant":
			var req lk.RoomParticipantIdentity
			if err := proto.Unmarshal(body, &req); err != nil || req.Room != "301" || req.Identity != "11" {
				t.Errorf("remove = %+v %v", &req, err)
			}
			return &lk.RemoveParticipantResponse{}, 200
		case "UpdateParticipant":
			var req lk.UpdateParticipantRequest
			if err := proto.Unmarshal(body, &req); err != nil {
				t.Error(err)
			}
			pm := req.Permission
			if pm == nil || !pm.CanSubscribe || !pm.CanPublish || len(pm.CanPublishSources) != 1 || pm.CanPublishSources[0] != lk.TrackSource_MICROPHONE {
				t.Errorf("permissão = %+v", pm)
			}
			return &lk.ParticipantInfo{}, 200
		case "MutePublishedTrack":
			var req lk.MuteRoomTrackRequest
			if err := proto.Unmarshal(body, &req); err != nil || req.Room != "301" || req.Identity != "11" || req.TrackSid != "TR_9" || !req.Muted {
				t.Errorf("mute = %+v %v", &req, err)
			}
			return &lk.MuteRoomTrackResponse{}, 200
		case "ListRooms":
			return &lk.ListRoomsResponse{Rooms: []*lk.Room{{Name: "301", NumParticipants: 2}}}, 200
		case "ListParticipants":
			return &lk.ListParticipantsResponse{Participants: []*lk.ParticipantInfo{
				{Sid: "PA_1", Identity: "11", Tracks: []*lk.TrackInfo{{Source: lk.TrackSource_MICROPHONE}, {Source: lk.TrackSource_CAMERA}}},
			}}, 200
		}
		return nil, 404
	})
	p := newTestProvider(srv.URL)
	ctx := context.Background()
	if err := p.RemoveParticipant(ctx, "301", "11"); err != nil {
		t.Fatal(err)
	}
	if err := p.UpdatePermissions(ctx, "301", "11", voice.GrantsFor(true, false)); err != nil {
		t.Fatal(err)
	}
	if err := p.MuteTrack(ctx, "301", "11", "TR_9"); err != nil {
		t.Fatal(err)
	}
	rooms, err := p.ListRooms(ctx)
	if err != nil || len(rooms) != 1 || rooms[0].Name != "301" || rooms[0].Participants != 2 {
		t.Fatalf("rooms = %+v %v", rooms, err)
	}
	ps, err := p.ListParticipants(ctx, "301")
	if err != nil || len(ps) != 1 || ps[0].Identity != "11" || ps[0].SID != "PA_1" || len(ps[0].Sources) != 2 {
		t.Fatalf("participants = %+v %v", ps, err)
	}
	if len(*calls) != 5 {
		t.Fatalf("chamadas = %v", *calls)
	}
}

func TestNotFoundIsNotAnError(t *testing.T) {
	srv, _ := fakeLiveKit(t, func(string, []byte) (proto.Message, int) { return nil, 404 })
	p := newTestProvider(srv.URL)
	ctx := context.Background()
	if err := p.RemoveParticipant(ctx, "301", "11"); err != nil {
		t.Fatalf("remover inexistente: %v", err)
	}
	if err := p.UpdatePermissions(ctx, "301", "11", voice.Grants{}); err != nil {
		t.Fatalf("atualizar inexistente: %v", err)
	}
	if ps, err := p.ListParticipants(ctx, "301"); err != nil || len(ps) != 0 {
		t.Fatalf("sala inexistente: %v %v", ps, err)
	}
}

func TestUnreachableLiveKitIsAnError(t *testing.T) {
	p := newTestProvider("http://127.0.0.1:1")
	if _, err := p.ListRooms(context.Background()); err == nil {
		t.Fatal("LiveKit fora do ar deve dar erro (o reconciliador não pode remover nada)")
	}
}
