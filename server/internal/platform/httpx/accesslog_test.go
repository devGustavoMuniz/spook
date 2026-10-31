package httpx

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

func TestLogServerErrorsLogsAndExposesRequestID(t *testing.T) {
	logs := captureLogs(t)
	h := middleware.RequestID(LogServerErrors(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/guilds", nil))

	id := rec.Header().Get("X-Request-Id")
	if id == "" {
		t.Fatal("X-Request-Id deve acompanhar a resposta, para o usuário poder reportar")
	}
	out := logs.String()
	for _, want := range []string{"resposta 5xx", "status=503", "path=/api/guilds", "request_id=" + id} {
		if !strings.Contains(out, want) {
			t.Fatalf("log sem %q: %s", want, out)
		}
	}
}

func TestLogServerErrorsIgnoresNon5xx(t *testing.T) {
	logs := captureLogs(t)
	for _, code := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusTooManyRequests} {
		h := LogServerErrors(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	}
	if logs.Len() != 0 {
		t.Fatalf("só 5xx deve ser logado: %s", logs.String())
	}
}

func TestLogServerErrorsKeepsHijackAndFlush(t *testing.T) {
	var gotFlusher, gotHijacker bool
	h := LogServerErrors(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, gotFlusher = w.(http.Flusher)
		_, gotHijacker = w.(http.Hijacker)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	if !gotFlusher || !gotHijacker {
		t.Fatalf("o wrapper precisa repassar Flush e Hijack (WebSocket): flusher=%v hijacker=%v", gotFlusher, gotHijacker)
	}
}
