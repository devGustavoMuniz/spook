package cors

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const tauri = "tauri://localhost"

func serve(allowed []string, req *http.Request) (*httptest.ResponseRecorder, *bool) {
	called := false
	h := Middleware(allowed)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusTeapot)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec, &called
}

func TestPreflightFromAllowedOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/api/users/@me", nil)
	req.Header.Set("Origin", tauri)
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec, called := serve([]string{tauri}, req)
	if rec.Code != http.StatusNoContent || *called {
		t.Fatalf("code=%d called=%v", rec.Code, *called)
	}
	h := rec.Header()
	if h.Get("Access-Control-Allow-Origin") != tauri || h.Get("Access-Control-Allow-Headers") != allowHeaders ||
		h.Get("Access-Control-Allow-Methods") != allowMethods || h.Get("Access-Control-Max-Age") != maxAge {
		t.Fatalf("headers = %v", h)
	}
	if h.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("não deve haver Allow-Credentials")
	}
}

func TestActualRequestGetsHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/users/@me", nil)
	req.Header.Set("Origin", tauri)
	rec, called := serve([]string{tauri}, req)
	if !*called || rec.Code != http.StatusTeapot {
		t.Fatalf("code=%d called=%v", rec.Code, *called)
	}
	h := rec.Header()
	if h.Get("Access-Control-Allow-Origin") != tauri || h.Get("Vary") != "Origin" ||
		h.Get("Access-Control-Expose-Headers") != exposeHeaders || h.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("headers = %v", h)
	}
}

func TestDisallowedOriginGetsNothing(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodOptions} {
		req := httptest.NewRequest(method, "/api/users/@me", nil)
		req.Header.Set("Origin", "https://evil.example")
		req.Header.Set("Access-Control-Request-Method", "POST")
		rec, called := serve([]string{tauri}, req)
		if !*called {
			t.Fatalf("%s: deveria seguir adiante", method)
		}
		for k := range rec.Header() {
			if len(k) > 14 && k[:14] == "Access-Control" || k == "Vary" {
				t.Fatalf("%s: cabeçalho indevido %s", method, k)
			}
		}
	}
}

func TestNoOriginAndNonAPIPaths(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/users/@me", nil)
	rec, called := serve([]string{tauri}, req)
	if !*called || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("sem Origin não há CORS")
	}
	req = httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	req.Header.Set("Origin", tauri)
	rec, _ = serve([]string{tauri}, req)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("fora de /api/ não há CORS")
	}
}

func TestEmptyListDisables(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/api/x", nil)
	req.Header.Set("Origin", tauri)
	req.Header.Set("Access-Control-Request-Method", "GET")
	rec, called := serve(nil, req)
	if !*called || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("lista vazia desliga o CORS")
	}
}

func TestPlainOptionsFromAllowedOriginPassesThrough(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/api/x", nil)
	req.Header.Set("Origin", tauri)
	rec, called := serve([]string{tauri}, req)
	if !*called || rec.Header().Get("Access-Control-Allow-Origin") != tauri {
		t.Fatal("OPTIONS sem Request-Method não é preflight")
	}
}
