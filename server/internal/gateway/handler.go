package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/coder/websocket"
	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/auth"
)

// Authenticator valida o token de sessão (implementada pelo auth.Service).
type Authenticator interface {
	Authenticate(ctx context.Context, token string) (int64, error)
}

// Handler expõe `GET /api/gateway` (upgrade) e `POST /api/gateway/ticket`.
type Handler struct {
	hub  *Hub
	auth Authenticator
	// userID lê o usuário autenticado do contexto (preenchido pelo middleware do auth).
	userID func(context.Context) int64
}

func NewHandler(hub *Hub, a Authenticator, userID func(context.Context) int64) *Handler {
	return &Handler{hub: hub, auth: a, userID: userID}
}

// TicketBody é a resposta de POST /api/gateway/ticket.
type TicketBody struct {
	Ticket    string `json:"ticket" doc:"Uso único; passe em GET /api/gateway?ticket=…"`
	ExpiresIn int    `json:"expires_in" doc:"Segundos de validade"`
}

// Register documenta no OpenAPI a emissão de tickets (o upgrade em si não cabe no OpenAPI).
func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	huma.Register(api, huma.Operation{
		OperationID: "createGatewayTicket", Method: http.MethodPost, Path: "/api/gateway/ticket",
		Summary: "Emite um ticket de uso único (30 s) para abrir o WebSocket sem headers (desktop)",
		Tags:    []string{"gateway"}, Security: security, Middlewares: mw, DefaultStatus: http.StatusCreated,
		Errors: []int{http.StatusUnauthorized, http.StatusServiceUnavailable},
	}, func(ctx context.Context, _ *struct{}) (*struct{ Body TicketBody }, error) {
		t, ok := h.hub.tk.issue(h.userID(ctx))
		if !ok {
			return nil, huma.Error503ServiceUnavailable("muitos tickets em aberto, tente em instantes")
		}
		return &struct{ Body TicketBody }{Body: TicketBody{Ticket: t, ExpiresIn: int(h.hub.cfg.TicketTTL.Seconds())}}, nil
	})
}

// ServeHTTP faz o handshake: autentica (ticket, Bearer ou cookie) e confere a Origin ANTES do
// upgrade; depois entrega a conexão ao hub.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeProblem(w, http.StatusMethodNotAllowed, "método não permitido")
		return
	}
	userID, err := h.authenticate(r)
	if err != nil {
		if errors.Is(err, auth.ErrUnauthorized) {
			writeProblem(w, http.StatusUnauthorized, "autenticação necessária")
		} else {
			slog.Error("gateway: falha ao autenticar", "err", err)
			writeProblem(w, http.StatusInternalServerError, "erro interno")
		}
		return
	}
	if !h.hub.originAllowed(r) {
		writeProblem(w, http.StatusForbidden, "origem não permitida")
		return
	}
	if h.hub.isClosed() {
		writeProblem(w, http.StatusServiceUnavailable, "servidor reiniciando")
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// A Origin já foi conferida acima (a lib só entende host, sem esquema).
		InsecureSkipVerify: true,
		// Sem compressão: poupa CPU e a RAM por conexão (RNF01).
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return // Accept já respondeu
	}
	c := h.hub.newConn(r.Context(), ws, userID)
	if !h.hub.addConn(c) {
		_ = ws.Close(CloseGoingAway, "servidor reiniciando")
		c.cancel()
		return
	}
	defer h.hub.removeConn(c)
	c.serve(r.Context())
}

func (h *Handler) authenticate(r *http.Request) (int64, error) {
	if t := r.URL.Query().Get("ticket"); t != "" {
		if id, ok := h.hub.tk.consume(t); ok {
			return id, nil
		}
		return 0, auth.ErrUnauthorized
	}
	tok := ""
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
		tok = strings.TrimPrefix(a, "Bearer ")
	} else if c, err := r.Cookie(auth.CookieName); err == nil {
		tok = c.Value
	}
	return h.auth.Authenticate(r.Context(), tok)
}

func writeProblem(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"title": http.StatusText(status), "status": status, "detail": msg})
}

// originAllowed aceita: sem Origin (cliente que não é navegador), o próprio host do serviço, as
// origens configuradas (tauri://localhost…) e, em dev, qualquer porta de localhost.
func (h *Hub) originAllowed(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	if err != nil || u.Host == "" {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	norm := strings.TrimRight(strings.ToLower(o), "/")
	for _, a := range h.cfg.AllowedOrigins {
		if strings.TrimRight(strings.ToLower(strings.TrimSpace(a)), "/") == norm {
			return true
		}
	}
	if h.cfg.Dev {
		switch u.Hostname() {
		case "localhost", "127.0.0.1", "::1":
			return true
		}
	}
	return false
}

func (h *Hub) isClosed() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.closed
}
