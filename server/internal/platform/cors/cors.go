// Package cors libera a API para as origens do app desktop (Tauri), cujo webview tem origem
// `tauri://localhost` (macOS/Linux) ou `http://tauri.localhost` (Windows) e, portanto, chama a API
// em outra origem. O desktop usa Bearer, nunca cookie: por isso NÃO há Access-Control-Allow-Credentials.
package cors

import (
	"net/http"
	"strings"
)

const (
	allowMethods  = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
	allowHeaders  = "Authorization, Content-Type, X-Spook-Client"
	exposeHeaders = "Retry-After, Server-Timing"
	maxAge        = "600"
)

// Middleware aplica CORS às rotas sob `/api/`. Origem ausente ou fora de `allowed` não recebe nenhum
// cabeçalho CORS (a web same-origin segue igual). O preflight (OPTIONS com Access-Control-Request-Method)
// de origem permitida responde 204 sem passar adiante, portanto antes do rate limit.
func Middleware(allowed []string) func(http.Handler) http.Handler {
	set := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		if o = strings.TrimSpace(o); o != "" {
			set[o] = struct{}{}
		}
	}
	return func(next http.Handler) http.Handler {
		if len(set) == 0 {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin == "" || !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			if _, ok := set[origin]; !ok {
				next.ServeHTTP(w, r)
				return
			}
			h := w.Header()
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Origin", origin)
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				h.Add("Vary", "Access-Control-Request-Method")
				h.Add("Vary", "Access-Control-Request-Headers")
				h.Set("Access-Control-Allow-Methods", allowMethods)
				h.Set("Access-Control-Allow-Headers", allowHeaders)
				h.Set("Access-Control-Max-Age", maxAge)
				w.WriteHeader(http.StatusNoContent)
				return
			}
			h.Set("Access-Control-Expose-Headers", exposeHeaders)
			next.ServeHTTP(w, r)
		})
	}
}
