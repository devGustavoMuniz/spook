package voice_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
	"github.com/devGustavoMuniz/spook/server/internal/voice/memory"
)

// ---- falsos ----

type fakeProvider struct {
	mu           sync.Mutex
	tokens       []voice.TokenRequest
	removed      [][2]string // sala, identidade
	updated      []updateCall
	rooms        []voice.Room
	participants map[string][]voice.Participant
	listErr      error
	webhook      voice.RoomEvent
	webhookOK    bool
	webhookErr   error
}

type updateCall struct {
	Room, Identity string
	Grants         voice.Grants
}

func newProvider() *fakeProvider {
	return &fakeProvider{participants: map[string][]voice.Participant{}, webhookOK: true}
}

func (p *fakeProvider) PublicURL() string { return "ws://livekit.test" }
func (p *fakeProvider) IssueToken(r voice.TokenRequest) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.tokens = append(p.tokens, r)
	return "jwt", nil
}
func (p *fakeProvider) RemoveParticipant(_ context.Context, room, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.removed = append(p.removed, [2]string{room, id})
	return nil
}
func (p *fakeProvider) UpdatePermissions(_ context.Context, room, id string, g voice.Grants) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.updated = append(p.updated, updateCall{room, id, g})
	return nil
}
func (p *fakeProvider) ListRooms(context.Context) ([]voice.Room, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.rooms, p.listErr
}
func (p *fakeProvider) ListParticipants(_ context.Context, room string) ([]voice.Participant, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.listErr != nil {
		return nil, p.listErr
	}
	return p.participants[room], nil
}
func (p *fakeProvider) VerifyWebhook(string, []byte) (voice.RoomEvent, bool, error) {
	return p.webhook, p.webhookOK, p.webhookErr
}
func (p *fakeProvider) lastToken() voice.TokenRequest { return p.tokens[len(p.tokens)-1] }

type fakeAccess struct {
	mod      error
	modGuild int64
	mu       sync.Mutex
	channels map[[2]int64]voice.ChannelAccess
	errs     map[[2]int64]error
	guilds   map[[2]int64]error
}

func newAccess() *fakeAccess {
	return &fakeAccess{channels: map[[2]int64]voice.ChannelAccess{}, errs: map[[2]int64]error{}, guilds: map[[2]int64]error{}}
}

func (a *fakeAccess) set(user, ch int64, acc voice.ChannelAccess) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.channels[[2]int64{user, ch}] = acc
	delete(a.errs, [2]int64{user, ch})
}

func (a *fakeAccess) fail(user, ch int64, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.errs[[2]int64{user, ch}] = err
}

func (a *fakeAccess) Channel(_ context.Context, user, ch int64) (voice.ChannelAccess, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.errs[[2]int64{user, ch}]; err != nil {
		return voice.ChannelAccess{}, err
	}
	acc, ok := a.channels[[2]int64{user, ch}]
	if !ok {
		return voice.ChannelAccess{}, apperr.NotFound("canal não encontrado")
	}
	return acc, nil
}

func (a *fakeAccess) ViewableChannels(_ context.Context, user, guild int64) (map[int64]struct{}, error) {
	if err := a.guilds[[2]int64{user, guild}]; err != nil {
		return nil, err
	}
	out := map[int64]struct{}{}
	for k := range a.channels { // todos os canais configurados para o usuário
		if k[0] == user {
			out[k[1]] = struct{}{}
		}
	}
	return out, nil
}

func (a *fakeAccess) Moderate(_ context.Context, actor, ch, target int64) (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.mod; err != nil {
		return 0, err
	}
	return a.modGuild, nil
}

type fakeUsers struct{}

func (fakeUsers) Username(_ context.Context, id int64) (string, error) { return "user" + itoa(id), nil }

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

type recorder struct {
	mu sync.Mutex
	ev []events.Event
}

func (r *recorder) Publish(e events.Event) { r.mu.Lock(); r.ev = append(r.ev, e); r.mu.Unlock() }
func (r *recorder) all() []events.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]events.Event(nil), r.ev...)
}
func (r *recorder) last() voice.StatePayload {
	e := r.all()
	return e[len(e)-1].Data.(voice.StatePayload)
}
func (r *recorder) reset() { r.mu.Lock(); r.ev = nil; r.mu.Unlock() }

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

type env struct {
	svc  *voice.Service
	prov *fakeProvider
	acc  *fakeAccess
	pub  *recorder
	st   *memory.Store
	pv   *memory.Previews
	clk  *clock
}

const (
	guild1 int64 = 100
	voiceA int64 = 301
	voiceB int64 = 302
	dm1    int64 = 500
	alice  int64 = 11
	bob    int64 = 12
)

func full() voice.ChannelAccess {
	return voice.ChannelAccess{Type: voice.ChannelTypeVoice, GuildID: guild1, CanConnect: true, CanSpeak: true, CanVideo: true}
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{prov: newProvider(), acc: newAccess(), pub: &recorder{}, st: memory.New(), pv: memory.NewPreviews(),
		clk: &clock{t: time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)}}
	e.svc = voice.NewService(voice.Deps{Provider: e.prov, Store: e.st, Previews: e.pv, Access: e.acc, Users: fakeUsers{}, Pub: e.pub, Now: e.clk.now})
	for _, u := range []int64{alice, bob} {
		e.acc.set(u, voiceA, full())
		e.acc.set(u, voiceB, func() voice.ChannelAccess { a := full(); return a }())
		e.acc.set(u, dm1, voice.ChannelAccess{Type: voice.ChannelTypeGroupDM, CanConnect: true, CanSpeak: true, CanVideo: true})
	}
	return e
}

// webhook injeta um evento já "verificado" e o processa.
func (e *env) webhook(t *testing.T, ev voice.RoomEvent) error {
	t.Helper()
	e.prov.webhook = ev
	return e.svc.HandleWebhook(context.Background(), "Bearer x", []byte("{}"))
}

func (e *env) join(t *testing.T, user, ch int64, sid string, tracks ...voice.Source) {
	t.Helper()
	if err := e.webhook(t, voice.RoomEvent{Type: voice.EventParticipantJoined, Room: itoa(ch), Identity: itoa(user), SID: sid, Tracks: tracks}); err != nil {
		t.Fatal(err)
	}
}

func (e *env) token(t *testing.T, user, ch int64) voice.TokenResponse {
	t.Helper()
	r, err := e.svc.IssueToken(context.Background(), user, ch)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func kind(err error) apperr.Kind {
	if ae, ok := apperr.As(err); ok {
		return ae.Kind
	}
	return 0
}

// ---- token ----

func TestTokenGrantsMatrix(t *testing.T) {
	tests := []struct {
		name         string
		speak, video bool
		want         []voice.Source
	}{
		{"tudo", true, true, []voice.Source{voice.SourceMicrophone, voice.SourceCamera, voice.SourceScreenShare, voice.SourceScreenShareAudio}},
		{"só SPEAK", true, false, []voice.Source{voice.SourceMicrophone}},
		{"só VIDEO", false, true, []voice.Source{voice.SourceCamera, voice.SourceScreenShare, voice.SourceScreenShareAudio}},
		{"nenhuma", false, false, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			a := full()
			a.CanSpeak, a.CanVideo = tt.speak, tt.video
			e.acc.set(alice, voiceA, a)
			resp := e.token(t, alice, voiceA)
			req := e.prov.lastToken()
			if len(req.Grants.Publish) != len(tt.want) {
				t.Fatalf("origens = %v, quer %v", req.Grants.Publish, tt.want)
			}
			for i, s := range tt.want {
				if req.Grants.Publish[i] != s {
					t.Fatalf("origens = %v, quer %v", req.Grants.Publish, tt.want)
				}
			}
			if req.Grants.CanPublish() != (len(tt.want) > 0) {
				t.Fatal("CanPublish inconsistente")
			}
			if req.Room != "301" || req.Identity != "11" || req.Name != "user11" || req.TTL != 10*time.Minute {
				t.Fatalf("token = %+v", req)
			}
			if resp.URL != "ws://livekit.test" || resp.Token != "jwt" || resp.ExpiresIn != 600 {
				t.Fatalf("resposta = %+v", resp)
			}
		})
	}
}

func TestTokenDMGivesAllSources(t *testing.T) {
	e := newEnv(t)
	for _, ch := range []int64{dm1, 501} {
		typ := voice.ChannelTypeGroupDM
		if ch == 501 {
			typ = voice.ChannelTypeDM
		}
		// Mesmo que o adaptador sinalize false, DM sempre dá as quatro origens.
		e.acc.set(alice, ch, voice.ChannelAccess{Type: typ, CanConnect: true})
		e.token(t, alice, ch)
		g := e.prov.lastToken().Grants
		for _, s := range []voice.Source{voice.SourceMicrophone, voice.SourceCamera, voice.SourceScreenShare, voice.SourceScreenShareAudio} {
			if !g.Has(s) {
				t.Fatalf("DM %d sem %s", ch, s)
			}
		}
		if e.prov.lastToken().Room != itoa(ch) {
			t.Fatal("sala deve ser o ID da DM")
		}
	}
}

func TestTokenErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()

	e.acc.set(alice, 900, voice.ChannelAccess{Type: 0, GuildID: guild1, CanConnect: true})
	if _, err := e.svc.IssueToken(ctx, alice, 900); kind(err) != apperr.KindInvalid {
		t.Fatalf("canal de texto: %v", err)
	}
	e.acc.set(alice, 901, voice.ChannelAccess{Type: 2, GuildID: guild1, CanConnect: true})
	if _, err := e.svc.IssueToken(ctx, alice, 901); kind(err) != apperr.KindInvalid {
		t.Fatalf("categoria: %v", err)
	}
	a := full()
	a.CanConnect = false
	e.acc.set(alice, voiceA, a)
	if _, err := e.svc.IssueToken(ctx, alice, voiceA); kind(err) != apperr.KindForbidden {
		t.Fatalf("sem CONNECT: %v", err)
	}
	e.acc.fail(alice, voiceB, apperr.Forbidden("sem VIEW_CHANNEL"))
	if _, err := e.svc.IssueToken(ctx, alice, voiceB); kind(err) != apperr.KindForbidden {
		t.Fatalf("sem VIEW_CHANNEL: %v", err)
	}
	if _, err := e.svc.IssueToken(ctx, alice, 12345); kind(err) != apperr.KindNotFound {
		t.Fatalf("não-membro/inexistente: %v", err)
	}
	if len(e.prov.tokens) != 0 {
		t.Fatal("nenhum token deveria ter sido emitido")
	}

	off := voice.NewService(voice.Deps{Store: memory.New(), Access: e.acc, Users: fakeUsers{}})
	if _, err := off.IssueToken(ctx, alice, voiceA); kind(err) != apperr.KindUnavailable {
		t.Fatalf("voz desligada: %v", err)
	}
	if err := off.Leave(ctx, alice); kind(err) != apperr.KindUnavailable {
		t.Fatalf("leave desligado: %v", err)
	}
	if got := off.Snapshot([]int64{guild1}, nil); got == nil || len(got) != 0 {
		t.Fatalf("snapshot desligado deve ser []: %#v", got)
	}
}

// ---- um canal por vez (SPEC 7.7) ----

func TestOnlyOneChannelAtATime(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1")
	if got := e.pub.last(); got.ChannelID == nil || *got.ChannelID != "301" {
		t.Fatalf("entrada não publicada: %+v", got)
	}
	e.pub.reset()

	e.token(t, alice, voiceB) // entrar em outro sai do anterior
	if len(e.prov.removed) != 1 || e.prov.removed[0] != [2]string{"301", "11"} {
		t.Fatalf("removidos = %v", e.prov.removed)
	}
	if _, ok := e.st.Get(alice); ok {
		t.Fatal("estado antigo deveria ter sido limpo")
	}
	if got := e.pub.last(); got.ChannelID != nil || got.UserID != "11" || *got.GuildID != "100" {
		t.Fatalf("saída não publicada: %+v", got)
	}
	if ev := e.pub.all()[0]; ev.Type != events.VoiceStateUpdate || ev.GuildID != guild1 || ev.ChannelID != voiceA ||
		len(ev.Topics) != 1 || ev.Topics[0] != "guild:100" {
		t.Fatalf("evento = %+v", ev)
	}

	// O webhook da saída da sala antiga chega depois e não deve apagar nada.
	if err := e.webhook(t, voice.RoomEvent{Type: voice.EventParticipantLeft, Room: "301", Identity: "11", SID: "PA_1"}); err != nil {
		t.Fatal(err)
	}
	e.join(t, alice, voiceB, "PA_2")
	st, ok := e.st.Get(alice)
	if !ok || st.ChannelID != voiceB {
		t.Fatalf("estado = %+v %v", st, ok)
	}
	// Só o evento de entrada em B depois do reset (A→B não duplicou saída).
	if n := len(e.pub.all()); n != 2 {
		t.Fatalf("eventos = %d, quer 2 (saída de A, entrada em B)", n)
	}
}

func TestMuteCarriesAcrossChannelSwitch(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1")
	if _, err := e.svc.SetSelfState(context.Background(), alice, true, true); err != nil {
		t.Fatal(err)
	}
	e.token(t, alice, voiceB)
	e.join(t, alice, voiceB, "PA_2")
	if st, _ := e.st.Get(alice); !st.SelfMute || !st.SelfDeaf {
		t.Fatalf("mute/deaf deveriam acompanhar a troca: %+v", st)
	}
}

func TestStaleTokenJoinIsKicked(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.token(t, alice, voiceB) // pendente passa a ser B
	e.prov.removed = nil
	e.join(t, alice, voiceA, "PA_old") // conexão com o token velho
	if len(e.prov.removed) != 1 || e.prov.removed[0] != [2]string{"301", "11"} {
		t.Fatalf("a entrada com token velho deveria ser derrubada: %v", e.prov.removed)
	}
	if _, ok := e.st.Get(alice); ok {
		t.Fatal("não deveria haver estado")
	}
	if len(e.pub.all()) != 0 {
		t.Fatal("nenhum evento esperado")
	}
}

func TestJoinWhileInOtherChannelWithoutTokenIsKicked(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1")
	e.clk.advance(2 * voice.PendingTTL)
	e.prov.removed = nil
	e.join(t, alice, voiceB, "PA_2")
	if len(e.prov.removed) != 1 || e.prov.removed[0][0] != "302" {
		t.Fatalf("removidos = %v", e.prov.removed)
	}
	if st, _ := e.st.Get(alice); st.ChannelID != voiceA {
		t.Fatal("continua em A")
	}
}

func TestPendingExpiresButJoinStillAccepted(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.clk.advance(2 * voice.PendingTTL) // o token ainda vale 10 min
	e.join(t, alice, voiceA, "PA_1")
	if _, ok := e.st.Get(alice); !ok {
		t.Fatal("entrada com token válido deveria ser aceita")
	}
}

func TestLeaveIsIdempotent(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if err := e.svc.Leave(ctx, alice); err != nil || len(e.pub.all()) != 0 || len(e.prov.removed) != 0 {
		t.Fatalf("sair sem estar em voz: err=%v", err)
	}
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1")
	if err := e.svc.Leave(ctx, alice); err != nil {
		t.Fatal(err)
	}
	if got := e.pub.last(); got.ChannelID != nil {
		t.Fatalf("saída = %+v", got)
	}
	if len(e.prov.removed) != 1 {
		t.Fatalf("removidos = %v", e.prov.removed)
	}
	n := len(e.pub.all())
	if err := e.svc.Leave(ctx, alice); err != nil || len(e.pub.all()) != n {
		t.Fatal("segunda saída não pode publicar de novo")
	}
	// E o token pendente foi descartado: entrada sem token novo vale pela regra "sem pendente".
	if _, ok := e.st.Get(alice); ok {
		t.Fatal("estado deveria estar vazio")
	}
}

// ---- webhooks ----

func TestWebhookStateTransitions(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1")
	ev := e.pub.all()[0]
	if ev.Topics[0] != "guild:100" || ev.GuildID != guild1 || ev.ChannelID != voiceA {
		t.Fatalf("evento = %+v", ev)
	}
	p := e.pub.last()
	if p.SelfVideo || p.SelfScreen || p.SelfMute || p.SelfDeaf {
		t.Fatalf("estado inicial = %+v", p)
	}

	pub := func(typ string, src voice.Source) {
		t.Helper()
		if err := e.webhook(t, voice.RoomEvent{Type: typ, Room: "301", Identity: "11", Source: src}); err != nil {
			t.Fatal(err)
		}
	}
	pub(voice.EventTrackPublished, voice.SourceCamera)
	if !e.pub.last().SelfVideo || e.pub.last().SelfScreen {
		t.Fatalf("câmera: %+v", e.pub.last())
	}
	pub(voice.EventTrackPublished, voice.SourceScreenShare)
	if !e.pub.last().SelfScreen {
		t.Fatalf("tela: %+v", e.pub.last())
	}
	n := len(e.pub.all())
	pub(voice.EventTrackPublished, voice.SourceMicrophone)  // microfone não muda nada: sem evento
	pub(voice.EventTrackPublished, voice.SourceScreenShare) // repetido
	if len(e.pub.all()) != n {
		t.Fatal("eventos sem mudança não devem ser publicados")
	}
	pub(voice.EventTrackUnpublished, voice.SourceCamera)
	if e.pub.last().SelfVideo || !e.pub.last().SelfScreen {
		t.Fatalf("câmera desligada: %+v", e.pub.last())
	}
	pub(voice.EventTrackUnpublished, voice.SourceScreenShare)
	if e.pub.last().SelfScreen {
		t.Fatalf("tela desligada: %+v", e.pub.last())
	}

	if err := e.webhook(t, voice.RoomEvent{Type: voice.EventParticipantLeft, Room: "301", Identity: "11", SID: "PA_1"}); err != nil {
		t.Fatal(err)
	}
	if e.pub.last().ChannelID != nil {
		t.Fatalf("saída = %+v", e.pub.last())
	}
	if _, ok := e.st.Get(alice); ok {
		t.Fatal("estado deveria ter sido removido")
	}
}

func TestWebhookJoinCarriesPublishedTracks(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1", voice.SourceMicrophone, voice.SourceCamera)
	if p := e.pub.last(); !p.SelfVideo || p.SelfScreen {
		t.Fatalf("estado = %+v", p)
	}
}

func TestWebhookIsIdempotent(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	ev := voice.RoomEvent{ID: "EV_1", Type: voice.EventParticipantJoined, Room: "301", Identity: "11", SID: "PA_1"}
	for i := 0; i < 3; i++ { // reenvios do mesmo evento
		if err := e.webhook(t, ev); err != nil {
			t.Fatal(err)
		}
	}
	if len(e.pub.all()) != 1 {
		t.Fatalf("eventos = %d, quer 1", len(e.pub.all()))
	}
	// Mesmo sem ID, a mesma transição repetida não publica de novo.
	ev.ID = ""
	if err := e.webhook(t, ev); err != nil || len(e.pub.all()) != 1 {
		t.Fatalf("join repetido sem ID: err=%v eventos=%d", err, len(e.pub.all()))
	}
	left := voice.RoomEvent{Type: voice.EventParticipantLeft, Room: "301", Identity: "11", SID: "PA_1"}
	for i := 0; i < 2; i++ {
		if err := e.webhook(t, left); err != nil {
			t.Fatal(err)
		}
	}
	if len(e.pub.all()) != 2 {
		t.Fatalf("eventos = %d, quer 2", len(e.pub.all()))
	}
}

func TestWebhookReconnectKeepsNewConnection(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_old")
	e.token(t, alice, voiceA) // reconexão (mesmo canal)
	e.join(t, alice, voiceA, "PA_new")
	// A saída da conexão antiga chega depois da entrada da nova.
	if err := e.webhook(t, voice.RoomEvent{Type: voice.EventParticipantLeft, Room: "301", Identity: "11", SID: "PA_old"}); err != nil {
		t.Fatal(err)
	}
	if st, ok := e.st.Get(alice); !ok || st.SID != "PA_new" {
		t.Fatalf("a conexão nova deveria continuar: %+v %v", st, ok)
	}
}

func TestWebhookRoomFinishedClearsEveryone(t *testing.T) {
	e := newEnv(t)
	for _, u := range []int64{alice, bob} {
		e.token(t, u, voiceA)
		e.join(t, u, voiceA, "PA_"+itoa(u))
	}
	e.pub.reset()
	if err := e.webhook(t, voice.RoomEvent{Type: voice.EventRoomFinished, Room: "301"}); err != nil {
		t.Fatal(err)
	}
	if len(e.pub.all()) != 2 || len(e.st.ByChannel(voiceA)) != 0 {
		t.Fatalf("eventos=%d estados=%d", len(e.pub.all()), len(e.st.ByChannel(voiceA)))
	}
}

func TestWebhookDMUsesChannelTopic(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, dm1)
	e.join(t, alice, dm1, "PA_1")
	ev := e.pub.all()[0]
	if ev.GuildID != 0 || ev.ChannelID != dm1 || len(ev.Topics) != 1 || ev.Topics[0] != "channel:500" {
		t.Fatalf("evento de DM = %+v", ev)
	}
	if p := e.pub.last(); p.GuildID != nil || *p.ChannelID != "500" {
		t.Fatalf("payload de DM = %+v", p)
	}
}

func TestWebhookIgnoresForeignRoomsAndIdentities(t *testing.T) {
	e := newEnv(t)
	for _, ev := range []voice.RoomEvent{
		{Type: voice.EventParticipantJoined, Room: "sala-qualquer", Identity: "11"},
		{Type: voice.EventParticipantJoined, Room: "301", Identity: "egress-xyz"},
	} {
		if err := e.webhook(t, ev); err != nil {
			t.Fatal(err)
		}
	}
	e.prov.webhookOK = false // evento que o adaptador ignora (room_started etc.)
	if err := e.webhook(t, voice.RoomEvent{Type: "room_started", Room: "301"}); err != nil {
		t.Fatal(err)
	}
	if len(e.pub.all()) != 0 {
		t.Fatal("nada deveria ser publicado")
	}
}

func TestWebhookRejectsInvalidSignature(t *testing.T) {
	e := newEnv(t)
	e.prov.webhookErr = voice.ErrInvalidSignature
	err := e.svc.HandleWebhook(context.Background(), "", []byte("{}"))
	if !errors.Is(err, voice.ErrInvalidSignature) {
		t.Fatalf("err = %v", err)
	}
}

func TestWebhookJoinWithoutPermissionIsKicked(t *testing.T) {
	e := newEnv(t)
	a := full()
	a.CanConnect = false
	e.acc.set(alice, voiceA, a)
	e.join(t, alice, voiceA, "PA_1")
	if _, ok := e.st.Get(alice); ok || len(e.prov.removed) != 1 {
		t.Fatalf("sem CONNECT não entra: removed=%v", e.prov.removed)
	}
}

// ---- mute / deafen ----

func TestSetSelfState(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.svc.SetSelfState(ctx, alice, true, false); kind(err) != apperr.KindConflict {
		t.Fatalf("fora de voz: %v", err)
	}
	e.token(t, alice, voiceA)
	// Entre o token e o webhook: guardado, aplicado na entrada, sem evento.
	p, err := e.svc.SetSelfState(ctx, alice, true, false)
	if err != nil || !p.SelfMute || *p.ChannelID != "301" || len(e.pub.all()) != 0 {
		t.Fatalf("pendente: %+v %v", p, err)
	}
	e.join(t, alice, voiceA, "PA_1")
	if !e.pub.last().SelfMute {
		t.Fatalf("mute deveria valer na entrada: %+v", e.pub.last())
	}
	n := len(e.pub.all())
	if _, err := e.svc.SetSelfState(ctx, alice, true, true); err != nil {
		t.Fatal(err)
	}
	if got := e.pub.last(); !got.SelfDeaf || !got.SelfMute || len(e.pub.all()) != n+1 {
		t.Fatalf("deaf: %+v", got)
	}
	if _, err := e.svc.SetSelfState(ctx, alice, true, true); err != nil || len(e.pub.all()) != n+1 {
		t.Fatal("sem mudança não publica")
	}
}

// ---- snapshots ----

func TestSnapshotsAndGuildStates(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1")
	e.token(t, bob, dm1)
	e.join(t, bob, dm1, "PA_2")

	got := e.svc.Snapshot([]int64{guild1}, []int64{dm1})
	if len(got) != 2 {
		t.Fatalf("snapshot = %+v", got)
	}
	if got := e.svc.Snapshot([]int64{999}, nil); got == nil || len(got) != 0 {
		t.Fatalf("snapshot vazio deve ser []: %#v", got)
	}
	states, err := e.svc.GuildStates(context.Background(), bob, guild1)
	if err != nil || len(states) != 1 || states[0].UserID != "11" {
		t.Fatalf("guild states = %+v %v", states, err)
	}
	e.acc.guilds[[2]int64{bob, guild1}] = apperr.NotFound("servidor não encontrado")
	if _, err := e.svc.GuildStates(context.Background(), bob, guild1); kind(err) != apperr.KindNotFound {
		t.Fatalf("não-membro: %v", err)
	}
}

// ---- mudança de permissão ----

func guildEvent(typ string) events.Event { return events.Event{Type: typ, GuildID: guild1} }

func TestPermissionLossRemovesFromRoom(t *testing.T) {
	for _, typ := range []string{events.RoleUpdate, events.RoleDelete, events.GuildMemberUpdate, events.GuildMemberRemove, events.ChannelUpdate, events.ChannelDelete} {
		t.Run(typ, func(t *testing.T) {
			e := newEnv(t)
			e.token(t, alice, voiceA)
			e.join(t, alice, voiceA, "PA_1")
			e.token(t, bob, voiceA)
			e.join(t, bob, voiceA, "PA_2")
			e.pub.reset()

			a := full()
			a.CanConnect = false
			e.acc.set(alice, voiceA, a)
			e.svc.OnEvent(guildEvent(typ))

			if _, ok := e.st.Get(alice); ok {
				t.Fatal("alice perdeu CONNECT: deveria sair")
			}
			if _, ok := e.st.Get(bob); !ok {
				t.Fatal("bob não deveria ser afetado")
			}
			if len(e.prov.removed) != 1 || e.prov.removed[0] != [2]string{"301", "11"} {
				t.Fatalf("removidos = %v", e.prov.removed)
			}
			if p := e.pub.last(); p.ChannelID != nil || p.UserID != "11" {
				t.Fatalf("saída = %+v", p)
			}
		})
	}
}

func TestViewChannelLossAndMemberRemovalEvict(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1")
	e.token(t, bob, voiceA)
	e.join(t, bob, voiceA, "PA_2")
	e.acc.fail(alice, voiceA, apperr.Forbidden("sem VIEW_CHANNEL"))
	e.acc.fail(bob, voiceA, apperr.NotFound("não é membro"))
	e.svc.OnEvent(guildEvent(events.RoleUpdate))
	if len(e.st.ByChannel(voiceA)) != 0 || len(e.prov.removed) != 2 {
		t.Fatalf("estados=%d removidos=%v", len(e.st.ByChannel(voiceA)), e.prov.removed)
	}
}

func TestInfraErrorDuringReevaluationKeepsParticipant(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1")
	e.acc.fail(alice, voiceA, errors.New("banco fora do ar"))
	e.svc.OnEvent(guildEvent(events.RoleUpdate))
	if _, ok := e.st.Get(alice); !ok || len(e.prov.removed) != 0 {
		t.Fatal("erro de infraestrutura não pode derrubar ninguém")
	}
}

func TestSpeakAndVideoChangesUpdateLiveKit(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1", voice.SourceCamera)
	e.pub.reset()

	// Perde VIDEO: o LiveKit passa a permitir só o microfone e a câmera some do estado.
	a := full()
	a.CanVideo = false
	e.acc.set(alice, voiceA, a)
	e.svc.OnEvent(guildEvent(events.RoleUpdate))
	if len(e.prov.updated) != 1 {
		t.Fatalf("updates = %+v", e.prov.updated)
	}
	u := e.prov.updated[0]
	if u.Room != "301" || u.Identity != "11" || !u.Grants.Has(voice.SourceMicrophone) || u.Grants.Has(voice.SourceCamera) || u.Grants.Has(voice.SourceScreenShare) {
		t.Fatalf("update = %+v", u)
	}
	if p := e.pub.last(); p.SelfVideo || p.ChannelID == nil {
		t.Fatalf("câmera deveria sair do estado: %+v", p)
	}
	if len(e.prov.removed) != 0 {
		t.Fatal("continua na sala")
	}

	// Sem mudança: nenhuma chamada nova.
	e.svc.OnEvent(guildEvent(events.RoleUpdate))
	if len(e.prov.updated) != 1 {
		t.Fatal("sem mudança de permissão não deve chamar o LiveKit")
	}

	// Perde SPEAK também: nada pode ser publicado.
	a.CanSpeak = false
	e.acc.set(alice, voiceA, a)
	e.svc.OnEvent(guildEvent(events.GuildMemberUpdate))
	if len(e.prov.updated) != 2 || e.prov.updated[1].Grants.CanPublish() {
		t.Fatalf("updates = %+v", e.prov.updated)
	}

	// Recupera tudo.
	e.acc.set(alice, voiceA, full())
	e.svc.OnEvent(guildEvent(events.RoleUpdate))
	if len(e.prov.updated) != 3 || len(e.prov.updated[2].Grants.Publish) != 4 {
		t.Fatalf("updates = %+v", e.prov.updated)
	}
}

func TestDMChannelEventsReevaluateParticipants(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, dm1)
	e.join(t, alice, dm1, "PA_1")
	e.token(t, bob, dm1)
	e.join(t, bob, dm1, "PA_2")
	e.acc.fail(bob, dm1, apperr.NotFound("saiu da DM"))
	e.svc.OnEvent(events.Event{Type: events.ChannelUpdate, ChannelID: dm1})
	if _, ok := e.st.Get(bob); ok {
		t.Fatal("quem saiu da DM deveria sair da chamada")
	}
	if _, ok := e.st.Get(alice); !ok {
		t.Fatal("alice continua")
	}
	// Eventos que não mexem em acesso são ignorados.
	e.svc.OnEvent(events.Event{Type: events.MessageCreate, GuildID: guild1})
}

// ---- reconciliador ----

func TestReconcileRemovesOrphans(t *testing.T) {
	e := newEnv(t)
	for _, u := range []int64{alice, bob} {
		e.token(t, u, voiceA)
		e.join(t, u, voiceA, "PA_"+itoa(u))
	}
	e.clk.advance(time.Minute)
	// O LiveKit só conhece a alice (reiniciou / webhook perdido para o bob).
	e.prov.rooms = []voice.Room{{Name: "301", Participants: 1}}
	e.prov.participants["301"] = []voice.Participant{{Identity: "11", SID: "PA_11"}}
	e.pub.reset()
	if err := e.svc.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.st.Get(bob); ok {
		t.Fatal("bob é órfão")
	}
	if _, ok := e.st.Get(alice); !ok {
		t.Fatal("alice é real")
	}
	if p := e.pub.last(); p.UserID != "12" || p.ChannelID != nil {
		t.Fatalf("saída do órfão = %+v", p)
	}
	if len(e.prov.removed) != 0 {
		t.Fatal("órfão já não está no LiveKit: não precisa remover")
	}

	// LiveKit reiniciado: nenhuma sala. Sobra ninguém.
	e.prov.rooms, e.prov.participants = nil, map[string][]voice.Participant{}
	if err := e.svc.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(e.st.ByChannel(voiceA)) != 0 {
		t.Fatal("todos os estados eram órfãos")
	}
}

func TestReconcileDoesNotRemoveRecentJoinsOrOnErrors(t *testing.T) {
	e := newEnv(t)
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1") // entrou "agora": pode ser um webhook mais novo que a lista
	if err := e.svc.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.st.Get(alice); !ok {
		t.Fatal("entrada recente não pode ser tratada como órfã")
	}
	e.clk.advance(time.Minute)
	e.prov.listErr = errors.New("livekit fora do ar")
	if err := e.svc.Reconcile(context.Background()); err == nil {
		t.Fatal("deveria falhar")
	}
	if _, ok := e.st.Get(alice); !ok {
		t.Fatal("falha ao consultar o LiveKit nunca remove estados")
	}
}

func TestReconcileRegistersUnknownParticipantsAndSyncsTracks(t *testing.T) {
	e := newEnv(t)
	// Backend reiniciou: a alice está na sala, mas o estado se perdeu.
	e.prov.rooms = []voice.Room{{Name: "301", Participants: 2}}
	e.prov.participants["301"] = []voice.Participant{
		{Identity: "11", SID: "PA_1", Sources: []voice.Source{voice.SourceMicrophone, voice.SourceScreenShare}},
		{Identity: "ingress-1", SID: "PA_x"},
	}
	if err := e.svc.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	st, ok := e.st.Get(alice)
	if !ok || !st.Screen || st.Video || st.ChannelID != voiceA || st.GuildID != guild1 {
		t.Fatalf("estado recuperado = %+v %v", st, ok)
	}
	// Câmera ligada no LiveKit sem o webhook ter chegado: o reconciliador corrige.
	e.clk.advance(time.Minute)
	e.prov.participants["301"][0].Sources = []voice.Source{voice.SourceCamera}
	if err := e.svc.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st, _ := e.st.Get(alice); !st.Video || st.Screen {
		t.Fatalf("flags não sincronizados: %+v", st)
	}
}
