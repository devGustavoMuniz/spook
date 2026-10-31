package dm

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

type OpenInput struct {
	Body struct {
		RecipientID  *string  `json:"recipient_id,omitempty" doc:"DM 1:1: ID do outro usuário (precisa compartilhar um servidor com você)"`
		RecipientIDs []string `json:"recipient_ids,omitempty" maxItems:"9" doc:"DM em grupo: de 1 a 9 usuários (máx. 10 participantes contando você, o dono); cada um precisa compartilhar um servidor com você"`
	}
}

// OpenOutput devolve 201 quando a DM foi criada e 200 quando a DM 1:1 já existia.
type OpenOutput struct {
	Status int
	Body   channel.ChannelPayload
}

type ListOutput struct{ Body []channel.ChannelPayload }

type RecipientPath struct {
	ChannelID string `path:"channel_id" doc:"ID da DM"`
	UserID    string `path:"user_id" doc:"ID do participante, ou @me (só em DELETE: sair da DM em grupo)"`
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, method, path, summary string, status int, errs ...int) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
			Tags: []string{"dms"}, Security: security, Middlewares: mw,
			Errors: append([]int{http.StatusUnauthorized}, errs...),
		}
	}
	notFound, forbidden, invalid, conflict := http.StatusNotFound, http.StatusForbidden, http.StatusUnprocessableEntity, http.StatusConflict

	huma.Register(api, op("listDMs", http.MethodGet, "/api/users/@me/channels",
		"DMs do usuário com os participantes, da atividade mais recente para a mais antiga", 0),
		func(ctx context.Context, _ *struct{}) (*ListOutput, error) {
			cs, err := h.svc.List(ctx, h.userID(ctx))
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &ListOutput{Body: channel.Payloads(cs)}, nil
		})

	huma.Register(api, op("openDM", http.MethodPost, "/api/users/@me/channels",
		"Abre uma DM 1:1 (recipient_id; 201 se criou, 200 se já existia) ou cria uma DM em grupo (recipient_ids; 201). Limite: 10 por minuto",
		http.StatusCreated, forbidden, invalid, http.StatusTooManyRequests),
		func(ctx context.Context, in *OpenInput) (*OpenOutput, error) {
			one, many := in.Body.RecipientID != nil, len(in.Body.RecipientIDs) > 0
			if one == many {
				return nil, huma.Error422UnprocessableEntity("informe recipient_id (DM 1:1) ou recipient_ids (DM em grupo), não os dois")
			}
			uid := h.userID(ctx)
			if one {
				rid, ok := httpx.ParseID(*in.Body.RecipientID)
				if !ok {
					return nil, huma.Error422UnprocessableEntity("recipient_id inválido")
				}
				c, created, err := h.svc.Open(ctx, uid, rid)
				if err != nil {
					return nil, httpx.Err(err)
				}
				st := http.StatusOK
				if created {
					st = http.StatusCreated
				}
				return &OpenOutput{Status: st, Body: c.Payload()}, nil
			}
			ids := make([]int64, len(in.Body.RecipientIDs))
			for i, s := range in.Body.RecipientIDs {
				id, ok := httpx.ParseID(s)
				if !ok {
					return nil, huma.Error422UnprocessableEntity("recipient_ids contém um ID inválido")
				}
				ids[i] = id
			}
			c, err := h.svc.CreateGroup(ctx, uid, ids)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &OpenOutput{Status: http.StatusCreated, Body: c.Payload()}, nil
		})

	huma.Register(api, op("addDMRecipient", http.MethodPut, "/api/channels/{channel_id}/recipients/{user_id}",
		"Adiciona um participante à DM em grupo (só o dono; o convidado precisa compartilhar um servidor com o dono)",
		0, notFound, forbidden, invalid, conflict),
		func(ctx context.Context, in *RecipientPath) (*struct{ Body channel.ChannelPayload }, error) {
			cid, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			tid, ok := httpx.ParseID(in.UserID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			c, err := h.svc.AddRecipient(ctx, h.userID(ctx), cid, tid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body channel.ChannelPayload }{Body: c.Payload()}, nil
		})

	huma.Register(api, op("removeDMRecipient", http.MethodDelete, "/api/channels/{channel_id}/recipients/{user_id}",
		"Remove um participante da DM em grupo (só o dono) ou, com @me, sai dela. O dono não sai nem é removido (409)",
		http.StatusNoContent, notFound, forbidden, invalid, conflict),
		func(ctx context.Context, in *RecipientPath) (*struct{}, error) {
			cid, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			me := h.userID(ctx)
			tid := me
			if in.UserID != "@me" {
				if tid, ok = httpx.ParseID(in.UserID); !ok {
					return nil, httpx.BadID("usuário")
				}
			}
			return nil, httpx.Err(h.svc.RemoveRecipient(ctx, me, cid, tid))
		})
}
