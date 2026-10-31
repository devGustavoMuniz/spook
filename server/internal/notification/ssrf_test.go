package notification

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

func TestBlockedAddr(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "127.8.8.8", "::1", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
		"169.254.169.254", "169.254.0.1", "fe80::1", "fc00::1", "fd12:3456::1", "0.0.0.0", "::", "100.64.0.1", "100.127.255.255",
		"224.0.0.1", "ff02::1", "198.18.0.1", "240.0.0.1", "255.255.255.255", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
		"64:ff9b::7f00:1",
	}
	for _, s := range blocked {
		if !BlockedAddr(netip.MustParseAddr(s)) {
			t.Errorf("%s deveria ser bloqueado", s)
		}
	}
	allowed := []string{"8.8.8.8", "142.250.80.46", "172.15.0.1", "172.32.0.1", "2607:f8b0:4004:c07::5f", "17.253.144.10", "100.128.0.1"}
	for _, s := range allowed {
		if BlockedAddr(netip.MustParseAddr(s)) {
			t.Errorf("%s deveria ser permitido", s)
		}
	}
}

type fakeResolver map[string][]string

func (f fakeResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	ips, ok := f[host]
	if !ok {
		return nil, errors.New("no such host")
	}
	var out []netip.Addr
	for _, s := range ips {
		out = append(out, netip.MustParseAddr(s))
	}
	return out, nil
}

func TestEndpointPolicyValidate(t *testing.T) {
	p := EndpointPolicy{Resolver: fakeResolver{
		"fcm.googleapis.com": {"142.250.80.42"}, "web.push.apple.com": {"17.253.144.10", "2607:f8b0::1"},
		"evil.example": {"8.8.8.8", "10.0.0.5"}, "meta.example": {"169.254.169.254"}, "loop.example": {"::1"},
	}}
	ok := []string{
		"https://fcm.googleapis.com/fcm/send/abc", "https://fcm.googleapis.com:443/x", "https://web.push.apple.com/Qk1",
		"HTTPS://fcm.googleapis.com/x", "https://8.8.8.8/push",
	}
	for _, e := range ok {
		if err := p.Validate(context.Background(), e); err != nil {
			t.Errorf("%s deveria valer: %v", e, err)
		}
	}
	bad := []string{
		"", "não é url", "/relativa", "http://fcm.googleapis.com/x", "ftp://fcm.googleapis.com/x", "https://", "https:///x",
		"https://user:pass@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x",
		"https://127.0.0.1/x", "https://[::1]/x", "https://10.1.2.3/x", "https://192.168.0.10/x", "https://169.254.169.254/latest/meta-data",
		"https://localhost/x", "https://api.localhost/x", "https://[::ffff:10.0.0.1]/x", "https://0.0.0.0/x",
		"https://evil.example/x",      // um dos IPs resolvidos é interno
		"https://meta.example/x",      // resolve para link-local
		"https://loop.example/x",      // resolve para loopback
		"https://naoexiste.example/x", // não resolve
		"https://fcm.googleapis.com/" + string(make([]byte, 3000)),
	}
	for _, e := range bad {
		err := p.Validate(context.Background(), e)
		if !apperr.IsKind(err, apperr.KindInvalid) {
			t.Errorf("%q deveria ser recusado (422), got %v", e, err)
		}
	}
}

func TestEndpointPolicyAllowPrivateRelaxes(t *testing.T) {
	p := EndpointPolicy{AllowPrivate: true}
	for _, e := range []string{"https://127.0.0.1:8443/x", "https://localhost:9999/y"} {
		if err := p.Validate(context.Background(), e); err != nil {
			t.Errorf("%s: %v", e, err)
		}
	}
	// o relaxamento não aceita http nem credenciais
	for _, e := range []string{"http://127.0.0.1:8080/x", "https://u:p@127.0.0.1/x"} {
		if err := p.Validate(context.Background(), e); err == nil {
			t.Errorf("%s deveria ser recusado", e)
		}
	}
}

func TestDialControlBlocksResolvedInternalIP(t *testing.T) {
	if err := dialControl("tcp", "127.0.0.1:443", nil); !errors.Is(err, ErrBlockedAddress) {
		t.Fatal(err)
	}
	if err := dialControl("tcp", "[::ffff:10.0.0.1]:443", nil); !errors.Is(err, ErrBlockedAddress) {
		t.Fatal(err)
	}
	if err := dialControl("tcp", "8.8.8.8:443", nil); err != nil {
		t.Fatal(err)
	}
}

// O cliente de produção não chega a conectar em um servidor local (o IP já resolvido é recusado).
func TestHTTPClientRefusesLoopbackServer(t *testing.T) {
	hits := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits <- struct{}{} }))
	defer srv.Close()

	client := NewHTTPClient(EndpointPolicy{}, 2*time.Second)
	resp, err := client.Get(srv.URL) //nolint:bodyclose // a conexão é recusada: não há resposta
	if resp != nil {
		_ = resp.Body.Close()
	}
	if !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("esperado ErrBlockedAddress, got %v", err)
	}
	select {
	case <-hits:
		t.Fatal("o servidor local recebeu a requisição")
	default:
	}
	// "localhost" também: o nome resolve, mas o IP é recusado na conexão
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	resp, err = client.Get("http://localhost:" + port)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("localhost: %v", err)
	}

	// relaxado (testes): conecta
	relaxed := NewHTTPClient(EndpointPolicy{AllowPrivate: true}, 2*time.Second)
	resp, err = relaxed.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
}

func TestHTTPClientDoesNotFollowRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("seguiu o redirecionamento") }))
	defer target.Close()
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer redir.Close()
	resp, err := NewHTTPClient(EndpointPolicy{AllowPrivate: true}, 2*time.Second).Get(redir.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
