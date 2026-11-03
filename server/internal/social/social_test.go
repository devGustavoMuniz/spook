package social

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/secret"
)

func box(t *testing.T) *secret.Box {
	t.Helper()
	b, _, err := secret.New("teste")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestFlowSealOpen(t *testing.T) {
	b := box(t)
	now := time.Unix(1_700_000_000, 0)
	f, err := newFlow(Google, IntentLogin, "/invite/x", 0, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Verifier) < 43 || len(f.Verifier) > 128 {
		t.Fatalf("verificador PKCE fora de 43..128: %d", len(f.Verifier))
	}
	if f.challenge() == f.Verifier || len(f.challenge()) != 43 {
		t.Fatal("o desafio S256 tem 43 caracteres e não é o verificador")
	}
	c := f.seal(b)
	got, err := openFlow(b, c, Google, f.State, now.Add(time.Minute))
	if err != nil || got.Verifier != f.Verifier || got.Redirect != "/invite/x" {
		t.Fatalf("openFlow: %v %+v", err, got)
	}
	cases := map[string]func() error{
		"estado errado":      func() error { _, e := openFlow(b, c, Google, f.State+"x", now); return e },
		"estado vazio":       func() error { _, e := openFlow(b, c, Google, "", now); return e },
		"outro provedor":     func() error { _, e := openFlow(b, c, Discord, f.State, now); return e },
		"expirado":           func() error { _, e := openFlow(b, c, Google, f.State, now.Add(flowTTL+time.Second)); return e },
		"cookie adulterado":  func() error { _, e := openFlow(b, "x"+c, Google, f.State, now); return e },
		"outra chave":        func() error { o, _, _ := secret.New("outra"); _, e := openFlow(o, c, Google, f.State, now); return e },
		"cookie sem assinar": func() error { _, e := openFlow(b, "abc", Google, f.State, now); return e },
	}
	for name, run := range cases {
		if run() == nil {
			t.Errorf("%s deveria falhar", name)
		}
	}
	f2, _ := newFlow(Google, IntentLogin, "/", 0, now)
	if f2.State == f.State || f2.Verifier == f.Verifier {
		t.Fatal("estado e verificador precisam ser aleatórios")
	}
}

func TestSafeRedirect(t *testing.T) {
	ok := []string{"/", "/invite/abc", "/settings/profile?x=1", "/channels/1/2"}
	bad := []string{"", "//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "evil.com", "/ok\r\nSet-Cookie: x=1", "http://x", "/%0d%0a" + strings.Repeat("a", 600)}
	for _, s := range ok {
		if SafeRedirect(s) != s {
			t.Errorf("%q deveria passar", s)
		}
	}
	for _, s := range bad {
		if SafeRedirect(s) != "/" {
			t.Errorf("%q deveria virar /", s)
		}
	}
}

func TestSuggestUsername(t *testing.T) {
	cases := map[[2]string]string{
		{"Maria Silva", "m@x.com"}:    "maria_silva",
		{"", "joao.pedro@x.com"}:      "joao.pedro",
		{"José", ""}:                  "jos",
		{"", ""}:                      "usuario",
		{"!!!", "a@b.c"}:              "usuario",
		{strings.Repeat("a", 60), ""}: strings.Repeat("a", 28),
	}
	for in, want := range cases {
		if got := suggestUsername(in[0], in[1]); got != want {
			t.Errorf("suggestUsername(%q,%q) = %q, esperado %q", in[0], in[1], got, want)
		}
		if !usernameRe.MatchString(suggestUsername(in[0], in[1])) {
			t.Errorf("sugestão inválida para %v", in)
		}
	}
}

// Os provedores reais, contra servidores locais (nada vai para a rede).
func TestGoogleProviderExchange(t *testing.T) {
	var gotForm url.Values
	var gotAuth string
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotForm = r.PostForm
		_, _ = w.Write([]byte(`{"access_token":"tok-secreto","token_type":"Bearer"}`))
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"sub":"123","email":"a@b.com","email_verified":true,"name":"Ana"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	p := NewGoogle("cid", "csecret", nil, &GoogleEndpoints{Auth: srv.URL + "/auth", Token: srv.URL + "/token", UserInfo: srv.URL + "/userinfo"})

	u, _ := url.Parse(p.AuthURL(AuthParams{State: "st", Challenge: "ch", RedirectURI: "http://app/cb", Reauth: true}))
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") != "ch" || q.Get("state") != "st" || q.Get("client_id") != "cid" ||
		q.Get("response_type") != "code" || q.Get("prompt") != "select_account" || !strings.Contains(q.Get("scope"), "email") {
		t.Fatalf("URL de autorização: %s", u)
	}
	prof, err := p.Exchange(context.Background(), "the-code", "the-verifier", "http://app/cb")
	if err != nil {
		t.Fatal(err)
	}
	if prof.ID != "123" || prof.Email != "a@b.com" || !prof.EmailVerified || prof.Name != "Ana" {
		t.Fatalf("perfil: %+v", prof)
	}
	if gotForm.Get("code") != "the-code" || gotForm.Get("code_verifier") != "the-verifier" || gotForm.Get("grant_type") != "authorization_code" || gotForm.Get("client_secret") != "csecret" {
		t.Fatalf("form do token: %v", gotForm)
	}
	if gotAuth != "Bearer tok-secreto" {
		t.Fatalf("userinfo sem bearer: %q", gotAuth)
	}
}

func TestDiscordProviderExchangeAndErrors(t *testing.T) {
	fail := false
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		if fail {
			http.Error(w, `{"error":"invalid_grant","secret":"nao-vazar"}`, http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"t"}`))
	})
	mux.HandleFunc("/me", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"99","username":"zed","global_name":"","email":"z@d.com","verified":false}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	p := NewDiscord("cid", "sec", nil, &DiscordEndpoints{Auth: srv.URL + "/a", Token: srv.URL + "/token", Me: srv.URL + "/me"})
	prof, err := p.Exchange(context.Background(), "c", strings.Repeat("v", 43), "http://app/cb")
	if err != nil || prof.ID != "99" || prof.Name != "zed" || prof.EmailVerified {
		t.Fatalf("perfil: %+v %v", prof, err)
	}
	fail = true
	_, err = p.Exchange(context.Background(), "c", "v", "http://app/cb")
	if err == nil || strings.Contains(err.Error(), "nao-vazar") || strings.Contains(err.Error(), srv.URL) {
		t.Fatalf("erro do provedor não pode vazar corpo nem URL: %v", err)
	}
	u, _ := url.Parse(p.AuthURL(AuthParams{State: "s", Challenge: "c", RedirectURI: "http://app/cb"}))
	if u.Query().Get("scope") != "identify email" || u.Query().Get("code_challenge_method") != "S256" {
		t.Fatalf("authorize: %s", u)
	}
}
