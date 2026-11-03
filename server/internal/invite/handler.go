package invite

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
	// gate são os middlewares da ação que exige e-mail verificado (REQUIRE_EMAIL_VERIFICATION); nil = sem exigência.
	gate huma.Middlewares
}

// WithGate troca os middlewares da ação "criar convite" por gate (sessão + e-mail verificado).
func (h *Handler) WithGate(gate huma.Middlewares) *Handler { h.gate = gate; return h }

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

type CodePath struct {
	Code string `path:"code" doc:"Código do convite (8 caracteres)"`
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, method, path, summary string, status int, errs ...int) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
			Tags: []string{"invites"}, Security: security, Middlewares: mw,
			Errors: append([]int{http.StatusUnauthorized, http.StatusNotFound}, errs...),
		}
	}
	forbidden, invalid, gone := http.StatusForbidden, http.StatusUnprocessableEntity, http.StatusGone

	createInviteOp := op("createInvite", http.MethodPost, "/api/guilds/{guild_id}/invites", "Gera um convite (CREATE_INVITE)", http.StatusCreated, forbidden, invalid)
	if h.gate != nil {
		createInviteOp.Middlewares = h.gate
	}
	createInviteOp.Errors = appendStatus(createInviteOp.Errors, http.StatusForbidden)
	huma.Register(api, createInviteOp,
		func(ctx context.Context, in *struct {
			GuildID string `path:"guild_id"`
			Body    struct {
				MaxUses   *int32 `json:"max_uses,omitempty" minimum:"1" maximum:"1000000" doc:"Padrão: ilimitado"`
				ExpiresIn *int64 `json:"expires_in,omitempty" minimum:"1" maximum:"2592000" doc:"Segundos até expirar; padrão: não expira"`
			}
		}) (*struct{ Body InvitePayload }, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			p := CreateParams{MaxUses: in.Body.MaxUses}
			if in.Body.ExpiresIn != nil {
				d := time.Duration(*in.Body.ExpiresIn) * time.Second
				p.ExpiresIn = &d
			}
			inv, err := h.svc.Create(ctx, h.userID(ctx), gid, p)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body InvitePayload }{Body: inv.Payload()}, nil
		})

	huma.Register(api, op("listInvites", http.MethodGet, "/api/guilds/{guild_id}/invites", "Lista os convites do servidor (MANAGE_GUILD)", 0, forbidden),
		func(ctx context.Context, in *struct {
			GuildID string `path:"guild_id"`
		}) (*struct{ Body []InvitePayload }, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			invs, err := h.svc.List(ctx, h.userID(ctx), gid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			out := &struct{ Body []InvitePayload }{Body: make([]InvitePayload, len(invs))}
			for i, inv := range invs {
				out.Body[i] = inv.Payload()
			}
			return out, nil
		})

	huma.Register(api, op("getInvite", http.MethodGet, "/api/invites/{code}", "Consulta um convite: nome do servidor e nº de membros", 0, gone),
		func(ctx context.Context, in *struct{ CodePath }) (*struct{ Body PreviewPayload }, error) {
			if len(in.Code) != CodeLength {
				return nil, httpx.Err(ErrNotFound)
			}
			p, icon, err := h.svc.Peek(ctx, in.Code)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body PreviewPayload }{Body: PreviewPayload{
				Code: p.Code, GuildID: httpx.ID(p.GuildID), GuildName: p.GuildName, GuildIcon: icon,
				MemberCount: p.MemberCount, MaxUses: p.MaxUses, Uses: p.Uses, ExpiresAt: p.ExpiresAt,
			}}, nil
		})

	huma.Register(api, op("joinInvite", http.MethodPost, "/api/invites/{code}", "Entra no servidor pelo convite (quem já é membro não consome uso)", 0, gone, http.StatusConflict),
		func(ctx context.Context, in *struct{ CodePath }) (*struct{ Body guild.DetailPayload }, error) {
			if len(in.Code) != CodeLength {
				return nil, httpx.Err(ErrNotFound)
			}
			d, err := h.svc.Join(ctx, h.userID(ctx), in.Code)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &struct{ Body guild.DetailPayload }{Body: d.Payload()}, nil
		})

	huma.Register(api, op("revokeInvite", http.MethodDelete, "/api/invites/{code}", "Revoga um convite (criador ou MANAGE_GUILD)", http.StatusNoContent, forbidden),
		func(ctx context.Context, in *struct{ CodePath }) (*struct{}, error) {
			if len(in.Code) != CodeLength {
				return nil, httpx.Err(ErrNotFound)
			}
			return nil, httpx.Err(h.svc.Revoke(ctx, h.userID(ctx), in.Code))
		})
}

// appendStatus acrescenta um status à lista de erros documentados, sem repetir.
func appendStatus(list []int, status int) []int {
	for _, s := range list {
		if s == status {
			return list
		}
	}
	return append(list, status)
}
