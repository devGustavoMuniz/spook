package voice_test

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

const carol int64 = 13

// joinCall põe os usuários na sala voiceA com o token e o webhook; alice entra transmitindo a tela.
func joinCall(t *testing.T, e *env, users ...int64) {
	t.Helper()
	for _, u := range users {
		e.acc.set(u, voiceA, full())
		e.token(t, u, voiceA)
		var tracks []voice.Source
		if u == alice {
			tracks = append(tracks, voice.SourceScreenShare)
		}
		e.join(t, u, voiceA, "PA_"+itoa(u), tracks...)
	}
}

func TestScreenWatchAuthorization(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	joinCall(t, e, alice, bob)
	outsider := int64(99) // vê o canal, mas não está na chamada
	e.acc.set(outsider, voiceA, full())
	stranger := int64(98) // não vê o canal
	for _, tc := range []struct {
		name        string
		viewer, tgt int64
		channel     int64
		wantKind    apperr.Kind
	}{
		{"fora da chamada", outsider, alice, voiceA, apperr.KindForbidden},
		{"sem acesso ao canal", stranger, alice, voiceA, apperr.KindNotFound},
		{"a si mesmo", alice, alice, voiceA, apperr.KindInvalid},
		{"transmissão inexistente", alice, bob, voiceA, apperr.KindNotFound}, // bob não transmite
	} {
		err := e.svc.SetScreenWatch(ctx, tc.viewer, tc.channel, tc.tgt, true)
		if kind(err) != tc.wantKind {
			t.Errorf("%s: erro = %v (kind %v), queria %v", tc.name, err, kind(err), tc.wantKind)
		}
	}
	// bob tenta assistir a alguém que não transmite (carol está na chamada sem tela).
	joinCall(t, e, carol)
	if err := e.svc.SetScreenWatch(ctx, bob, voiceA, carol, true); kind(err) != apperr.KindNotFound {
		t.Fatalf("assistir a quem não transmite deveria dar 404, deu %v", err)
	}
	if err := e.svc.SetScreenWatch(ctx, bob, voiceB, alice, true); kind(err) != apperr.KindForbidden {
		t.Fatalf("estar em outro canal deveria dar 403, deu %v", err)
	}
	if got, _ := e.st.Get(alice); got.Screen != true {
		t.Fatal("estado da alice deveria transmitir")
	}
	if p := e.svc.Snapshot(alice, []int64{guild1}, nil); len(p) == 0 {
		t.Fatal("snapshot vazio")
	}
}

func viewerIDs(p voice.StatePayload) string {
	out := ""
	for _, v := range p.Viewers {
		out += v + ","
	}
	return out
}

func TestScreenWatchLifecycle(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	joinCall(t, e, alice, bob, carol)

	e.pub.reset()
	if err := e.svc.SetScreenWatch(ctx, bob, voiceA, alice, true); err != nil {
		t.Fatal(err)
	}
	p := e.pub.last()
	if p.UserID != "11" || p.ViewerCount != 1 || viewerIDs(p) != "12," {
		t.Fatalf("evento após o primeiro espectador = %+v", p)
	}
	// Renovar (heartbeat) não publica de novo.
	n := len(e.pub.all())
	e.clk.advance(20 * time.Second)
	if err := e.svc.SetScreenWatch(ctx, bob, voiceA, alice, true); err != nil || len(e.pub.all()) != n {
		t.Fatalf("heartbeat não deve publicar (err=%v, eventos %d→%d)", err, n, len(e.pub.all()))
	}
	e.clk.advance(10 * time.Second)
	if err := e.svc.SetScreenWatch(ctx, carol, voiceA, alice, true); err != nil {
		t.Fatal(err)
	}
	if p := e.pub.last(); p.ViewerCount != 2 || viewerIDs(p) != "12,13," {
		t.Fatalf("dois espectadores, o mais antigo primeiro = %+v", p)
	}

	// Snapshot: só o transmissor recebe a lista; os demais, a contagem.
	for _, tc := range []struct {
		viewer  int64
		wantIDs string
	}{{alice, "12,13,"}, {bob, ""}} {
		var mine voice.StatePayload
		for _, sp := range e.svc.Snapshot(tc.viewer, []int64{guild1}, nil) {
			if sp.UserID == "11" {
				mine = sp
			}
		}
		if mine.ViewerCount != 2 || viewerIDs(mine) != tc.wantIDs {
			t.Fatalf("snapshot para %d = %+v", tc.viewer, mine)
		}
	}
	states, err := e.svc.GuildStates(ctx, bob, guild1)
	if err != nil {
		t.Fatal(err)
	}
	for _, sp := range states {
		if sp.UserID == "11" && (sp.ViewerCount != 2 || len(sp.Viewers) != 0) {
			t.Fatalf("GET voice-states para o espectador = %+v", sp)
		}
	}

	// Sem renovar, bob vence (45 s depois do último toque) e carol continua.
	e.clk.advance(36 * time.Second) // bob: 66 s; carol: 36 s
	e.svc.SweepWatchers()
	if p := e.pub.last(); p.ViewerCount != 1 || viewerIDs(p) != "13," {
		t.Fatalf("depois do TTL = %+v", p)
	}

	// Quem sai da chamada deixa de assistir.
	e.pub.reset()
	if err := e.svc.Leave(ctx, carol); err != nil {
		t.Fatal(err)
	}
	var lastAlice voice.StatePayload
	for _, ev := range e.pub.all() {
		if sp := ev.Data.(voice.StatePayload); sp.UserID == "11" {
			lastAlice = sp
		}
	}
	if lastAlice.ViewerCount != 0 || lastAlice.UserID != "11" {
		t.Fatalf("a saída de carol deveria zerar os espectadores: %+v", lastAlice)
	}

	// Parar de assistir é idempotente; parar a transmissão limpa tudo.
	if err := e.svc.SetScreenWatch(ctx, bob, voiceA, alice, true); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetScreenWatch(ctx, bob, voiceA, alice, false); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetScreenWatch(ctx, bob, voiceA, alice, false); err != nil {
		t.Fatalf("remover de novo é idempotente: %v", err)
	}
	if err := e.svc.SetScreenWatch(ctx, bob, voiceA, alice, true); err != nil {
		t.Fatal(err)
	}
	if err := e.webhook(t, voice.RoomEvent{Type: voice.EventTrackUnpublished, Room: "301", Identity: "11", Source: voice.SourceScreenShare}); err != nil {
		t.Fatal(err)
	}
	if p := e.pub.last(); p.SelfScreen || p.ViewerCount != 0 || len(p.Viewers) != 0 {
		t.Fatalf("transmissão parada deve limpar os espectadores: %+v", p)
	}
}

func TestScreenWatchViewerListIsCappedAt50(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	joinCall(t, e, alice)
	for i := int64(0); i < 60; i++ {
		u := 1000 + i
		e.acc.set(u, voiceA, full())
		e.token(t, u, voiceA)
		e.join(t, u, voiceA, "PA_"+strconv.Itoa(int(u)))
		if err := e.svc.SetScreenWatch(ctx, u, voiceA, alice, true); err != nil {
			t.Fatal(err)
		}
		e.clk.advance(time.Millisecond) // ordem estável por "desde quando"
	}
	p := e.pub.last()
	if p.ViewerCount != 60 || len(p.Viewers) != voice.MaxViewersListed || p.Viewers[0] != "1000" {
		t.Fatalf("lista limitada a 50 e contagem total: count=%d len=%d first=%v", p.ViewerCount, len(p.Viewers), p.Viewers[:1])
	}
}

// ---- reconciliação ----

func TestReconcileClearsStalePreviewWatchersAndReportsFixes(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	joinCall(t, e, alice, bob)
	if err := e.svc.SetScreenWatch(ctx, bob, voiceA, alice, true); err != nil {
		t.Fatal(err)
	}
	// Prévia guardada e indicador ligado.
	if err := e.pv.Put(voice.Preview{UserID: alice, ChannelID: voiceA, Data: []byte{1}, ExpiresAt: e.clk.now().Add(time.Hour)}, e.clk.now()); err != nil {
		t.Fatal(err)
	}
	st, _ := e.st.Get(alice)
	st.Preview = true
	e.st.Put(st)

	// O LiveKit diz que a alice não transmite mais (webhook de unpublish perdido) e que o bob ainda está lá.
	e.clk.advance(time.Minute)
	e.prov.rooms = []voice.Room{{Name: "301", Participants: 2}}
	e.prov.participants["301"] = []voice.Participant{
		{Identity: "11", SID: "PA_11", Sources: []voice.Source{voice.SourceMicrophone}},
		{Identity: "12", SID: "PA_12", Sources: []voice.Source{voice.SourceMicrophone}},
	}
	e.pub.reset()
	rep, err := e.svc.ReconcileOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Rooms != 1 || rep.Orphans != 0 || rep.FlagsFixed < 2 {
		t.Fatalf("relatório = %+v", rep)
	}
	got, _ := e.st.Get(alice)
	if got.Screen || got.Preview {
		t.Fatalf("tela e prévia órfãs deveriam sumir: %+v", got)
	}
	if _, ok := e.pv.Get(alice, voiceA, e.clk.now()); ok {
		t.Fatal("a prévia guardada deveria ter sido apagada")
	}
	if p := e.pub.last(); p.UserID != "11" || p.SelfScreen || p.ViewerCount != 0 {
		t.Fatalf("evento corrigido = %+v", p)
	}

	// Idempotente: a segunda rodada não corrige mais nada nem publica.
	e.pub.reset()
	rep2, err := e.svc.ReconcileOnce(ctx)
	if err != nil || rep2.FlagsFixed != 0 || rep2.Orphans != 0 || len(e.pub.all()) != 0 {
		t.Fatalf("segunda rodada = %+v err=%v eventos=%d", rep2, err, len(e.pub.all()))
	}
}

func TestReconcileClearsPreviewFlagWithoutStoredPreview(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	joinCall(t, e, alice)
	st, _ := e.st.Get(alice)
	st.Preview = true // indicador ligado, nada guardado (a prévia venceu sem a varredura)
	e.st.Put(st)
	e.clk.advance(time.Minute)
	e.prov.rooms = []voice.Room{{Name: "301", Participants: 1}}
	e.prov.participants["301"] = []voice.Participant{{Identity: "11", SID: "PA_11", Sources: []voice.Source{voice.SourceScreenShare}}}
	rep, err := e.svc.ReconcileOnce(ctx)
	if err != nil || rep.FlagsFixed != 1 {
		t.Fatalf("relatório = %+v err=%v", rep, err)
	}
	if got, _ := e.st.Get(alice); got.Preview || !got.Screen {
		t.Fatalf("estado = %+v", got)
	}
}

func TestReconcileReappliesServerMuteWhenMicrophoneIsStillPublished(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	muted := full()
	muted.ServerMuted = true
	e.acc.set(bob, voiceA, muted)
	e.token(t, bob, voiceA)
	e.join(t, bob, voiceA, "PA_12")
	if st, _ := e.st.Get(bob); !st.ServerMuted {
		t.Fatal("bob deveria estar mutado pelo servidor")
	}
	e.clk.advance(time.Minute)
	e.prov.rooms = []voice.Room{{Name: "301", Participants: 1}}
	e.prov.participants["301"] = []voice.Participant{{Identity: "12", SID: "PA_12", Sources: []voice.Source{voice.SourceMicrophone}}}
	e.prov.updated = nil
	rep, err := e.svc.ReconcileOnce(ctx)
	if err != nil || rep.MuteApplied != 1 {
		t.Fatalf("relatório = %+v err=%v", rep, err)
	}
	if len(e.prov.updated) != 1 || e.prov.updated[0].Identity != "12" || e.prov.updated[0].Grants.Has(voice.SourceMicrophone) {
		t.Fatalf("o microfone deveria sair dos grants: %+v", e.prov.updated)
	}
	if len(e.prov.removed) != 0 {
		t.Fatal("reaplicar o mute nunca desconecta")
	}
}

func TestReconcileNeverDisconnectsWhenLiveKitIsDownOrPermissionLookupFails(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	joinCall(t, e, alice, bob)
	e.clk.advance(time.Minute)

	// LiveKit fora do ar: erro, nada removido.
	e.prov.listErr = errors.New("connection refused")
	rep, err := e.svc.ReconcileOnce(ctx)
	if err == nil || rep.Orphans != 0 {
		t.Fatalf("deveria falhar sem remover: %+v %v", rep, err)
	}
	e.prov.listErr = nil

	// O banco falha ao reavaliar as permissões: a pessoa continua conectada.
	e.prov.rooms = []voice.Room{{Name: "301", Participants: 2}}
	e.prov.participants["301"] = []voice.Participant{
		{Identity: "11", SID: "PA_11", Sources: []voice.Source{voice.SourceScreenShare}},
		{Identity: "12", SID: "PA_12"},
	}
	e.acc.fail(bob, voiceA, errors.New("banco fora do ar"))
	if _, err := e.svc.ReconcileOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.st.Get(bob); !ok {
		t.Fatal("falha transitória de permissão não pode derrubar o participante")
	}
	if len(e.prov.removed) != 0 {
		t.Fatalf("ninguém deveria ter sido removido: %v", e.prov.removed)
	}
}
