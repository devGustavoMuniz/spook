package httpx

import (
	"bufio"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// LogServerErrors registra em log toda resposta 5xx (método, caminho, status, duração, id da requisição) e devolve
// o id no header X-Request-Id, para o usuário poder reportar. Serve também para distinguir a origem de um 503:
// respostas do backend sempre trazem Server-Timing e X-Request-Id; um 503 sem esses headers veio da borda
// (Cloudflare/cloudflared) ou do container fora do ar, não do código da aplicação.
func LogServerErrors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		if id := middleware.GetReqID(r.Context()); id != "" {
			w.Header().Set("X-Request-Id", id)
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if sw.status >= http.StatusInternalServerError {
			slog.Error("resposta 5xx", "status", sw.status, "method", r.Method, "path", r.URL.Path,
				"duration_ms", time.Since(start).Milliseconds(), "request_id", middleware.GetReqID(r.Context()))
		}
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	return h.Hijack()
}
