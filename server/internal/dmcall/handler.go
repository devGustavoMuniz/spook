package dmcall

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

// CallAcceptResult é a resposta de atender: o estado da chamada e o token para entrar na sala.
type CallAcceptResult struct {
	Call  Call                `json:"call"`
	Voice voice.TokenResponse `json:"voice"`
}

type channelPath struct {
	ChannelID string `path:"channel_id" doc:"ID da DM"`
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, path, summary string, status int, errs ...int) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: http.MethodPost, Path: path, Summary: summary, DefaultStatus: status,
			Tags: []string{"calls"}, Security: security, Middlewares: mw,
			Errors: append([]int{http.StatusUnauthorized, http.StatusNotFound}, errs...),
		}
	}
	forbidden, invalid, conflict, tooMany, unavailable := http.StatusForbidden, http.StatusUnprocessableEntity, http.StatusConflict, http.StatusTooManyRequests, http.StatusServiceUnavailable

	huma.Register(api, op("ringDMCall", "/api/channels/{channel_id}/call/ring",
		"Liga para as outras pessoas da DM: elas tocam por até 45 s (CALL_RING). Uma chamada tocando por DM; quem bloqueou, está em Não perturbar ou silenciou a conversa não ouve nada",
		0, forbidden, invalid, conflict, tooMany, unavailable),
		func(ctx context.Context, in *channelPath) (*struct{ Body Call }, error) {
			cid, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			p, err := h.svc.Ring(ctx, h.userID(ctx), cid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body Call }{Body: p}, nil
		})

	huma.Register(api, op("acceptDMCall", "/api/channels/{channel_id}/call/accept",
		"Atende a chamada: devolve o token de voz da DM (use-o como o de POST /voice/token)",
		0, invalid, unavailable),
		func(ctx context.Context, in *channelPath) (*struct{ Body CallAcceptResult }, error) {
			cid, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			p, tok, err := h.svc.Accept(ctx, h.userID(ctx), cid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body CallAcceptResult }{Body: CallAcceptResult{Call: p, Voice: tok}}, nil
		})

	huma.Register(api, op("declineDMCall", "/api/channels/{channel_id}/call/decline",
		"Recusa a chamada (idempotente; quem ligou não pode recusar, só cancelar)", http.StatusNoContent, invalid),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			cid, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			return nil, httpx.Err(h.svc.Decline(ctx, h.userID(ctx), cid))
		})

	huma.Register(api, op("cancelDMCall", "/api/channels/{channel_id}/call/cancel",
		"Cancela a chamada que você iniciou (idempotente): o toque para para todos", http.StatusNoContent, forbidden),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			cid, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			return nil, httpx.Err(h.svc.Cancel(ctx, h.userID(ctx), cid))
		})
}
