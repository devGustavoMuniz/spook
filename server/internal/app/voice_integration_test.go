//go:build integration

package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	lk "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/utils/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/config"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

const (
	lkKey    = "devkey"
	lkSecret = "segredo-de-teste-do-livekit-com-32-bytes-ou-mais"
)

// fakeLiveKit é a API de administração do LiveKit (twirp) que o backend chama: registra as remoções.
type fakeLiveKit struct {
	srv     *httptest.Server
	mu      sync.Mutex
	removed []string // "sala/identidade"
	updated []string
	rooms   []*lk.Room
	parts   map[string][]*lk.ParticipantInfo
}

func newFakeLiveKit(t *testing.T) *fakeLiveKit {
	t.Helper()
	f := &fakeLiveKit{parts: map[string][]*lk.ParticipantInfo{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := strings.TrimPrefix(r.URL.Path, "/twirp/livekit.RoomService/")
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		defer f.mu.Unlock()
		var out proto.Message
		switch method {
		case "RemoveParticipant":
			var req lk.RoomParticipantIdentity
			_ = proto.Unmarshal(body, &req)
			f.removed = append(f.removed, req.Room+"/"+req.Identity)
			out = &lk.RemoveParticipantResponse{}
		case "UpdateParticipant":
			var req lk.UpdateParticipantRequest
			_ = proto.Unmarshal(body, &req)
			f.updated = append(f.updated, req.Room+"/"+req.Identity)
			out = &lk.ParticipantInfo{}
		case "ListRooms":
			out = &lk.ListRoomsResponse{Rooms: f.rooms}
		case "ListParticipants":
			var req lk.ListParticipantsRequest
			_ = proto.Unmarshal(body, &req)
			out = &lk.ListParticipantsResponse{Participants: f.parts[req.Room]}
		default:
			http.NotFound(w, r)
			return
		}
		b, _ := proto.Marshal(out)
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write(b)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeLiveKit) removedList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.removed...)
}

func (f *fakeLiveKit) hasRemoved(s string) bool {
	for _, r := range f.removedList() {
		if r == s {
			return true
		}
	}
	return false
}

// voiceCfg liga a voz (adaptador real do LiveKit apontando para o falso) e folga os limites.
func voiceCfg(f *fakeLiveKit) func(*Deps) {
	return func(d *Deps) {
		gwCfg(d)
		d.AuthLimiter = ratelimit.New(100000, 100000)
		d.DMLimiter = ratelimit.New(100000, 100000)
		d.Cfg.LiveKit = config.LiveKit{URL: "ws://lk.test:7880", APIKey: lkKey, APISecret: lkSecret, InternalURL: f.srv.URL}
		d.VoiceReconcileEvery = time.Hour // o reconciliador tem teste próprio
	}
}

func signedWebhook(t *testing.T, ev *lk.WebhookEvent, secret string) (body []byte, authz string) {
	t.Helper()
	body, err := protojson.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	authz, err = auth.NewAccessToken(lkKey, secret).SetSha256(base64.StdEncoding.EncodeToString(sum[:])).SetValidFor(time.Minute).ToJWT()
	if err != nil {
		t.Fatal(err)
	}
	return body, authz
}

func (e *testEnv) postWebhook(t *testing.T, body []byte, authz string) int {
	t.Helper()
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/livekit/webhook", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/webhook+json")
	if authz != "" {
		req.Header.Set("Authorization", authz)
	}
	resp, err := http.DefaultClient.Do(req) // sem cookies: o LiveKit não tem sessão
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

var evSeq int

func (e *testEnv) lkEvent(t *testing.T, typ, room string, user *actor, extra func(*lk.WebhookEvent)) int {
	t.Helper()
	evSeq++
	ev := &lk.WebhookEvent{Event: typ, Id: "EV_" + strconv.Itoa(evSeq), Room: &lk.Room{Name: room}}
	if user != nil {
		ev.Participant = &lk.ParticipantInfo{Identity: user.id, Sid: "PA_" + user.id}
	}
	if extra != nil {
		extra(ev)
	}
	body, authz := signedWebhook(t, ev, lkSecret)
	return e.postWebhook(t, body, authz)
}

func (e *testEnv) lkJoin(t *testing.T, room string, u *actor) {
	t.Helper()
	if s := e.lkEvent(t, "participant_joined", room, u, nil); s != 200 {
		t.Fatalf("webhook participant_joined = %d", s)
	}
}

func (c *wsClient) voiceUpdate() J { return payload(c.t, c.event("VOICE_STATE_UPDATE")) }

// voiceUpdateFor lê até o VOICE_STATE_UPDATE do usuário.
func (c *wsClient) voiceUpdateFor(user string) J {
	c.t.Helper()
	for {
		if p := payload(c.t, c.event("VOICE_STATE_UPDATE")); str(p, "user_id") == user {
			return p
		}
	}
}

type tokenResp struct {
	URL       string `json:"url"`
	Token     string `json:"token"`
	ExpiresIn int    `json:"expires_in"`
}

func (a *actor) voiceToken(t *testing.T, channelID string, want int) tokenResp {
	t.Helper()
	b := a.call(t, "POST", "/api/channels/"+channelID+"/voice/token", nil, want)
	var out tokenResp
	if want == 200 {
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

// ---------- token ----------

func TestVoiceDisabledWithoutLiveKitConfig(t *testing.T) {
	e := newEnvWith(t, voiceCfgOff)
	a := e.newActor(t, "voz")
	g := a.createGuild(t, "Sem voz")
	a.voiceToken(t, g.voiceID, 503)
	a.call(t, "POST", "/api/voice/leave", nil, 503)
	a.call(t, "PATCH", "/api/voice/state", J{"self_mute": true, "self_deaf": false}, 503)
	a.call(t, "GET", "/api/guilds/"+g.id+"/voice-states", nil, 503)
	if s := e.postWebhook(t, []byte("{}"), "x"); s != 503 {
		t.Fatalf("webhook sem LiveKit = %d, quer 503", s)
	}
	// O gateway continua funcionando, com voice_states vazio.
	c, ready := a.connectReady(t)
	defer c.ws.CloseNow()
	if vs, ok := ready["voice_states"].([]any); !ok || len(vs) != 0 {
		t.Fatalf("voice_states = %#v", ready["voice_states"])
	}
}

func voiceCfgOff(d *Deps) {
	gwCfg(d)
	d.AuthLimiter = ratelimit.New(100000, 100000)
}

func TestVoiceTokenEndpoint(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, voiceCfg(lkf))
	owner, member, stranger, noConnect := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "estranho"), e.newActor(t, "mudo")
	g := owner.createGuild(t, "Voz")
	base := "/api/guilds/" + g.id
	member.join(t, owner, g.id)
	noConnect.join(t, owner, g.id)

	// 401 sem sessão; 404 para quem não é membro e para IDs ruins; 422 para texto e categoria.
	resp, b := e.do(t, "POST", "/api/channels/"+g.voiceID+"/voice/token", nil, nil)
	status(t, resp, b, 401)
	stranger.voiceToken(t, g.voiceID, 404)
	member.voiceToken(t, "abc", 404)
	member.voiceToken(t, "999999999999", 404)
	member.voiceToken(t, g.textID, 422)
	member.voiceToken(t, g.categoryID, 422)

	// Token do membro: sala, identidade, nome, origens, expiração de 10 min.
	before := time.Now()
	tok := member.voiceToken(t, g.voiceID, 200)
	if tok.URL != "ws://lk.test:7880" || tok.ExpiresIn != 600 || tok.Token == "" {
		t.Fatalf("resposta = %+v", tok)
	}
	claims, exp := decodeToken(t, tok.Token)
	v := claims.Video
	if v == nil || !v.RoomJoin || v.Room != g.voiceID || v.RoomAdmin || v.RoomCreate || v.RoomList || v.RoomRecord {
		t.Fatalf("grant = %+v", v)
	}
	if claims.Identity != member.id || claims.Name != member.name {
		t.Fatalf("identidade = %q nome = %q, quer %q %q", claims.Identity, claims.Name, member.id, member.name)
	}
	if d := exp.Sub(before); d < 10*time.Minute-10*time.Second || d > 10*time.Minute+10*time.Second {
		t.Fatalf("exp daqui a %v, quer ~10 min", d)
	}
	if len(v.CanPublishSources) != 4 || v.CanPublish == nil || !*v.CanPublish || v.CanSubscribe == nil || !*v.CanSubscribe {
		t.Fatalf("origens = %v publish=%v", v.CanPublishSources, v.CanPublish)
	}

	// Sem CONNECT (mas com VIEW_CHANNEL): 403. SPEAK/VIDEO viram origens.
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.ViewChannel | perm.SendMessages | perm.Speak)}, 200)
	connect := owner.role(t, g.id, J{"name": "conecta", "position": 1, "permissions": int64(perm.Connect)})
	noConnect.voiceToken(t, g.voiceID, 403)
	owner.giveRole(t, g.id, noConnect.id, str(connect, "id"))
	claims, _ = decodeToken(t, noConnect.voiceToken(t, g.voiceID, 200).Token)
	if got := claims.Video.CanPublishSources; len(got) != 1 || got[0] != "microphone" {
		t.Fatalf("só SPEAK: %v", got)
	}
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.ViewChannel | perm.Video)}, 200) // sem SPEAK, sem CONNECT (cargo ainda dá)
	claims, _ = decodeToken(t, noConnect.voiceToken(t, g.voiceID, 200).Token)
	if got := claims.Video.CanPublishSources; len(got) != 3 || strings.Contains(strings.Join(got, ","), "microphone") {
		t.Fatalf("só VIDEO: %v", got)
	}
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.ViewChannel)}, 200)
	claims, _ = decodeToken(t, noConnect.voiceToken(t, g.voiceID, 200).Token)
	if claims.Video.CanPublish == nil || *claims.Video.CanPublish || len(claims.Video.CanPublishSources) != 0 {
		t.Fatalf("sem SPEAK/VIDEO: canPublish deveria ser false: %+v", claims.Video)
	}
	// Sem VIEW_CHANNEL: 403 (é membro).
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.SendMessages)}, 200)
	owner.call(t, "PATCH", base+"/roles/"+str(connect, "id"), J{"permissions": int64(perm.Connect)}, 200)
	member.voiceToken(t, g.voiceID, 403)
	noConnect.voiceToken(t, g.voiceID, 403)
	// Dono sempre pode.
	owner.voiceToken(t, g.voiceID, 200)
}

func decodeToken(t *testing.T, tok string) (*auth.ClaimGrants, time.Time) {
	t.Helper()
	v, err := auth.ParseAPIToken(tok)
	if err != nil {
		t.Fatal(err)
	}
	if v.APIKey() != lkKey {
		t.Fatalf("api key = %q", v.APIKey())
	}
	_, claims, err := v.Verify(lkSecret)
	if err != nil {
		t.Fatalf("assinatura do token inválida: %v", err)
	}
	parts := strings.Split(tok, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var m struct {
		Exp int64 `json:"exp"`
	}
	_ = json.Unmarshal(raw, &m)
	return claims, time.Unix(m.Exp, 0)
}

func TestVoiceTokenForDMs(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, voiceCfg(lkf))
	a, b, c, outsider := e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "c"), e.newActor(t, "fora")
	friends(t, "Amigos", a, b, c)
	dm := a.openDM(t, b.id, 201)
	group := a.newGroup(t, 201, b.id, c.id)

	for _, ch := range []J{dm, group} {
		for _, u := range []*actor{a, b} {
			tok := u.voiceToken(t, str(ch, "id"), 200)
			claims, _ := decodeToken(t, tok.Token)
			if claims.Video.Room != str(ch, "id") || len(claims.Video.CanPublishSources) != 4 {
				t.Fatalf("DM %s: %+v", str(ch, "id"), claims.Video)
			}
		}
		outsider.voiceToken(t, str(ch, "id"), 404)
	}
	c.voiceToken(t, str(dm, "id"), 404) // c não participa da DM 1:1 de a e b
	c.voiceToken(t, str(group, "id"), 200)
}

// ---------- webhook ----------

func TestVoiceWebhookSignature(t *testing.T) {
	lkf := newFakeLiveKit(t)
	// Limitador de IP padrão: o webhook fica fora dele (o tráfego vem do container do LiveKit).
	e := newEnvWith(t, func(d *Deps) {
		voiceCfg(lkf)(d)
		d.APILimiter = nil
	})
	ev := &lk.WebhookEvent{Event: "room_started", Room: &lk.Room{Name: "1"}}
	body, authz := signedWebhook(t, ev, lkSecret)
	if s := e.postWebhook(t, body, authz); s != 200 {
		t.Fatalf("assinatura válida = %d", s)
	}
	wrong, wrongAuthz := signedWebhook(t, ev, "outro-segredo-completamente-diferente-32b")
	for name, c := range map[string]struct {
		body  []byte
		authz string
	}{
		"sem header":       {body, ""},
		"segredo errado":   {wrong, wrongAuthz},
		"corpo adulterado": {append([]byte(" "), body...), authz},
		"lixo":             {body, "isto-nao-e-um-jwt"},
	} {
		if s := e.postWebhook(t, c.body, c.authz); s != 401 {
			t.Errorf("%s = %d, quer 401", name, s)
		}
	}
	// 200 requisições seguidas (acima da rajada de 90 do limite geral): nenhuma leva 429.
	for i := 0; i < 200; i++ {
		if s := e.postWebhook(t, body, authz); s != 200 {
			t.Fatalf("requisição %d = %d (o webhook não pode ter rate limit por IP)", i, s)
		}
	}
	// Corpo grande demais.
	if s := e.postWebhook(t, bytes.Repeat([]byte("a"), 2<<20), authz); s != 413 {
		t.Fatalf("corpo de 2 MiB = %d, quer 413", s)
	}
	// Sem sessão de usuário e fora do OpenAPI: não é rota autenticada nem aparece no contrato.
	resp, b := e.do(t, "GET", "/api/openapi.yaml", nil, nil)
	status(t, resp, b, 200)
	if strings.Contains(string(b), "livekit/webhook") {
		t.Fatal("o webhook não deve estar no OpenAPI")
	}
}

func TestVoiceStateFlowOverWebSocket(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, voiceCfg(lkf))
	owner, alice, bob, blind := e.newActor(t, "dono"), e.newActor(t, "alice"), e.newActor(t, "bob"), e.newActor(t, "cego")
	g := owner.createGuild(t, "Chamada")
	base := "/api/guilds/" + g.id
	// @everyone não enxerga nada; o cargo "membro" devolve VIEW_CHANNEL e voz a alice e bob.
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.SendMessages)}, 200)
	vis := owner.role(t, g.id, J{"name": "membro", "position": 1, "permissions": int64(perm.ViewChannel | perm.Connect | perm.Speak | perm.Video)})
	for _, u := range []*actor{alice, bob, blind} {
		u.join(t, owner, g.id)
	}
	owner.giveRole(t, g.id, alice.id, str(vis, "id"))
	owner.giveRole(t, g.id, bob.id, str(vis, "id"))
	other := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 1, "name": "Outra sala"}, 201))

	oc, _ := owner.connectReady(t)
	bc, _ := bob.connectReady(t)
	cc, _ := blind.connectReady(t)

	// PATCH /voice/state fora de voz: 409
	alice.call(t, "PATCH", "/api/voice/state", J{"self_mute": true, "self_deaf": false}, 409)

	// Token + webhook de entrada → VOICE_STATE_UPDATE a quem vê; ninguém sem VIEW_CHANNEL.
	alice.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, alice)
	for _, c := range []*wsClient{oc, bc} {
		p := c.voiceUpdateFor(alice.id)
		if str(p, "channel_id") != g.voiceID || str(p, "guild_id") != g.id || p["self_mute"] != false || p["self_video"] != false || p["self_screen"] != false {
			t.Fatalf("payload = %v", p)
		}
	}
	cc.noEvent(400*time.Millisecond, "VOICE_STATE_UPDATE")

	// Webhook repetido (mesmo ID) não duplica.
	body, authz := signedWebhook(t, &lk.WebhookEvent{Event: "participant_joined", Id: "EV_dup", Room: &lk.Room{Name: g.voiceID},
		Participant: &lk.ParticipantInfo{Identity: alice.id, Sid: "PA_" + alice.id}}, lkSecret)
	for i := 0; i < 3; i++ {
		if s := e.postWebhook(t, body, authz); s != 200 {
			t.Fatal(s)
		}
	}
	oc.noEvent(300*time.Millisecond, "VOICE_STATE_UPDATE")

	// Câmera e tela vêm das origens das tracks.
	if s := e.lkEvent(t, "track_published", g.voiceID, alice, func(ev *lk.WebhookEvent) { ev.Track = &lk.TrackInfo{Sid: "TR_1", Source: lk.TrackSource_CAMERA} }); s != 200 {
		t.Fatal(s)
	}
	if p := oc.voiceUpdateFor(alice.id); p["self_video"] != true || p["self_screen"] != false {
		t.Fatalf("câmera: %v", p)
	}
	if s := e.lkEvent(t, "track_published", g.voiceID, alice, func(ev *lk.WebhookEvent) { ev.Track = &lk.TrackInfo{Sid: "TR_2", Source: lk.TrackSource_SCREEN_SHARE} }); s != 200 {
		t.Fatal(s)
	}
	if p := oc.voiceUpdateFor(alice.id); p["self_screen"] != true {
		t.Fatalf("tela: %v", p)
	}
	if s := e.lkEvent(t, "track_unpublished", g.voiceID, alice, func(ev *lk.WebhookEvent) { ev.Track = &lk.TrackInfo{Sid: "TR_2", Source: lk.TrackSource_SCREEN_SHARE} }); s != 200 {
		t.Fatal(s)
	}
	if p := oc.voiceUpdateFor(alice.id); p["self_screen"] != false || p["self_video"] != true {
		t.Fatalf("tela desligada: %v", p)
	}

	// PATCH /voice/state atualiza e publica.
	got := obj(t, alice.call(t, "PATCH", "/api/voice/state", J{"self_mute": true, "self_deaf": true}, 200))
	if got["self_mute"] != true || got["self_deaf"] != true || str(got, "channel_id") != g.voiceID {
		t.Fatalf("resposta do PATCH = %v", got)
	}
	p := bc.voiceUpdateFor(alice.id)
	for p["self_mute"] != true { // pula os eventos antigos de câmera e tela que bob ainda não leu
		p = bc.voiceUpdateFor(alice.id)
	}
	if p["self_deaf"] != true || p["self_video"] != true {
		t.Fatalf("mute/deaf: %v", p)
	}

	// READY novo: voice_states só com quem o usuário pode ver.
	oc2, ready := owner.connectReady(t)
	vs := list(ready, "voice_states")
	if len(vs) != 1 || str(vs[0], "user_id") != alice.id || str(vs[0], "channel_id") != g.voiceID || vs[0]["self_mute"] != true {
		t.Fatalf("READY.voice_states = %v", ready["voice_states"])
	}
	_ = oc2.ws.CloseNow()
	_, blindReady := blind.connectReady(t)
	if arr, ok := blindReady["voice_states"].([]any); !ok || len(arr) != 0 {
		t.Fatalf("quem não vê o servidor não recebe voice_states: %v", blindReady["voice_states"])
	}
	// Snapshot por REST: membro vê; quem não tem VIEW_CHANNEL leva 403; não-membro, 404.
	states := arr(t, bob.call(t, "GET", "/api/guilds/"+g.id+"/voice-states", nil, 200))
	if len(states) != 1 || str(states[0], "user_id") != alice.id {
		t.Fatalf("voice-states = %v", states)
	}
	blind.call(t, "GET", "/api/guilds/"+g.id+"/voice-states", nil, 403)
	e.newActor(t, "outsider").call(t, "GET", "/api/guilds/"+g.id+"/voice-states", nil, 404)

	// Entrar em outro canal sai do anterior: remove da sala antiga e publica a saída.
	bob.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, bob)
	alice.voiceToken(t, str(other, "id"), 200)
	left := oc.voiceUpdateFor(alice.id)
	for left["channel_id"] != nil {
		left = oc.voiceUpdateFor(alice.id)
	}
	if !lkf.hasRemoved(g.voiceID + "/" + alice.id) {
		t.Fatalf("alice deveria ter sido removida da sala antiga: %v", lkf.removedList())
	}
	e.lkJoin(t, str(other, "id"), alice)
	if p := oc.voiceUpdateFor(alice.id); str(p, "channel_id") != str(other, "id") || p["self_mute"] != true {
		t.Fatalf("entrada na outra sala: %v", p)
	}
	// O webhook de saída da sala antiga chega atrasado: não derruba a nova entrada.
	if s := e.lkEvent(t, "participant_left", g.voiceID, alice, nil); s != 200 {
		t.Fatal(s)
	}
	states = arr(t, bob.call(t, "GET", "/api/guilds/"+g.id+"/voice-states", nil, 200))
	byUser := map[string]string{}
	for _, s := range states {
		byUser[str(s, "user_id")] = str(s, "channel_id")
	}
	if byUser[alice.id] != str(other, "id") || byUser[bob.id] != g.voiceID {
		t.Fatalf("estados = %v", byUser)
	}

	// /voice/leave: sai, é idempotente e publica a saída uma vez.
	bob.call(t, "POST", "/api/voice/leave", nil, 204)
	if p := oc.voiceUpdateFor(bob.id); p["channel_id"] != nil {
		t.Fatalf("saída = %v", p)
	}
	bob.call(t, "POST", "/api/voice/leave", nil, 204)
	if !lkf.hasRemoved(g.voiceID + "/" + bob.id) {
		t.Fatal("leave deve remover do LiveKit")
	}

	// Mudança de permissão no meio da chamada: perde CONNECT → removida e a saída é publicada.
	owner.call(t, "PATCH", base+"/roles/"+str(vis, "id"), J{"permissions": int64(perm.ViewChannel | perm.Speak | perm.Video)}, 200)
	for p := oc.voiceUpdateFor(alice.id); p["channel_id"] != nil; p = oc.voiceUpdateFor(alice.id) {
	}
	if !lkf.hasRemoved(str(other, "id") + "/" + alice.id) {
		t.Fatalf("sem CONNECT a alice deveria ser removida: %v", lkf.removedList())
	}
	states = arr(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/voice-states", nil, 200))
	if len(states) != 0 {
		t.Fatalf("estados = %v", states)
	}
}

func TestVoiceDMStateReachesOnlyParticipants(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, voiceCfg(lkf))
	a, b, c := e.newActor(t, "a"), e.newActor(t, "b"), e.newActor(t, "c")
	friends(t, "Amigos", a, b, c)
	dm := a.openDM(t, b.id, 201)
	id := str(dm, "id")

	bc, _ := b.connectReady(t)
	cc, _ := c.connectReady(t)
	a.voiceToken(t, id, 200)
	e.lkJoin(t, id, a)
	p := bc.voiceUpdateFor(a.id)
	if str(p, "channel_id") != id || p["guild_id"] != nil {
		t.Fatalf("payload de DM = %v", p)
	}
	cc.noEvent(400*time.Millisecond, "VOICE_STATE_UPDATE")

	// READY de b traz o estado da DM.
	_, ready := b.connectReady(t)
	if vs := list(ready, "voice_states"); len(vs) != 1 || str(vs[0], "user_id") != a.id || vs[0]["guild_id"] != nil {
		t.Fatalf("READY.voice_states = %v", ready["voice_states"])
	}
	_, readyC := c.connectReady(t)
	if arr, ok := readyC["voice_states"].([]any); !ok || len(arr) != 0 {
		t.Fatalf("c não participa da DM: %v", readyC["voice_states"])
	}
}

func TestVoiceReconcilerRemovesOrphansAndRegistersMissing(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, func(d *Deps) {
		voiceCfg(lkf)(d)
		d.VoiceReconcileEvery = 200 * time.Millisecond
	})
	owner, alice := e.newActor(t, "dono"), e.newActor(t, "alice")
	g := owner.createGuild(t, "Recon")
	alice.join(t, owner, g.id)
	oc, _ := owner.connectReady(t)

	// O LiveKit "reiniciado" não tem sala nenhuma: a alice (estado criado pelo webhook) é órfã.
	alice.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, alice)
	oc.voiceUpdateFor(alice.id)
	time.Sleep(50 * time.Millisecond) // JoinedAt precisa ser anterior à consulta do reconciliador
	if p := oc.voiceUpdateFor(alice.id); p["channel_id"] != nil {
		t.Fatalf("órfã deveria sair: %v", p)
	}

	// Backend "reiniciado": o LiveKit tem a alice, o estado não. O reconciliador a registra.
	lkf.mu.Lock()
	lkf.rooms = []*lk.Room{{Name: g.voiceID, NumParticipants: 1}}
	lkf.parts[g.voiceID] = []*lk.ParticipantInfo{{Identity: alice.id, Sid: "PA_x", Tracks: []*lk.TrackInfo{{Source: lk.TrackSource_CAMERA}}}}
	lkf.mu.Unlock()
	if p := oc.voiceUpdateFor(alice.id); str(p, "channel_id") != g.voiceID || p["self_video"] != true {
		t.Fatalf("participante desconhecido deveria ser registrado: %v", p)
	}
}

// ---------- prévia da transmissão ----------

// doRaw faz a requisição com um corpo binário (a prévia é image/jpeg, não JSON).
func (a *actor) doRaw(t *testing.T, method, path, contentType string, body []byte) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, a.e.srv.URL+path, bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := a.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

// testJPEG é um JPEG só de marcadores (a API valida sem decodificar) com as dimensões dadas.
func testJPEG(w, h, pad int) []byte {
	b := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46,
		0xFF, 0xC0, 0x00, 0x11, 0x08, byte(h >> 8), byte(h), byte(w >> 8), byte(w), 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
		0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00}
	b = append(b, bytes.Repeat([]byte{0x11}, pad)...)
	return append(b, 0xFF, 0xD9)
}

func TestVoiceScreenPreviewEndpoints(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, voiceCfg(lkf))
	owner, alice, bob, blind, stranger := e.newActor(t, "dono"), e.newActor(t, "alice"), e.newActor(t, "bob"), e.newActor(t, "cego"), e.newActor(t, "estranho")
	g := owner.createGuild(t, "Prévia")
	base := "/api/guilds/" + g.id
	// @everyone não enxerga nada; "membro" vê e conecta; "ouvinte" só vê (sem VIDEO).
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.SendMessages)}, 200)
	vis := owner.role(t, g.id, J{"name": "membro", "position": 1, "permissions": int64(perm.ViewChannel | perm.Connect | perm.Speak | perm.Video)})
	viewer := owner.role(t, g.id, J{"name": "ouvinte", "position": 2, "permissions": int64(perm.ViewChannel | perm.Connect | perm.Speak)})
	for _, u := range []*actor{alice, bob, blind} {
		u.join(t, owner, g.id)
	}
	owner.giveRole(t, g.id, alice.id, str(vis, "id"))
	owner.giveRole(t, g.id, bob.id, str(viewer, "id"))
	oc, _ := owner.connectReady(t)

	path := "/api/channels/" + g.voiceID + "/voice/screen-preview"
	img := testJPEG(320, 180, 800)

	// 401 sem sessão (PUT, DELETE e GET).
	for _, m := range []string{"PUT", "DELETE"} {
		resp, b := e.do(t, m, path, nil, nil)
		status(t, resp, b, 401)
	}
	resp, b := e.do(t, "GET", path+"/"+alice.id, nil, nil)
	status(t, resp, b, 401)

	// Fora do canal: 403. Quem não vê o canal: 404.
	resp, b = alice.doRaw(t, "PUT", path, "image/jpeg", img)
	status(t, resp, b, 403)
	resp, b = blind.doRaw(t, "PUT", path, "image/jpeg", img)
	status(t, resp, b, 404)

	alice.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, alice)
	if s := e.lkEvent(t, "track_published", g.voiceID, alice, func(ev *lk.WebhookEvent) { ev.Track = &lk.TrackInfo{Sid: "TR_S", Source: lk.TrackSource_SCREEN_SHARE} }); s != 200 {
		t.Fatal(s)
	}
	bob.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, bob)

	// Sem VIDEO (bob está na chamada, mas sem permissão de transmitir): 403.
	resp, b = bob.doRaw(t, "PUT", path, "image/jpeg", img)
	status(t, resp, b, 403)

	// Corpo inválido: não é JPEG, dimensões grandes, maior que 64 KB (413).
	resp, b = alice.doRaw(t, "PUT", path, "image/jpeg", []byte("\x89PNG\r\n\x1a\n...."))
	status(t, resp, b, 422)
	resp, b = alice.doRaw(t, "PUT", path, "image/jpeg", testJPEG(1280, 720, 10))
	status(t, resp, b, 422)
	resp, b = alice.doRaw(t, "PUT", path, "image/jpeg", testJPEG(320, 180, 70<<10))
	status(t, resp, b, 413)

	// Envio válido: 204 e o VOICE_STATE_UPDATE passa a trazer screen_preview.
	resp, b = alice.doRaw(t, "PUT", path, "image/jpeg", img)
	status(t, resp, b, 204)
	for {
		if p := oc.voiceUpdateFor(alice.id); p["screen_preview"] == true {
			if p["self_screen"] != true {
				t.Fatalf("payload = %v", p)
			}
			break
		}
	}
	// Limite de frequência: o segundo envio logo em seguida leva 429 com Retry-After.
	resp, b = alice.doRaw(t, "PUT", path, "image/jpeg", img)
	status(t, resp, b, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}

	// Leitura: quem vê o canal (na chamada ou não) recebe o JPEG sem cache; sem acesso, 404; usuário sem prévia, 404.
	for _, who := range []*actor{owner, bob} {
		resp, b = who.doRaw(t, "GET", path+"/"+alice.id, "", nil)
		status(t, resp, b, 200)
		if resp.Header.Get("Content-Type") != "image/jpeg" || resp.Header.Get("Cache-Control") != "no-store" || !bytes.Equal(b, img) {
			t.Fatalf("GET: tipo=%q cache=%q bytes=%d", resp.Header.Get("Content-Type"), resp.Header.Get("Cache-Control"), len(b))
		}
	}
	for _, who := range []*actor{blind, stranger} {
		resp, b = who.doRaw(t, "GET", path+"/"+alice.id, "", nil)
		status(t, resp, b, 404)
	}
	resp, b = owner.doRaw(t, "GET", path+"/"+bob.id, "", nil)
	status(t, resp, b, 404)
	resp, b = owner.doRaw(t, "GET", path+"/abc", "", nil)
	status(t, resp, b, 404)

	// DELETE apaga (idempotente), a leitura passa a dar 404 e o indicador desliga.
	alice.call(t, "DELETE", path, nil, 204)
	resp, b = owner.doRaw(t, "GET", path+"/"+alice.id, "", nil)
	status(t, resp, b, 404)
	for {
		if p := oc.voiceUpdateFor(alice.id); p["screen_preview"] == false {
			break
		}
	}
	alice.call(t, "DELETE", path, nil, 204)
}
