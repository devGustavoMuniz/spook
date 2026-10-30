// Package health expõe o endpoint de verificação de saúde do serviço.
package health

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// Pinger é satisfeito pelo pool do pgx; definido aqui por quem consome.
type Pinger interface {
	Ping(ctx context.Context) error
}

type Handler struct{ db Pinger }

func NewHandler(db Pinger) *Handler { return &Handler{db: db} }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	status, code := "ok", http.StatusOK
	if err := h.db.Ping(ctx); err != nil {
		status, code = "degraded", http.StatusServiceUnavailable
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": status})
}
