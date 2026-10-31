package webui

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandler(t *testing.T) {
	dir := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>spa</html>"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "sw.js"), []byte("self.addEventListener('push', () => {})"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "manifest.webmanifest"), []byte(`{"name":"Spook"}`), 0o644))
	must(os.MkdirAll(filepath.Join(dir, "assets"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "assets", "app-abc.js"), []byte("js"), 0o644))

	h := Handler(dir)
	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	if rec := get("/login"); rec.Code != 200 || !strings.Contains(rec.Body.String(), "spa") {
		t.Fatalf("rota do SPA deveria cair no index.html: %d %q", rec.Code, rec.Body.String())
	}
	rec := get("/assets/app-abc.js")
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("asset deveria ser imutável: %d %v", rec.Code, rec.Header())
	}
	// O service worker e o manifest vêm do public/ do front e precisam revalidar (nunca imutáveis).
	rec = get("/sw.js")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "addEventListener") {
		t.Fatalf("/sw.js deveria sair do diretório, não do fallback do SPA: %d %q", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("sw.js deve revalidar sempre (no-cache), veio %q", cc)
	}
	rec = get("/manifest.webmanifest")
	if rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("manifest deve revalidar: %d %v", rec.Code, rec.Header())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/manifest+json") {
		t.Fatalf("manifest com Content-Type %q", ct)
	}
	if rec := get("/api/nao-existe"); rec.Code != 404 {
		t.Fatalf("/api/* sem rota deve ser 404, foi %d", rec.Code)
	}
	if rec := get("/../../etc/passwd"); strings.Contains(rec.Body.String(), "root:") {
		t.Fatal("path traversal")
	}
}
