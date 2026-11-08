package download

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type Handler struct{ svc *Service }

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

type latestOutput struct {
	CacheControl string `header:"Cache-Control"`
	ETag         string `header:"ETag"`
	Body         Release
}

// Register expõe a rota pública (sem sessão). O rate limit por IP de /api/* já vale para ela.
func (h *Handler) Register(api huma.API) {
	huma.Register(api, huma.Operation{
		OperationID: "getLatestDownload", Method: http.MethodGet, Path: "/api/downloads/latest",
		Summary: "Último release do app desktop (público, sem sessão; cache de 5 min no servidor)",
		Tags:    []string{"downloads"},
		Errors:  []int{http.StatusNotFound, http.StatusServiceUnavailable},
	}, func(ctx context.Context, in *struct {
		IfNoneMatch string `header:"If-None-Match"`
	}) (*latestOutput, error) {
		rel, err := h.svc.Latest(ctx)
		if err != nil {
			return nil, httpx.Err(err)
		}
		b, _ := json.Marshal(rel)
		sum := sha256.Sum256(b)
		etag := `"` + hex.EncodeToString(sum[:8]) + `"`
		if in.IfNoneMatch == etag {
			return nil, huma.Status304NotModified()
		}
		return &latestOutput{CacheControl: "public, max-age=60", ETag: etag, Body: *rel}, nil
	})
}
