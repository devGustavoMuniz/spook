// Package ratelimit limita requisições por IP (RNF04) com token bucket em memória.
package ratelimit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type entry struct {
	lim  *rate.Limiter
	seen time.Time
}

type Limiter struct {
	mu      sync.Mutex
	clients map[string]*entry
	rate    rate.Limit
	burst   int
	now     func() time.Time
}

// New permite `burst` requisições de uma vez e repõe `perSecond` por segundo.
func New(perSecond float64, burst int) *Limiter {
	return &Limiter{clients: map[string]*entry{}, rate: rate.Limit(perSecond), burst: burst, now: time.Now}
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e, ok := l.clients[key]
	if !ok {
		e = &entry{lim: rate.NewLimiter(l.rate, l.burst)}
		l.clients[key] = e
	}
	e.seen = now
	return e.lim.AllowN(now, 1)
}

// Cleanup remove clientes inativos há mais de idle; chame periodicamente.
func (l *Limiter) Cleanup(idle time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := l.now().Add(-idle)
	for k, e := range l.clients {
		if e.seen.Before(cutoff) {
			delete(l.clients, k)
		}
	}
}

// ClientIP devolve o IP do cliente. Se realIPHeader estiver configurado (ex.: CF-Connecting-IP
// atrás do Cloudflare Tunnel), ele é confiável; caso contrário usa o RemoteAddr.
func ClientIP(r *http.Request, realIPHeader string) string {
	if realIPHeader != "" {
		if v := strings.TrimSpace(r.Header.Get(realIPHeader)); v != "" {
			return v
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Middleware responde 429 quando o IP excede o limite.
func Middleware(l *Limiter, realIPHeader string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.Allow(ClientIP(r, realIPHeader)) {
				w.Header().Set("Content-Type", "application/problem+json")
				w.Header().Set("Retry-After", "10")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"title":"Too Many Requests","status":429,"detail":"muitas requisições; tente novamente em instantes"}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
