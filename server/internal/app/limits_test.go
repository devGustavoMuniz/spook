package app

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

// Estourar qualquer limite responde 429 com Retry-After. Nunca 503: um 503 sem Server-Timing não vem do backend.
func TestEveryRateLimiterAnswers429NotServiceUnavailable(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := limitByPath("", ratelimit.New(0.001, 1), ratelimit.New(0.001, 1), ratelimit.New(0.001, 1))(ok)

	for i, path := range []string{"/api/auth/login", "/api/guilds", "/api/gateway", "/api/channels/1/typing"} {
		do := func() *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, path, nil)
			req.RemoteAddr = fmt.Sprintf("203.0.113.%d:1234", i+1) // um IP por caminho: /api/* compartilha o limitador
			h.ServeHTTP(rec, req)
			return rec
		}
		if first := do(); first.Code != http.StatusNoContent {
			t.Fatalf("%s: a primeira requisição deveria passar, veio %d", path, first.Code)
		}
		over := do()
		if over.Code != http.StatusTooManyRequests {
			t.Fatalf("%s: excesso deveria dar 429, deu %d", path, over.Code)
		}
		if over.Header().Get("Retry-After") == "" {
			t.Fatalf("%s: 429 sem Retry-After", path)
		}
	}
}
