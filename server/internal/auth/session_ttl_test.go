package auth

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSessionLifetimesByRemember(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	if got := expiryFor(true, now, now); !got.Equal(now.Add(90 * 24 * time.Hour)) {
		t.Fatalf("lembrada: 90 dias ociosos, veio %v", got.Sub(now))
	}
	if got := expiryFor(false, now, now); !got.Equal(now.Add(24 * time.Hour)) {
		t.Fatalf("curta: 24 h ociosas, veio %v", got.Sub(now))
	}
	// o teto absoluto limita a renovação
	late := now.Add(300 * 24 * time.Hour)
	if got := expiryFor(true, now, late); !got.Equal(now.Add(RememberMaxTTL)) {
		t.Fatalf("lembrada: teto de 365 dias da criação, veio %v", got.Sub(now))
	}
	late = now.Add(6*24*time.Hour + 20*time.Hour)
	if got := expiryFor(false, now, late); !got.Equal(now.Add(ShortMaxTTL)) {
		t.Fatalf("curta: teto de 7 dias da criação, veio %v", got.Sub(now))
	}
	if CookieMaxAge(true) != int(RememberIdleTTL.Seconds()) || CookieMaxAge(false) != 0 {
		t.Fatal("cookie: persistente só quando lembrada; senão cookie de sessão (sem Max-Age)")
	}
}

func TestSlidingRenewalIsThrottledAndCapped(t *testing.T) {
	ctx := context.Background()
	svc, st := newSvc(t)
	t0 := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return t0 }
	_, tok, err := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	sess := st.sessions[string(hashToken(tok))]

	// dentro de 1 h: nada é gravado
	svc.now = func() time.Time { return t0.Add(59 * time.Minute) }
	a, err := svc.Resolve(ctx, tok)
	if err != nil || a.RefreshCookieMaxAge != 0 || sess.slides != 0 {
		t.Fatalf("antes de 1 h não renova: %+v %v slides=%d", a, err, sess.slides)
	}
	// depois de 1 h: renova e manda reenviar o cookie com o Max-Age novo
	svc.now = func() time.Time { return t0.Add(61 * time.Minute) }
	a, err = svc.Resolve(ctx, tok)
	if err != nil || sess.slides != 1 {
		t.Fatalf("depois de 1 h renova uma vez: %v slides=%d", err, sess.slides)
	}
	if want := int((RememberIdleTTL).Seconds()); a.RefreshCookieMaxAge != want {
		t.Fatalf("Max-Age do cookie renovado = %d, quer %d", a.RefreshCookieMaxAge, want)
	}
	if !sess.expires.Equal(t0.Add(61*time.Minute + RememberIdleTTL)) {
		t.Fatalf("vencimento deslizou: %v", sess.expires)
	}
	// logo em seguida: de novo sem gravar
	svc.now = func() time.Time { return t0.Add(62 * time.Minute) }
	_, _ = svc.Resolve(ctx, tok)
	if sess.slides != 1 {
		t.Fatalf("renovação limitada a 1 por hora, slides=%d", sess.slides)
	}
	// perto do teto absoluto: o vencimento não passa dos 365 dias da criação
	for d := 80; d <= 320; d += 80 { // uso a cada 80 dias mantém a sessão viva até o teto
		d := d
		svc.now = func() time.Time { return t0.Add(time.Duration(d) * 24 * time.Hour) }
		if _, err := svc.Resolve(ctx, tok); err != nil {
			t.Fatalf("dia %d: %v", d, err)
		}
	}
	if !sess.expires.Equal(t0.Add(RememberMaxTTL)) {
		t.Fatalf("teto absoluto: %v", sess.expires.Sub(t0))
	}
	svc.now = func() time.Time { return t0.Add(RememberMaxTTL + time.Minute) }
	if _, err := svc.Resolve(ctx, tok); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("passou do teto: %v", err)
	}
}

func TestShortSessionExpiresIn24hAndSendsNoCookieRefresh(t *testing.T) {
	ctx := context.Background()
	svc, st := newSvc(t)
	t0 := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return t0 }
	_, tok, _ := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil, false)
	sess := st.sessions[string(hashToken(tok))]
	if sess.remember || !sess.expires.Equal(t0.Add(ShortIdleTTL)) {
		t.Fatalf("sessão curta: remember=%v expira=%v", sess.remember, sess.expires)
	}
	// usada às 23 h: desliza para +24 h; cookie de sessão não é reenviado
	svc.now = func() time.Time { return t0.Add(23 * time.Hour) }
	a, err := svc.Resolve(ctx, tok)
	if err != nil || a.RefreshCookieMaxAge != 0 || sess.slides != 1 {
		t.Fatalf("curta renova no servidor sem reenviar cookie: %+v %v", a, err)
	}
	// sem uso por mais de 24 h: expira
	svc.now = func() time.Time { return t0.Add(23*time.Hour + ShortIdleTTL + time.Minute) }
	if _, err := svc.Resolve(ctx, tok); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("ociosa por mais de 24 h deveria expirar: %v", err)
	}
}

func TestNewSessionIsAlwaysRemembered(t *testing.T) {
	ctx := context.Background()
	svc, st := newSvc(t)
	u, _, _ := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil, false)
	tok, err := svc.NewSession(ctx, u.ID, nil)
	if err != nil || !st.sessions[string(hashToken(tok))].remember {
		t.Fatalf("login social/desktop usam sessão longa: %v", err)
	}
}

func TestRevokeSessionAndOthers(t *testing.T) {
	ctx := context.Background()
	svc, _ := newSvc(t)
	u, cur, _ := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil, true)
	_, t2, _ := svc.Login(ctx, "a@b.com", "senha-forte-1", nil, true)
	_, t3, _ := svc.Login(ctx, "a@b.com", "senha-forte-1", nil, false)
	var gotKey string
	svc.OnRevokeKey(func(uid int64, key string) { gotKey = key })

	rows, flags, err := svc.ListSessions(ctx, u.ID, cur)
	if err != nil || len(rows) != 3 {
		t.Fatalf("lista: %v %d", err, len(rows))
	}
	n := 0
	for _, f := range flags {
		if f {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("exatamente uma sessão atual, veio %d", n)
	}
	var id2 int64
	for _, r := range rows {
		if string(r.TokenHash) == string(hashToken(t2)) {
			id2 = r.ID
		}
	}
	if err := svc.RevokeSession(ctx, u.ID, id2); err != nil {
		t.Fatal(err)
	}
	if gotKey != TokenKey(t2) {
		t.Fatalf("gateway deveria receber a chave da sessão encerrada: %q", gotKey)
	}
	if _, err := svc.Authenticate(ctx, t2); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("sessão encerrada não autentica")
	}
	if err := svc.RevokeSession(ctx, u.ID+1, id2); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("sessão de outro usuário / inexistente: %v", err)
	}
	k, err := svc.RevokeOthers(ctx, u.ID, cur)
	if err != nil || k != 1 {
		t.Fatalf("encerrar as outras: %d %v", k, err)
	}
	if _, err := svc.Authenticate(ctx, t3); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("a outra sessão deveria cair")
	}
	if _, err := svc.Authenticate(ctx, cur); err != nil {
		t.Fatal("a atual continua")
	}
}

func TestSummarizeUserAgent(t *testing.T) {
	cases := []struct{ ua, b, o string }{
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Chrome", "macOS"},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0", "Edge", "Windows"},
		{"Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0", "Firefox", "Linux"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "Safari", "iOS"},
		{"", "", ""},
	}
	for _, c := range cases {
		if b, o := SummarizeUserAgent(c.ua); b != c.b || o != c.o {
			t.Errorf("%q: %q/%q, quer %q/%q", c.ua, b, o, c.b, c.o)
		}
	}
}
