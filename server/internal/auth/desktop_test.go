package auth

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPKCEChallengeMatchesRFC7636Vector(t *testing.T) {
	// Exemplo do Apêndice B da RFC 7636.
	if got := PKCEChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"); got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatalf("challenge = %s", got)
	}
	if !ValidPKCEChallenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM") || ValidPKCEChallenge("curto") || ValidPKCEChallenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM") {
		t.Fatal("validação do desafio")
	}
}

func TestDesktopCodeSingleUseTTLAndVerifier(t *testing.T) {
	ctx := context.Background()
	svc, st := newSvc(t)
	u, _, err := svc.Register(ctx, "d@b.com", "desk", "senha-forte-1", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	ch := PKCEChallenge(verifier)

	if _, _, err := svc.DesktopAuthorize(ctx, u.ID, "invalido"); !errors.Is(err, ErrInvalidChallenge) {
		t.Fatalf("desafio inválido: %v", err)
	}
	code, exp, err := svc.DesktopAuthorize(ctx, u.ID, ch)
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Until(exp); d < 55*time.Second || d > 61*time.Second {
		t.Fatalf("TTL = %v", d)
	}
	for k := range st.codes {
		if k == code {
			t.Fatal("o código em claro não pode ser guardado")
		}
	}
	// verificador errado: queima o código
	if _, _, err := svc.DesktopExchange(ctx, code, "x"+verifier, nil); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("verificador errado: %v", err)
	}
	if _, _, err := svc.DesktopExchange(ctx, code, verifier, nil); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("código queimado: %v", err)
	}
	// feliz + uso único
	code, _, _ = svc.DesktopAuthorize(ctx, u.ID, ch)
	got, tok, err := svc.DesktopExchange(ctx, code, verifier, nil)
	if err != nil || got.ID != u.ID || tok == "" {
		t.Fatalf("exchange: %v", err)
	}
	if uid, err := svc.Authenticate(ctx, tok); err != nil || uid != u.ID {
		t.Fatalf("token do desktop: %v", err)
	}
	if _, _, err := svc.DesktopExchange(ctx, code, verifier, nil); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("reuso: %v", err)
	}
	// expirado
	code, _, _ = svc.DesktopAuthorize(ctx, u.ID, ch)
	for _, c := range st.codes {
		c.expires = time.Now().Add(-time.Second)
	}
	if _, _, err := svc.DesktopExchange(ctx, code, verifier, nil); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("expirado: %v", err)
	}
	// verificador fora do formato nem chega ao banco
	if _, _, err := svc.DesktopExchange(ctx, code, "curto", nil); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("formato: %v", err)
	}
}

func TestNoPasswordAccountCannotLoginOrConfirm(t *testing.T) {
	ctx := context.Background()
	svc, _ := newSvc(t)
	u, _, _ := svc.Register(ctx, "n@b.com", "nopw", "senha-forte-1", nil, true)
	fu := svc.users.(*fakeUsers)
	fu.hashes["n@b.com"] = "!"
	if _, _, err := svc.Login(ctx, "n@b.com", "!", nil, true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("login sem senha: %v", err)
	}
	if err := svc.VerifyPassword(ctx, u.ID, "!"); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("verificar: %v", err)
	}
	if has, _ := svc.HasPassword(ctx, u.ID); has {
		t.Fatal("HasPassword deveria ser falso")
	}
	_, tok, _ := svc.Login(ctx, "n@b.com", "x", nil, true)
	_ = tok
	// SetInitialPassword: fraca, ok, e só uma vez
	sess, err := svc.NewSession(ctx, u.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetInitialPassword(ctx, u.ID, sess, "curta"); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("fraca: %v", err)
	}
	if err := svc.SetInitialPassword(ctx, u.ID, sess, "primeira-senha-1"); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetInitialPassword(ctx, u.ID, sess, "primeira-senha-2"); !errors.Is(err, ErrHasPassword) {
		t.Fatalf("segunda vez: %v", err)
	}
	if _, _, err := svc.Login(ctx, "n@b.com", "primeira-senha-1", nil, true); err != nil {
		t.Fatal(err)
	}
}

func TestResetPasswordEndsAllSessions(t *testing.T) {
	ctx := context.Background()
	svc, _ := newSvc(t)
	var revoked int64
	svc.OnRevoke(func(uid int64, keep string) {
		if keep == "" {
			revoked = uid
		}
	})
	u, t1, _ := svc.Register(ctx, "r@b.com", "reset", "senha-forte-1", nil, true)
	_, t2, _ := svc.Login(ctx, "r@b.com", "senha-forte-1", nil, true)
	if err := svc.ResetPassword(ctx, u.ID, "curta"); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("fraca: %v", err)
	}
	if err := svc.ResetPassword(ctx, u.ID, "nova-senha-123"); err != nil {
		t.Fatal(err)
	}
	for _, tok := range []string{t1, t2} {
		if _, err := svc.Authenticate(ctx, tok); !errors.Is(err, ErrUnauthorized) {
			t.Fatal("todas as sessões deveriam cair")
		}
	}
	if revoked != u.ID {
		t.Fatal("o gateway deveria ser avisado")
	}
	if _, _, err := svc.Login(ctx, "r@b.com", "nova-senha-123", nil, true); err != nil {
		t.Fatal(err)
	}
}
