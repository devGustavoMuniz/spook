package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLimiterBurstAndIsolation(t *testing.T) {
	l := New(1, 3)
	for i := range 3 {
		if !l.Allow("a") {
			t.Fatalf("requisição %d deveria passar", i)
		}
	}
	if l.Allow("a") {
		t.Fatal("4ª requisição deveria ser bloqueada")
	}
	if !l.Allow("b") {
		t.Fatal("outro IP não deveria ser afetado")
	}
}

func TestCleanup(t *testing.T) {
	l := New(1, 1)
	now := time.Now()
	l.now = func() time.Time { return now }
	l.Allow("a")
	l.now = func() time.Time { return now.Add(time.Hour) }
	l.Cleanup(time.Minute)
	if len(l.clients) != 0 {
		t.Fatal("cliente inativo deveria ser removido")
	}
}

func TestMiddleware429AndRealIP(t *testing.T) {
	h := Middleware(New(0.001, 1), "CF-Connecting-IP")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	do := func(ip string) int {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "10.0.0.1:1234"
		req.Header.Set("CF-Connecting-IP", ip)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if do("1.1.1.1") != http.StatusNoContent {
		t.Fatal("primeira deveria passar")
	}
	if do("1.1.1.1") != http.StatusTooManyRequests {
		t.Fatal("segunda do mesmo IP deveria dar 429")
	}
	if do("2.2.2.2") != http.StatusNoContent {
		t.Fatal("IP diferente (via header) deveria passar")
	}
}
