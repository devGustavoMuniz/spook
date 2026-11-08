package download

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
)

func newTestAPI(t *testing.T, src Source) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t, huma.DefaultConfig("t", "1"))
	svc := NewService(src, "https://page")
	NewHandler(svc).Register(api)
	return api
}

func TestHandlerOK(t *testing.T) {
	api := newTestAPI(t, &fakeSrc{body: sampleRelease})
	res := api.Get("/api/downloads/latest")
	if res.Code != http.StatusOK || res.Header().Get("Cache-Control") != "public, max-age=60" || res.Header().Get("ETag") == "" {
		t.Fatalf("%d %v", res.Code, res.Header())
	}
	for _, want := range []string{`"version":"0.2.0"`, `"checksum_url"`, `"page_url"`, `"published_at"`, `"sha256"`} {
		if !strings.Contains(res.Body.String(), want) {
			t.Errorf("faltou %s em %s", want, res.Body)
		}
	}
	// If-None-Match com o ETag devolve 304.
	again := api.Get("/api/downloads/latest", "If-None-Match: "+res.Header().Get("ETag"))
	if again.Code != http.StatusNotModified {
		t.Fatalf("esperava 304: %d", again.Code)
	}
}

func TestHandlerErrors(t *testing.T) {
	nf := newTestAPI(t, &fakeSrc{err: ErrNoRelease}).Get("/api/downloads/latest")
	if nf.Code != http.StatusNotFound {
		t.Fatalf("404 esperado: %d", nf.Code)
	}
	un := newTestAPI(t, &fakeSrc{err: errors.New("github: token ghp_SEGREDO inválido")}).Get("/api/downloads/latest")
	if un.Code != http.StatusServiceUnavailable || strings.Contains(un.Body.String(), "SEGREDO") || strings.Contains(un.Body.String(), "github") {
		t.Fatalf("503 genérico esperado: %d %s", un.Code, un.Body)
	}
}
