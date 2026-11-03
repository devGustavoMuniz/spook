package httpx

import (
	"context"
	"net/http"

	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

type clientIPKey struct{}

// WithClientIP guarda o IP do cliente (respeitando o header de IP real configurado) no contexto da requisição,
// para handlers do huma limitarem por IP sem acesso ao *http.Request.
func WithClientIP(realIPHeader string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), clientIPKey{}, ratelimit.ClientIP(r, realIPHeader))
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClientIP devolve o IP guardado por WithClientIP ("" fora dele).
func ClientIP(ctx context.Context) string {
	ip, _ := ctx.Value(clientIPKey{}).(string)
	return ip
}

// SecurityHeaders aplica cabeçalhos defensivos a todas as respostas e proíbe cache das rotas de autenticação
// (respostas com sessão, tokens ou redirecionamentos de OAuth). `Referrer-Policy: no-referrer` impede que um
// token na URL (link de e-mail) vaze para outro site pelo cabeçalho Referer.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		if len(r.URL.Path) >= 10 && r.URL.Path[:10] == "/api/auth/" {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}
