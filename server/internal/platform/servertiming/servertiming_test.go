package servertiming

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"
)

var appDur = regexp.MustCompile(`^app;dur=\d+\.\d{2}(, [a-z0-9-]+;dur=\d+\.\d{2})*$`)

func serve(h http.HandlerFunc) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	Middleware(h).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	return rec
}

func TestHeaderOnWrite(t *testing.T) {
	rec := serve(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	if got := rec.Header().Get("Server-Timing"); !appDur.MatchString(got) {
		t.Fatalf("Server-Timing = %q", got)
	}
}

func TestHeaderOnWriteHeader(t *testing.T) {
	rec := serve(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	if rec.Code != http.StatusTeapot || !appDur.MatchString(rec.Header().Get("Server-Timing")) {
		t.Fatalf("code=%d header=%q", rec.Code, rec.Header().Get("Server-Timing"))
	}
}

func TestHeaderWhenHandlerWritesNothing(t *testing.T) {
	rec := serve(func(http.ResponseWriter, *http.Request) {})
	if !appDur.MatchString(rec.Header().Get("Server-Timing")) {
		t.Fatalf("Server-Timing = %q", rec.Header().Get("Server-Timing"))
	}
}

func TestAddedMetricsAreAppendedAndSummed(t *testing.T) {
	rec := serve(func(w http.ResponseWriter, r *http.Request) {
		Add(r.Context(), "argon2", 30*time.Millisecond)
		Add(r.Context(), "argon2", 12500*time.Microsecond)
		w.WriteHeader(http.StatusOK)
	})
	got := rec.Header().Get("Server-Timing")
	if !appDur.MatchString(got) || !regexp.MustCompile(`, argon2;dur=42\.50$`).MatchString(got) {
		t.Fatalf("Server-Timing = %q", got)
	}
}

func TestAppDurationReflectsProcessingTime(t *testing.T) {
	rec := serve(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(25 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	})
	var dur float64
	if _, err := fmtSscan(rec.Header().Get("Server-Timing"), &dur); err != nil || dur < 25 || dur > 250 {
		t.Fatalf("dur = %v err=%v header=%q", dur, err, rec.Header().Get("Server-Timing"))
	}
}

func TestAddOutsideRequestIsNoop(t *testing.T) {
	Add(t.Context(), "x", time.Second) // não deve entrar em pânico
}

func TestFlushAndHijackAreForwarded(t *testing.T) {
	var flushed bool
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
			flushed = true
		}
		if _, ok := w.(http.Hijacker); !ok {
			t.Error("o writer deveria expor http.Hijacker")
		}
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !flushed || !rec.Flushed {
		t.Fatal("Flush não foi repassado")
	}
	if rec.Header().Get("Server-Timing") == "" {
		t.Fatal("o Flush deveria ter escrito o header antes")
	}
}

func fmtSscan(header string, dur *float64) (int, error) {
	return fmt.Sscanf(header, "app;dur=%f", dur)
}
