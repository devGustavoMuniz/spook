// Package servertiming mede o tempo de processamento de cada requisição e o devolve no header
// Server-Timing (https://www.w3.org/TR/server-timing/), para separar o custo do backend do da rede.
//
// O header sai com a métrica `app` (do início da requisição até os headers da resposta serem escritos)
// mais as métricas registradas com Add, por exemplo `argon2` (tempo de hash de senha).
package servertiming

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type ctxKey struct{}

type metric struct {
	name string
	dur  time.Duration
}

type recorder struct {
	mu      sync.Mutex
	metrics []metric
}

// Add registra uma métrica extra na requisição em curso (soma se o nome se repetir).
// Fora de uma requisição instrumentada não faz nada.
func Add(ctx context.Context, name string, d time.Duration) {
	r, _ := ctx.Value(ctxKey{}).(*recorder)
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.metrics {
		if r.metrics[i].name == name {
			r.metrics[i].dur += d
			return
		}
	}
	r.metrics = append(r.metrics, metric{name, d})
}

// Middleware adiciona o header Server-Timing a todas as respostas.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &recorder{}
		tw := &timingWriter{ResponseWriter: w, start: time.Now(), rec: rec}
		next.ServeHTTP(tw, r.WithContext(context.WithValue(r.Context(), ctxKey{}, rec)))
		tw.setHeader() // handler que não escreveu nada: o net/http ainda vai enviar 200 vazio
	})
}

type timingWriter struct {
	http.ResponseWriter
	start time.Time
	rec   *recorder
	done  bool
}

func (w *timingWriter) setHeader() {
	if w.done {
		return
	}
	w.done = true

	var b strings.Builder
	fmt.Fprintf(&b, "app;dur=%s", ms(time.Since(w.start)))
	w.rec.mu.Lock()
	for _, m := range w.rec.metrics {
		fmt.Fprintf(&b, ", %s;dur=%s", m.name, ms(m.dur))
	}
	w.rec.mu.Unlock()
	w.Header().Set("Server-Timing", b.String())
}

func ms(d time.Duration) string { return fmt.Sprintf("%.2f", float64(d.Microseconds())/1000) }

func (w *timingWriter) WriteHeader(code int) {
	w.setHeader()
	w.ResponseWriter.WriteHeader(code)
}

func (w *timingWriter) Write(p []byte) (int, error) {
	w.setHeader()
	return w.ResponseWriter.Write(p)
}

// Unwrap permite ao http.ResponseController alcançar o ResponseWriter original.
func (w *timingWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Flush e Hijack são repassados para não quebrar streaming nem WebSocket (gateway, Fase 3).
func (w *timingWriter) Flush() {
	w.setHeader()
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *timingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	return h.Hijack()
}
