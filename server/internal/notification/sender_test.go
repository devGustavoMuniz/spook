package notification

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/SherClockHolmes/webpush-go"
)

// newVAPID gera um par VAPID válido.
func newVAPID(t *testing.T) PushConfig {
	t.Helper()
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	return PushConfig{PublicKey: pub, PrivateKey: priv, Subject: "mailto:teste@spook.example"}
}

// newBrowserKeys gera as chaves de uma inscrição, como o navegador (P-256 não comprimido + segredo de 16 bytes).
func newBrowserKeys(t *testing.T) (p256dh, auth string) {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	a := make([]byte, 16)
	_, _ = rand.Read(a)
	return base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()), base64.RawURLEncoding.EncodeToString(a)
}

func TestClassify(t *testing.T) {
	cases := map[int]httpOutcome{
		200: outcomeSent, 201: outcomeSent, 202: outcomeSent,
		404: outcomeGone, 410: outcomeGone,
		429: outcomeRetry, 500: outcomeRetry, 502: outcomeRetry, 503: outcomeRetry, 408: outcomeRetry,
		400: outcomeReject, 401: outcomeReject, 403: outcomeReject, 413: outcomeReject, 302: outcomeReject,
	}
	for status, want := range cases {
		if got := classify(status); got != want {
			t.Errorf("classify(%d) = %v, esperado %v", status, got, want)
		}
	}
}

func TestValidateSubscriptionKeys(t *testing.T) {
	p, a := newBrowserKeys(t)
	if err := validateSubscriptionKeys(p, a); err != nil {
		t.Fatal(err)
	}
	// com padding e no alfabeto padrão também vale
	std := base64.StdEncoding.EncodeToString(mustDecode(t, p))
	if err := validateSubscriptionKeys(std, a+"=="); err != nil {
		t.Fatal(err)
	}
	for _, c := range [][2]string{{"", a}, {p, ""}, {"abc", a}, {p, "abc"}, {a, a}, {p, p}, {"!!!", a}} {
		if err := validateSubscriptionKeys(c[0], c[1]); err == nil {
			t.Errorf("(%q, %q) deveria ser recusado", c[0], c[1])
		}
	}
}

func mustDecode(t *testing.T, s string) []byte {
	t.Helper()
	b, err := decodeKey(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestNewWebPushSenderValidatesVAPID(t *testing.T) {
	good := newVAPID(t)
	if _, err := NewWebPushSender(good, EndpointPolicy{}, nil); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []PushConfig{
		{PublicKey: "xxx", PrivateKey: good.PrivateKey, Subject: good.Subject},
		{PublicKey: good.PublicKey, PrivateKey: "xxx", Subject: good.Subject},
		{PublicKey: good.PrivateKey, PrivateKey: good.PublicKey, Subject: good.Subject}, // trocadas
	} {
		if _, err := NewWebPushSender(bad, EndpointPolicy{}, nil); err == nil {
			t.Errorf("chaves inválidas aceitas: %+v", bad)
		}
	}
	if (PushConfig{PublicKey: "a", PrivateKey: "b"}).Enabled() {
		t.Fatal("sem subject o push não liga")
	}
}

// O Send cifra (aes128gcm), assina com VAPID e usa TTL de 1 h.
func TestWebPushSenderRequest(t *testing.T) {
	var mu sync.Mutex
	var got *http.Request
	var body []byte
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		got, body = r, b
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	cfg := newVAPID(t)
	sender, err := NewWebPushSender(cfg, EndpointPolicy{AllowPrivate: true}, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	p, a := newBrowserKeys(t)
	status, err := sender.Send(context.Background(), Subscription{Endpoint: srv.URL + "/push/abc", P256dh: p, Auth: a}, []byte(`{"title":"oi"}`))
	if err != nil || status != http.StatusCreated {
		t.Fatalf("status %d err %v", status, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if got.Method != http.MethodPost || got.URL.Path != "/push/abc" {
		t.Fatalf("%s %s", got.Method, got.URL.Path)
	}
	if got.Header.Get("Content-Encoding") != "aes128gcm" || got.Header.Get("TTL") != "3600" {
		t.Fatalf("cabeçalhos: %v", got.Header)
	}
	if auth := got.Header.Get("Authorization"); !strings.HasPrefix(strings.ToLower(auth), "vapid ") || !strings.Contains(auth, cfg.PublicKey) {
		t.Fatalf("Authorization sem VAPID: %q", auth)
	}
	if len(body) < 100 || strings.Contains(string(body), "oi") {
		t.Fatalf("corpo deveria ser cifrado e não vazio (%d bytes)", len(body))
	}
}

func TestWebPushSenderReportsBlockedAddress(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("não deveria conectar") }))
	defer srv.Close()
	sender, err := NewWebPushSender(newVAPID(t), EndpointPolicy{}, nil) // cliente anti-SSRF de produção
	if err != nil {
		t.Fatal(err)
	}
	p, a := newBrowserKeys(t)
	_, err = sender.Send(context.Background(), Subscription{Endpoint: srv.URL, P256dh: p, Auth: a}, []byte("{}"))
	if !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("esperado ErrBlockedAddress, got %v", err)
	}
}
