// Package ratelimit limita requisições por IP (RNF04) com token bucket em memória.
package ratelimit

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"golang.org/x/time/rate"
)

// blocked conta os pedidos recusados por limitador nomeado: spook.ratelimit.blocked{name}.
var blocked, _ = otel.Meter("spook/ratelimit").Int64Counter("spook.ratelimit.blocked",
	metric.WithDescription("Pedidos recusados (429) pelo limitador nomeado"))

func recordBlocked(name string) {
	if name != "" {
		blocked.Add(context.Background(), 1, metric.WithAttributes(attribute.String("name", name)))
	}
}

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
	name    string
}

// Named dá ao limitador o nome estável usado na métrica spook.ratelimit.blocked (ex.: "servers.create") e
// devolve o próprio limitador.
func (l *Limiter) Named(name string) *Limiter { l.name = name; return l }

// Name devolve o nome estável ("" se não tem).
func (l *Limiter) Name() string { return l.name }

// New permite `burst` requisições de uma vez e repõe `perSecond` por segundo.
func New(perSecond float64, burst int) *Limiter {
	return &Limiter{clients: map[string]*entry{}, rate: rate.Limit(perSecond), burst: burst, now: time.Now}
}

func (l *Limiter) Allow(key string) (ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e, ok := l.clients[key]
	if !ok {
		e = &entry{lim: rate.NewLimiter(l.rate, l.burst)}
		l.clients[key] = e
	}
	e.seen = now
	ok = e.lim.AllowN(now, 1)
	if !ok {
		recordBlocked(l.name)
	}
	return ok
}

// Take consome uma permissão da chave (que pode ser composta, ex.: "msg:<usuário>:<canal>").
// Quando o limite estoura devolve false e quanto falta esperar para a próxima permissão.
func (l *Limiter) Take(key string) (ok bool, retryAfter time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e, found := l.clients[key]
	if !found {
		e = &entry{lim: rate.NewLimiter(l.rate, l.burst)}
		l.clients[key] = e
	}
	e.seen = now
	r := e.lim.ReserveN(now, 1)
	if !r.OK() {
		recordBlocked(l.name)
		return false, time.Second
	}
	if d := r.DelayFrom(now); d > 0 {
		r.CancelAt(now) // não consome a vaga de quem foi recusado
		recordBlocked(l.name)
		return false, d
	}
	return true, 0
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
