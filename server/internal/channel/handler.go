package channel

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

type GuildPath struct {
	GuildID string `path:"guild_id" doc:"ID do servidor"`
}

type ChannelPath struct {
	ChannelID string `path:"channel_id" doc:"ID do canal"`
}

type CreateChannelInput struct {
	GuildPath
	Body struct {
		Type     int     `json:"type" enum:"0,1,2" doc:"0 texto, 1 voz, 2 categoria"`
		Name     string  `json:"name" minLength:"1" maxLength:"100"`
		ParentID *string `json:"parent_id,omitempty" doc:"ID de uma categoria do servidor"`
		Position *int32  `json:"position,omitempty" minimum:"0" doc:"Padrão: ao final"`
	}
}

type ChannelOutput struct{ Body ChannelPayload }

type ChannelListOutput struct{ Body []ChannelPayload }

type UpdateChannelInput struct {
	ChannelPath
	Body struct {
		Name     *string `json:"name,omitempty" minLength:"1" maxLength:"100"`
		Position *int32  `json:"position,omitempty" minimum:"0"`
		Topic    *string `json:"topic,omitempty" maxLength:"1024" doc:"Tópico do canal de texto (MANAGE_CHANNELS); vazio remove"`
	}
}

type ChannelPlacement struct {
	ID       string  `json:"id"`
	Position int32   `json:"position" minimum:"0"`
	ParentID *string `json:"parent_id" nullable:"true" doc:"Categoria do canal; null o deixa fora de categorias"`
}

type ReorderChannelsInput struct {
	GuildPath
	Body struct {
		Channels []ChannelPlacement `json:"channels" maxItems:"500"`
	}
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, method, path, summary string, status int, errs ...int) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
			Tags: []string{"channels"}, Security: security, Middlewares: mw,
			Errors: append([]int{http.StatusUnauthorized, http.StatusNotFound}, errs...),
		}
	}

	huma.Register(api, op("listGuildChannels", http.MethodGet, "/api/guilds/{guild_id}/channels", "Canais do servidor, ordenados", 0, http.StatusForbidden),
		func(ctx context.Context, in *struct{ GuildPath }) (*ChannelListOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			cs, err := h.svc.List(ctx, h.userID(ctx), gid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &ChannelListOutput{Body: Payloads(cs)}, nil
		})

	huma.Register(api, op("createChannel", http.MethodPost, "/api/guilds/{guild_id}/channels", "Cria canal de texto, voz ou categoria", http.StatusCreated, http.StatusForbidden, http.StatusUnprocessableEntity),
		func(ctx context.Context, in *CreateChannelInput) (*ChannelOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			ci := CreateParams{Type: Type(in.Body.Type), Name: in.Body.Name, Position: in.Body.Position}
			if in.Body.ParentID != nil {
				pid, ok := httpx.ParseID(*in.Body.ParentID)
				if !ok {
					return nil, huma.Error422UnprocessableEntity("parent_id inválido")
				}
				ci.ParentID = &pid
			}
			c, err := h.svc.Create(ctx, h.userID(ctx), gid, ci)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &ChannelOutput{Body: c.Payload()}, nil
		})

	huma.Register(api, op("reorderChannels", http.MethodPatch, "/api/guilds/{guild_id}/channels/positions", "Reordena canais e categorias em lote", 0, http.StatusForbidden, http.StatusUnprocessableEntity),
		func(ctx context.Context, in *ReorderChannelsInput) (*ChannelListOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			ps := make([]Placement, 0, len(in.Body.Channels))
			for _, e := range in.Body.Channels {
				id, ok := httpx.ParseID(e.ID)
				if !ok {
					return nil, huma.Error422UnprocessableEntity("id de canal inválido")
				}
				p := Placement{ID: id, Position: e.Position}
				if e.ParentID != nil {
					pid, ok := httpx.ParseID(*e.ParentID)
					if !ok {
						return nil, huma.Error422UnprocessableEntity("parent_id inválido")
					}
					p.ParentID = &pid
				}
				ps = append(ps, p)
			}
			cs, err := h.svc.Reorder(ctx, h.userID(ctx), gid, ps)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &ChannelListOutput{Body: Payloads(cs)}, nil
		})

	huma.Register(api, op("updateChannel", http.MethodPatch, "/api/channels/{channel_id}", "Renomeia, reposiciona ou muda o tópico de um canal (MANAGE_CHANNELS)", 0, http.StatusForbidden, http.StatusUnprocessableEntity),
		func(ctx context.Context, in *UpdateChannelInput) (*ChannelOutput, error) {
			id, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			c, err := h.svc.Update(ctx, h.userID(ctx), id, UpdateParams{Name: in.Body.Name, Position: in.Body.Position, Topic: in.Body.Topic})
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &ChannelOutput{Body: c.Payload()}, nil
		})

	huma.Register(api, op("deleteChannel", http.MethodDelete, "/api/channels/{channel_id}", "Exclui um canal ou categoria", http.StatusNoContent, http.StatusForbidden),
		func(ctx context.Context, in *struct{ ChannelPath }) (*struct{}, error) {
			id, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			return nil, httpx.Err(h.svc.Delete(ctx, h.userID(ctx), id))
		})

	owPath := "/api/channels/{channel_id}/overwrites"
	huma.Register(api, op("listChannelOverwrites", http.MethodGet, owPath, "Permissões por canal (overwrites); exige MANAGE_CHANNELS", 0, http.StatusForbidden),
		func(ctx context.Context, in *struct{ ChannelPath }) (*OverwriteListOutput, error) {
			id, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			ows, err := h.svc.Overwrites(ctx, h.userID(ctx), id)
			if err != nil {
				return nil, httpx.Err(err)
			}
			out := &OverwriteListOutput{Body: make([]OverwritePayload, len(ows))}
			for i, o := range ows {
				out.Body[i] = o.Payload()
			}
			return out, nil
		})

	huma.Register(api, op("setChannelOverwrite", http.MethodPut, owPath+"/{type}/{target_id}",
		"Define o overwrite de um cargo (o @everyone tem o ID do servidor) ou membro; permitir e negar vazios removem. Canal privado = negar VIEW_CHANNEL ao @everyone e permitir a cargos/membros",
		0, http.StatusForbidden, http.StatusUnprocessableEntity, http.StatusTooManyRequests),
		func(ctx context.Context, in *struct {
			OverwritePath
			Body struct {
				Allow int64 `json:"allow" minimum:"0" doc:"Bitflags de canal permitidos"`
				Deny  int64 `json:"deny" minimum:"0" doc:"Bitflags de canal negados"`
			}
		}) (*OverwriteOutput, error) {
			cid, tid, err := in.ids()
			if err != nil {
				return nil, err
			}
			o, serr := h.svc.SetOverwrite(ctx, h.userID(ctx), cid, perm.TargetType(in.Type), tid, perm.Perm(in.Body.Allow), perm.Perm(in.Body.Deny))
			if serr != nil {
				return nil, httpx.Err(serr)
			}
			return &OverwriteOutput{Body: o.Payload()}, nil
		})

	huma.Register(api, op("deleteChannelOverwrite", http.MethodDelete, owPath+"/{type}/{target_id}", "Remove o overwrite de um alvo (volta a herdar)", http.StatusNoContent, http.StatusForbidden, http.StatusTooManyRequests),
		func(ctx context.Context, in *struct{ OverwritePath }) (*struct{}, error) {
			cid, tid, err := in.ids()
			if err != nil {
				return nil, err
			}
			return nil, httpx.Err(h.svc.DeleteOverwrite(ctx, h.userID(ctx), cid, perm.TargetType(in.Type), tid))
		})

	huma.Register(api, op("getMyChannelPermissions", http.MethodGet, "/api/channels/{channel_id}/my-permissions", "Minhas permissões efetivas neste canal (cargos + overwrites)", 0, http.StatusForbidden),
		func(ctx context.Context, in *struct{ ChannelPath }) (*struct {
			Body struct {
				Permissions int64 `json:"permissions" doc:"Bitflags efetivos no canal"`
			}
		}, error) {
			id, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			p, err := h.svc.MyPermissions(ctx, h.userID(ctx), id)
			if err != nil {
				return nil, httpx.Err(err)
			}
			out := &struct {
				Body struct {
					Permissions int64 `json:"permissions" doc:"Bitflags efetivos no canal"`
				}
			}{}
			out.Body.Permissions = int64(p)
			return out, nil
		})
}

type OverwritePath struct {
	ChannelPath
	Type     string `path:"type" enum:"role,member" doc:"Tipo do alvo"`
	TargetID string `path:"target_id" doc:"ID do cargo (o @everyone tem o ID do servidor) ou do membro"`
}

func (p OverwritePath) ids() (int64, int64, error) {
	cid, ok := httpx.ParseID(p.ChannelID)
	if !ok {
		return 0, 0, httpx.BadID("canal")
	}
	tid, ok := httpx.ParseID(p.TargetID)
	if !ok {
		return 0, 0, httpx.BadID("alvo")
	}
	return cid, tid, nil
}

type OverwriteListOutput struct{ Body []OverwritePayload }
type OverwriteOutput struct{ Body OverwritePayload }
