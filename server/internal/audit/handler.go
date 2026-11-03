package audit

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

type AuditListOutput struct {
	Body struct {
		Entries []AuditEntryPayload `json:"entries"`
		HasMore bool                `json:"has_more"`
	}
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	huma.Register(api, huma.Operation{
		OperationID: "listAuditLogs", Method: http.MethodGet, Path: "/api/guilds/{guild_id}/audit-logs",
		Summary: "Registro de auditoria do servidor (VIEW_AUDIT_LOG), do mais novo ao mais antigo", Tags: []string{"audit"},
		Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusUnprocessableEntity},
	}, func(ctx context.Context, in *struct {
		GuildID string `path:"guild_id" doc:"ID do servidor"`
		Action  string `query:"action" maxLength:"64" doc:"Filtra por ação (ex.: member.ban)"`
		Actor   string `query:"actor" doc:"Filtra por quem agiu (ID do usuário)"`
		Before  string `query:"before" doc:"Cursor: ID da última entrada recebida"`
		Limit   int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
	}) (*AuditListOutput, error) {
		gid, ok := httpx.ParseID(in.GuildID)
		if !ok {
			return nil, httpx.BadID("servidor")
		}
		p := ListParams{Action: Action(in.Action), Limit: in.Limit}
		if in.Actor != "" {
			if p.Actor, ok = httpx.ParseID(in.Actor); !ok {
				return nil, huma.Error422UnprocessableEntity("actor inválido")
			}
		}
		if in.Before != "" {
			if p.Before, ok = httpx.ParseID(in.Before); !ok {
				return nil, huma.Error422UnprocessableEntity("before inválido")
			}
		}
		rows, more, err := h.svc.List(ctx, h.userID(ctx), gid, p)
		if err != nil {
			return nil, httpx.Err(err)
		}
		out := &AuditListOutput{}
		out.Body.HasMore = more
		out.Body.Entries = make([]AuditEntryPayload, len(rows))
		for i, r := range rows {
			out.Body.Entries[i] = r.Payload()
		}
		return out, nil
	})
}
