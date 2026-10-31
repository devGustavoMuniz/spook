package httpx

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

type out struct {
	Body struct {
		OK bool `json:"ok"`
	}
}

func newTestAPI(handler func() error) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	api := humachi.New(r, huma.DefaultConfig("t", "1"))
	huma.Get(api, "/boom", func(context.Context, *struct{}) (*out, error) { return nil, handler() })
	return r
}

func TestInternalErrorDoesNotLeakDetails(t *testing.T) {
	secret := errors.New(`HEAD de attachments/123/456/foto.png: operation error S3: HeadObject, StatusCode: 403, api error Forbidden`)
	h := newTestAPI(func() error { return secret })

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/boom", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, leak := range []string{"attachments/", "HeadObject", "S3", "Forbidden", "foto.png"} {
		if strings.Contains(body, leak) {
			t.Fatalf("o corpo vazou %q: %s", leak, body)
		}
	}
	if !strings.Contains(body, "erro interno do servidor") {
		t.Fatalf("mensagem genérica ausente: %s", body)
	}
}

func TestClientErrorsKeepTheirMessage(t *testing.T) {
	h := newTestAPI(func() error { return Err(errNotFound()) })
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/boom", nil))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "sumiu") {
		t.Fatalf("4xx deve manter a mensagem de negócio: %d %s", rec.Code, rec.Body.String())
	}
}

func TestUnavailableKeepsItsMessage(t *testing.T) {
	h := newTestAPI(func() error { return Err(errUnavailable()) })
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/boom", nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "voz desligada") {
		t.Fatalf("503 de funcionalidade desligada mantém a mensagem: %d %s", rec.Code, rec.Body.String())
	}
}

func errNotFound() error    { return apperr.NotFound("sumiu") }
func errUnavailable() error { return apperr.Unavailable("voz desligada") }
