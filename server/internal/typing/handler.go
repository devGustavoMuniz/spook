package typing

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	huma.Register(api, huma.Operation{
		OperationID: "startTyping", Method: http.MethodPost, Path: "/api/channels/{channel_id}/typing",
		Summary: "Avisa que o usuário está digitando (TYPING_START no canal; no máx. 1 evento a cada ~3 s por canal, o excedente é ignorado com 204)",
		Tags:    []string{"messages"}, Security: security, Middlewares: mw, DefaultStatus: http.StatusNoContent,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusUnprocessableEntity},
	}, func(ctx context.Context, in *struct {
		ChannelID string `path:"channel_id" doc:"ID do canal ou da DM"`
	}) (*struct{}, error) {
		cid, ok := httpx.ParseID(in.ChannelID)
		if !ok {
			return nil, httpx.BadID("canal")
		}
		_, err := h.svc.Start(ctx, h.userID(ctx), cid)
		return nil, httpx.Err(err)
	})
}
