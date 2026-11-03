package relationship

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

type payloadOut struct{ Body Relationship }

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, method, path, summary string, status int, errs ...int) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
			Tags: []string{"relationships"}, Security: security, Middlewares: mw,
			Errors: append([]int{http.StatusUnauthorized}, errs...),
		}
	}
	notFound, forbidden, invalid, conflict, tooMany := http.StatusNotFound, http.StatusForbidden, http.StatusUnprocessableEntity, http.StatusConflict, http.StatusTooManyRequests

	huma.Register(api, op("listRelationships", http.MethodGet, "/api/users/me/relationships",
		"Amigos, pedidos recebidos/enviados e bloqueados, paginados por ID da outra pessoa", 0, invalid),
		func(ctx context.Context, in *struct {
			Type  string `query:"type" enum:"friend,incoming,outgoing,blocked" doc:"Filtra por tipo; omitido = todos"`
			After string `query:"after" doc:"ID da última pessoa da página anterior (next_after)"`
			Limit int    `query:"limit" minimum:"1" maximum:"200" default:"100" doc:"Itens por página (máx. 200)"`
		}) (*struct{ Body RelationshipPage }, error) {
			var after int64
			if in.After != "" {
				id, ok := httpx.ParseID(in.After)
				if !ok {
					return nil, huma.Error422UnprocessableEntity("after inválido")
				}
				after = id
			}
			p, err := h.svc.List(ctx, h.userID(ctx), in.Type, after, in.Limit)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body RelationshipPage }{Body: p}, nil
		})

	huma.Register(api, op("requestFriend", http.MethodPost, "/api/users/me/friends",
		"Envia um pedido de amizade por username (se a pessoa já pediu a sua, aceita). Se a pessoa bloqueou você, a resposta é idêntica à de um pedido enviado, mas nada é gravado. Limite: 20 pedidos por hora",
		http.StatusCreated, notFound, invalid, conflict, tooMany),
		func(ctx context.Context, in *struct {
			Body struct {
				Username string `json:"username" minLength:"1" maxLength:"64" doc:"Username da pessoa (com ou sem @)"`
			}
		}) (*payloadOut, error) {
			p, err := h.svc.Request(ctx, h.userID(ctx), in.Body.Username)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &payloadOut{Body: p}, nil
		})

	type userPath struct {
		UserID string `path:"user_id" doc:"ID da outra pessoa"`
	}
	huma.Register(api, op("acceptFriend", http.MethodPut, "/api/users/me/friends/{user_id}",
		"Aceita o pedido de amizade recebido da pessoa", 0, notFound, invalid, conflict, tooMany),
		func(ctx context.Context, in *userPath) (*payloadOut, error) {
			id, ok := httpx.ParseID(in.UserID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			p, err := h.svc.Accept(ctx, h.userID(ctx), id)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &payloadOut{Body: p}, nil
		})

	huma.Register(api, op("removeFriend", http.MethodDelete, "/api/users/me/friends/{user_id}",
		"Desfaz a amizade, cancela o pedido enviado ou recusa o recebido (idempotente)", http.StatusNoContent, notFound, invalid, tooMany),
		func(ctx context.Context, in *userPath) (*struct{}, error) {
			id, ok := httpx.ParseID(in.UserID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			return nil, httpx.Err(h.svc.Remove(ctx, h.userID(ctx), id))
		})

	huma.Register(api, op("blockUser", http.MethodPut, "/api/users/me/blocks/{user_id}",
		"Bloqueia a pessoa: desfaz a amizade e cancela pedidos; impede DM 1:1 e chamadas nos dois sentidos (idempotente)",
		0, notFound, invalid, conflict, tooMany),
		func(ctx context.Context, in *userPath) (*payloadOut, error) {
			id, ok := httpx.ParseID(in.UserID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			p, err := h.svc.Block(ctx, h.userID(ctx), id)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &payloadOut{Body: p}, nil
		})

	huma.Register(api, op("unblockUser", http.MethodDelete, "/api/users/me/blocks/{user_id}",
		"Desbloqueia a pessoa (idempotente; a amizade não volta)", http.StatusNoContent, invalid, tooMany),
		func(ctx context.Context, in *userPath) (*struct{}, error) {
			id, ok := httpx.ParseID(in.UserID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			return nil, httpx.Err(h.svc.Unblock(ctx, h.userID(ctx), id))
		})

	huma.Register(api, op("getUserRelationship", http.MethodGet, "/api/users/{user_id}/relationship",
		"Seu relacionamento com a pessoa (none, friend, incoming, outgoing ou blocked): um só pedido para o cartão de perfil",
		0, notFound),
		func(ctx context.Context, in *userPath) (*struct{ Body RelationshipState }, error) {
			id, ok := httpx.ParseID(in.UserID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			st, err := h.svc.Get(ctx, h.userID(ctx), id)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body RelationshipState }{Body: st}, nil
		})

	huma.Register(api, op("inviteFriendToGuild", http.MethodPost, "/api/users/me/friends/{user_id}/invite",
		"Envia ao amigo, na DM, o link de um convite do servidor (cria ou reaproveita o convite; exige CREATE_INVITE no servidor)",
		http.StatusCreated, forbidden, notFound, invalid, conflict, tooMany, http.StatusServiceUnavailable),
		func(ctx context.Context, in *struct {
			UserID string `path:"user_id" doc:"ID do amigo"`
			Body   struct {
				GuildID string `json:"guild_id" doc:"Servidor para o qual convidar"`
			}
		}) (*struct{ Body FriendInviteResult }, error) {
			friend, ok := httpx.ParseID(in.UserID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			gid, ok := httpx.ParseID(in.Body.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			res, err := h.svc.InviteFriend(ctx, h.userID(ctx), friend, gid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body FriendInviteResult }{Body: res}, nil
		})
}
