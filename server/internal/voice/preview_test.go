package voice_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
	"github.com/devGustavoMuniz/spook/server/internal/voice/memory"
)

// jpegOf monta um JPEG mínimo (só os marcadores) com as dimensões dadas: basta para a validação, que
// não decodifica a imagem.
func jpegOf(w, h, pad int) []byte {
	b := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46} // SOI + APP0 curto
	b = append(b, 0xFF, 0xC0, 0x00, 0x11, 0x08, byte(h>>8), byte(h), byte(w>>8), byte(w),
		0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01)
	b = append(b, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00)
	b = append(b, bytes.Repeat([]byte{0x11}, pad)...)
	return append(b, 0xFF, 0xD9)
}

func sharing(t *testing.T, e *env, user int64) {
	t.Helper()
	e.token(t, user, voiceA)
	e.join(t, user, voiceA, "PA_"+itoa(user), voice.SourceScreenShare)
}

func TestScreenPreviewLifecycle(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sharing(t, e, alice)
	img := jpegOf(320, 180, 500)

	if err := e.svc.PutScreenPreview(ctx, alice, voiceA, img); err != nil {
		t.Fatal(err)
	}
	if p := e.pub.last(); !p.ScreenPreview || !p.SelfScreen || p.UserID != itoa(alice) {
		t.Fatalf("evento após enviar = %+v", p)
	}
	// Bob vê o canal, mas não está na chamada: lê a prévia.
	got, err := e.svc.ScreenPreview(ctx, bob, voiceA, alice)
	if err != nil || !bytes.Equal(got, img) {
		t.Fatalf("leitura = %d bytes, %v", len(got), err)
	}
	// Renovar publica de novo? Não: o indicador já estava ligado.
	n := len(e.pub.all())
	e.clk.advance(voice.PreviewMinInterval + time.Second)
	if err := e.svc.PutScreenPreview(ctx, alice, voiceA, img); err != nil {
		t.Fatal(err)
	}
	if len(e.pub.all()) != n {
		t.Fatal("renovar a prévia não deve publicar evento")
	}

	// TTL: depois de 45 s sem renovar, a leitura dá 404 e a varredura desliga o indicador.
	e.clk.advance(voice.PreviewTTL + time.Second)
	if _, err := e.svc.ScreenPreview(ctx, bob, voiceA, alice); kind(err) != apperr.KindNotFound {
		t.Fatalf("prévia vencida: %v", err)
	}
	e.svc.SweepPreviews(ctx)
	if e.pub.last().ScreenPreview || !e.pub.last().SelfScreen {
		t.Fatalf("após a varredura = %+v", e.pub.last())
	}
	if c, b := e.pv.Stats(); c != 0 || b != 0 {
		t.Fatalf("armazém = %d/%d", c, b)
	}
}

func TestScreenPreviewDeleteIsIdempotentAndClearsFlag(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sharing(t, e, alice)
	if err := e.svc.PutScreenPreview(ctx, alice, voiceA, jpegOf(320, 180, 10)); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.DeleteScreenPreview(ctx, alice); err != nil {
		t.Fatal(err)
	}
	if e.pub.last().ScreenPreview {
		t.Fatalf("indicador deveria ter sido desligado: %+v", e.pub.last())
	}
	if _, err := e.svc.ScreenPreview(ctx, bob, voiceA, alice); kind(err) != apperr.KindNotFound {
		t.Fatalf("depois do DELETE: %v", err)
	}
	n := len(e.pub.all())
	if err := e.svc.DeleteScreenPreview(ctx, alice); err != nil || len(e.pub.all()) != n {
		t.Fatalf("DELETE repetido: %v (eventos %d→%d)", err, n, len(e.pub.all()))
	}
	if err := e.svc.DeleteScreenPreview(ctx, bob); err != nil { // quem nunca enviou também recebe sucesso
		t.Fatal(err)
	}
}

func TestScreenPreviewAuthorization(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	img := jpegOf(320, 180, 10)

	// Fora da chamada: 403.
	if err := e.svc.PutScreenPreview(ctx, alice, voiceA, img); kind(err) != apperr.KindForbidden {
		t.Fatalf("fora da chamada: %v", err)
	}
	// Em outra sala: 403.
	e.token(t, alice, voiceB)
	e.join(t, alice, voiceB, "PA_1")
	if err := e.svc.PutScreenPreview(ctx, alice, voiceA, img); kind(err) != apperr.KindForbidden {
		t.Fatalf("em outra sala: %v", err)
	}
	// Sem permissão de vídeo: 403.
	noVideo := full()
	noVideo.CanVideo = false
	e.acc.set(bob, voiceA, noVideo)
	e.token(t, bob, voiceA)
	e.join(t, bob, voiceA, "PA_2")
	if err := e.svc.PutScreenPreview(ctx, bob, voiceA, img); kind(err) != apperr.KindForbidden {
		t.Fatalf("sem vídeo: %v", err)
	}
	// Quem não vê o canal: 404 ao enviar e ao ler.
	const carol int64 = 13
	if err := e.svc.PutScreenPreview(ctx, carol, voiceA, img); kind(err) != apperr.KindNotFound {
		t.Fatalf("sem acesso (PUT): %v", err)
	}
	if _, err := e.svc.ScreenPreview(ctx, carol, voiceA, alice); kind(err) != apperr.KindNotFound {
		t.Fatalf("sem acesso (GET): %v", err)
	}
	// Sem VIEW_CHANNEL (403 da permissão) também vira 404 na leitura: não revela que há transmissão.
	e.acc.fail(carol, voiceA, apperr.Forbidden("sem permissão"))
	if _, err := e.svc.ScreenPreview(ctx, carol, voiceA, alice); kind(err) != apperr.KindNotFound {
		t.Fatalf("sem VIEW_CHANNEL (GET): %v", err)
	}
	// Erro de infraestrutura não vira 404.
	e.acc.fail(carol, voiceA, errors.New("banco fora"))
	if _, err := e.svc.ScreenPreview(ctx, carol, voiceA, alice); err == nil || kind(err) == apperr.KindNotFound {
		t.Fatalf("erro de infra deveria propagar: %v", err)
	}
}

func TestScreenPreviewReadIsScopedToTheChannel(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sharing(t, e, alice)
	if err := e.svc.PutScreenPreview(ctx, alice, voiceA, jpegOf(320, 180, 10)); err != nil {
		t.Fatal(err)
	}
	// A prévia da Alice é do canal A: pedir pelo canal B (que Bob também vê) não a revela.
	if _, err := e.svc.ScreenPreview(ctx, bob, voiceB, alice); kind(err) != apperr.KindNotFound {
		t.Fatalf("canal errado: %v", err)
	}
}

func TestScreenPreviewValidation(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sharing(t, e, alice)
	big := jpegOf(320, 180, voice.PreviewMaxBytes)
	cases := map[string][]byte{
		"vazio":              nil,
		"png":                {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0},
		"texto":              []byte("não sou uma imagem"),
		"sem fim (FFD9)":     jpegOf(320, 180, 10)[:30],
		"largura demais":     jpegOf(641, 180, 10),
		"altura demais":      jpegOf(320, 361, 10),
		"dimensão zero":      jpegOf(0, 180, 10),
		"grande demais":      big,
		"sem SOF (só dados)": {0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xFF, 0xD9},
	}
	for name, body := range cases {
		if err := e.svc.PutScreenPreview(ctx, alice, voiceA, body); kind(err) != apperr.KindInvalid {
			t.Errorf("%s: erro = %v, quer 422", name, err)
		}
	}
	if err := e.svc.PutScreenPreview(ctx, alice, voiceA, jpegOf(640, 360, 10)); err != nil {
		t.Fatalf("640×360 é o limite e deve passar: %v", err)
	}
	if c, _ := e.pv.Stats(); c != 1 {
		t.Fatalf("só o envio válido deveria ficar guardado, há %d", c)
	}
}

func TestScreenPreviewRateLimit(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sharing(t, e, alice)
	img := jpegOf(320, 180, 10)
	if err := e.svc.PutScreenPreview(ctx, alice, voiceA, img); err != nil {
		t.Fatal(err)
	}
	e.clk.advance(2 * time.Second)
	err := e.svc.PutScreenPreview(ctx, alice, voiceA, img)
	ae, ok := apperr.As(err)
	if !ok || ae.Kind != apperr.KindRateLimited || ae.RetryAfter != 3*time.Second {
		t.Fatalf("segundo envio em 2 s: %v", err)
	}
	e.clk.advance(3 * time.Second)
	if err := e.svc.PutScreenPreview(ctx, alice, voiceA, img); err != nil {
		t.Fatalf("depois de 5 s: %v", err)
	}
}

func TestScreenPreviewGoesAwayWithTheScreenOrTheCall(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	put := func(u int64) {
		t.Helper()
		if err := e.svc.PutScreenPreview(ctx, u, voiceA, jpegOf(320, 180, 10)); err != nil {
			t.Fatal(err)
		}
	}
	sharing(t, e, alice)
	put(alice)
	if err := e.webhook(t, voice.RoomEvent{Type: voice.EventTrackUnpublished, Room: "301", Identity: "11", Source: voice.SourceScreenShare}); err != nil {
		t.Fatal(err)
	}
	if p := e.pub.last(); p.SelfScreen || p.ScreenPreview {
		t.Fatalf("parou de transmitir: %+v", p)
	}
	if _, err := e.svc.ScreenPreview(ctx, bob, voiceA, alice); kind(err) != apperr.KindNotFound {
		t.Fatalf("prévia deveria ter sumido: %v", err)
	}

	sharing(t, e, bob)
	put(bob)
	if err := e.svc.Leave(ctx, bob); err != nil {
		t.Fatal(err)
	}
	if c, _ := e.pv.Stats(); c != 0 {
		t.Fatalf("sair da chamada deveria apagar a prévia, há %d", c)
	}
}

func TestScreenPreviewCapacity(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	small := memory.NewPreviewsWithLimits(1, voice.PreviewMaxTotalBytes)
	svc := voice.NewService(voice.Deps{Provider: e.prov, Store: e.st, Previews: small, Access: e.acc, Users: fakeUsers{}, Pub: e.pub, Now: e.clk.now})
	for _, u := range []int64{alice, bob} {
		e.token(t, u, voiceA)
		e.join(t, u, voiceA, "PA_"+itoa(u))
	}
	img := jpegOf(320, 180, 10)
	if err := svc.PutScreenPreview(ctx, alice, voiceA, img); err != nil {
		t.Fatal(err)
	}
	if err := svc.PutScreenPreview(ctx, bob, voiceA, img); kind(err) != apperr.KindUnavailable {
		t.Fatalf("teto de quantidade: %v", err)
	}
	// A prévia da Alice vence: o teto se abre (a varredura no envio libera o espaço) e o indicador dela desliga.
	e.clk.advance(voice.PreviewTTL + time.Second)
	if err := svc.PutScreenPreview(ctx, bob, voiceA, img); err != nil {
		t.Fatalf("com a vencida varrida: %v", err)
	}
	if st, _ := e.st.Get(alice); st.Preview {
		t.Fatal("o indicador da Alice deveria ter sido desligado ao varrer")
	}
}

func TestScreenPreviewDisabledWithoutStore(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	svc := voice.NewService(voice.Deps{Provider: e.prov, Store: e.st, Access: e.acc, Users: fakeUsers{}, Pub: e.pub, Now: e.clk.now})
	sharing(t, e, alice)
	if err := svc.PutScreenPreview(ctx, alice, voiceA, jpegOf(320, 180, 10)); kind(err) != apperr.KindUnavailable {
		t.Fatalf("PUT: %v", err)
	}
	if _, err := svc.ScreenPreview(ctx, bob, voiceA, alice); kind(err) != apperr.KindNotFound {
		t.Fatalf("GET: %v", err)
	}
	if err := svc.DeleteScreenPreview(ctx, alice); err != nil {
		t.Fatal(err)
	}
}
