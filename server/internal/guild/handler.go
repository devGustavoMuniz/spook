package guild

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
	// gate são os middlewares da ação que exige e-mail verificado (REQUIRE_EMAIL_VERIFICATION); nil = sem exigência.
	gate huma.Middlewares
	// sensitive são os middlewares das ações que exigem a senha confirmada há pouco (excluir servidor e transferir
	// a posse); nil = sem exigência.
	sensitive huma.Middlewares
}

// WithSensitive liga a confirmação de senha (sessão + RequireRecentPassword) a excluir servidor e transferir posse.
func (h *Handler) WithSensitive(sensitive huma.Middlewares) *Handler {
	h.sensitive = sensitive
	return h
}

// WithGate troca os middlewares da ação "criar servidor" por gate (sessão + e-mail verificado).
func (h *Handler) WithGate(gate huma.Middlewares) *Handler { h.gate = gate; return h }

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

// DetailView converte o servidor completo na resposta da API (usado também pelo handler de convites).
func DetailView(d Detail) DetailPayload { return d.Payload() }

type GuildPath struct {
	GuildID string `path:"guild_id" doc:"ID do servidor"`
}

type MemberPath struct {
	GuildPath
	UserID string `path:"user_id" doc:"ID do usuário, ou @me"`
}

type RolePath struct {
	GuildPath
	RoleID string `path:"role_id" doc:"ID do cargo"`
}

type MemberRolePath struct {
	MemberPath
	RoleID string `path:"role_id" doc:"ID do cargo"`
}

type DetailOutput struct{ Body DetailPayload }
type DetailListOutput struct{ Body []DetailPayload }
type GuildOutput struct{ Body GuildPayload }
type MemberOutput struct{ Body MemberPayload }
type RoleOutput struct{ Body RolePayload }
type RoleListOutput struct{ Body []RolePayload }

type BanListOutput struct {
	Body struct {
		Bans    []BanPayload `json:"bans"`
		HasMore bool         `json:"has_more"`
	}
}

type MemberListOutput struct {
	Body struct {
		Members []MemberPayload `json:"members"`
		HasMore bool            `json:"has_more"`
	}
}

func (h *Handler) parseUser(ctx context.Context, s string) (int64, bool) {
	if s == "@me" {
		return h.userID(ctx), true
	}
	return httpx.ParseID(s)
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, method, path, summary string, status int, errs ...int) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
			Tags: []string{"guilds"}, Security: security, Middlewares: mw,
			Errors: append([]int{http.StatusUnauthorized}, errs...),
		}
	}
	notFound, forbidden, invalid, conflict := http.StatusNotFound, http.StatusForbidden, http.StatusUnprocessableEntity, http.StatusConflict

	createGuildOp := op("createGuild", http.MethodPost, "/api/guilds", "Cria um servidor (o criador vira o dono)", http.StatusCreated, invalid, conflict)
	if h.gate != nil {
		createGuildOp.Middlewares = h.gate
	}
	createGuildOp.Errors = appendStatus(createGuildOp.Errors, http.StatusForbidden)
	huma.Register(api, createGuildOp,
		func(ctx context.Context, in *struct {
			Body struct {
				Name string `json:"name" minLength:"2" maxLength:"100"`
			}
		}) (*DetailOutput, error) {
			d, err := h.svc.Create(ctx, h.userID(ctx), in.Body.Name)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &DetailOutput{Body: d.Payload()}, nil
		})

	huma.Register(api, op("listGuilds", http.MethodGet, "/api/guilds", "Servidores do usuário, com canais, cargos e minhas permissões", 0),
		func(ctx context.Context, _ *struct{}) (*DetailListOutput, error) {
			ds, err := h.svc.List(ctx, h.userID(ctx))
			if err != nil {
				return nil, httpx.Err(err)
			}
			out := &DetailListOutput{Body: make([]DetailPayload, len(ds))}
			for i, d := range ds {
				out.Body[i] = d.Payload()
			}
			return out, nil
		})

	huma.Register(api, op("getGuild", http.MethodGet, "/api/guilds/{guild_id}", "Servidor completo: canais ordenados, cargos e minhas permissões", 0, notFound),
		func(ctx context.Context, in *struct{ GuildPath }) (*DetailOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			d, err := h.svc.Get(ctx, h.userID(ctx), gid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &DetailOutput{Body: d.Payload()}, nil
		})

	huma.Register(api, op("updateGuild", http.MethodPatch, "/api/guilds/{guild_id}", "Renomeia o servidor, troca o ícone e configura as mensagens de entrada (MANAGE_GUILD)", 0, notFound, forbidden, invalid),
		func(ctx context.Context, in *struct {
			GuildPath
			Body struct {
				Name              *string `json:"name,omitempty" minLength:"2" maxLength:"100"`
				IconKey           *string `json:"icon_key,omitempty" maxLength:"200" doc:"Chave devolvida por /guilds/{guild_id}/icon; vazio remove o ícone"`
				SystemChannelID   *string `json:"system_channel_id,omitempty" maxLength:"20" doc:"Canal de texto das mensagens de entrada; vazio volta ao padrão (o primeiro canal de texto)"`
				SystemJoinEnabled *bool   `json:"system_join_enabled,omitempty" doc:"Liga ou desliga as mensagens de boas-vindas"`
			}
		}) (*GuildOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			up := UpdateParams{Name: in.Body.Name, IconKey: in.Body.IconKey, SystemJoinEnabled: in.Body.SystemJoinEnabled}
			if in.Body.SystemChannelID != nil {
				var cid int64
				if *in.Body.SystemChannelID != "" {
					if cid, ok = httpx.ParseID(*in.Body.SystemChannelID); !ok {
						return nil, huma.Error422UnprocessableEntity("system_channel_id inválido")
					}
				}
				up.SystemChannelID = &cid
			}
			g, err := h.svc.Update(ctx, h.userID(ctx), gid, up)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &GuildOutput{Body: g.Payload(h.svc.iconURL(ctx, g))}, nil
		})

	huma.Register(api, op("requestGuildIconUpload", http.MethodPost, "/api/guilds/{guild_id}/icon", "Gera URL pré-assinada para enviar o ícone do servidor", 0, notFound, forbidden, invalid),
		func(ctx context.Context, in *struct {
			GuildPath
			Body struct {
				ContentType string `json:"content_type" enum:"image/png,image/jpeg,image/webp"`
				Size        int64  `json:"size" minimum:"1" maximum:"5242880" doc:"Tamanho em bytes (máx. 5 MB)"`
			}
		}) (*struct {
			Body struct {
				UploadURL string `json:"upload_url" doc:"URL pré-assinada para PUT; envie o Content-Type e o tamanho declarados"`
				Key       string `json:"key"`
			}
		}, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			up, err := h.svc.RequestIconUpload(ctx, h.userID(ctx), gid, in.Body.ContentType, in.Body.Size)
			if err != nil {
				return nil, httpx.Err(err)
			}
			out := &struct {
				Body struct {
					UploadURL string `json:"upload_url" doc:"URL pré-assinada para PUT; envie o Content-Type e o tamanho declarados"`
					Key       string `json:"key"`
				}
			}{}
			out.Body.UploadURL, out.Body.Key = up.URL, up.Key
			return out, nil
		})

	deleteOp := op("deleteGuild", http.MethodDelete, "/api/guilds/{guild_id}", "Exclui o servidor (só o dono; exige a senha confirmada nos últimos 10 min)", http.StatusNoContent, notFound, forbidden)
	transferOp := op("transferGuild", http.MethodPost, "/api/guilds/{guild_id}/transfer", "Transfere a posse para outro membro (só o dono; exige a senha confirmada nos últimos 10 min)", 0, notFound, forbidden, invalid)
	if h.sensitive != nil {
		deleteOp.Middlewares, transferOp.Middlewares = h.sensitive, h.sensitive
		deleteOp.Description = "Sem confirmação de senha recente responde 403 com `code: \"password_confirmation_required\"`; confirme em POST /api/auth/confirm-password e repita."
		transferOp.Description = deleteOp.Description
	}
	huma.Register(api, deleteOp,
		func(ctx context.Context, in *struct{ GuildPath }) (*struct{}, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			return nil, httpx.Err(h.svc.Delete(ctx, h.userID(ctx), gid))
		})

	huma.Register(api, transferOp,
		func(ctx context.Context, in *struct {
			GuildPath
			Body struct {
				UserID string `json:"user_id" doc:"Novo dono; precisa ser membro"`
			}
		}) (*GuildOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			uid, ok := httpx.ParseID(in.Body.UserID)
			if !ok {
				return nil, huma.Error422UnprocessableEntity("user_id inválido")
			}
			g, err := h.svc.Transfer(ctx, h.userID(ctx), gid, uid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &GuildOutput{Body: g.Payload(h.svc.iconURL(ctx, g))}, nil
		})

	huma.Register(api, op("listGuildMembers", http.MethodGet, "/api/guilds/{guild_id}/members", "Membros do servidor, por ordem de ID (cursor `after`)", 0, notFound),
		func(ctx context.Context, in *struct {
			GuildPath
			After string `query:"after" doc:"ID do último membro recebido"`
			Limit int    `query:"limit" minimum:"1" maximum:"1000" default:"100"`
		}) (*MemberListOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			var after int64
			if in.After != "" {
				if after, ok = httpx.ParseID(in.After); !ok {
					return nil, huma.Error422UnprocessableEntity("after inválido")
				}
			}
			ms, err := h.svc.Members(ctx, h.userID(ctx), gid, after, in.Limit+1)
			if err != nil {
				return nil, httpx.Err(err)
			}
			out := &MemberListOutput{}
			if len(ms) > in.Limit {
				ms, out.Body.HasMore = ms[:in.Limit], true
			}
			out.Body.Members = make([]MemberPayload, len(ms))
			for i, m := range ms {
				out.Body.Members[i] = m.Payload()
			}
			return out, nil
		})

	huma.Register(api, op("removeGuildMember", http.MethodDelete, "/api/guilds/{guild_id}/members/{user_id}", "Expulsa um membro (KICK_MEMBERS + hierarquia); `@me` sai do servidor", http.StatusNoContent, notFound, forbidden, conflict),
		func(ctx context.Context, in *struct{ MemberPath }) (*struct{}, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			uid, ok := h.parseUser(ctx, in.UserID)
			if !ok {
				return nil, httpx.BadID("membro")
			}
			return nil, httpx.Err(h.svc.Kick(ctx, h.userID(ctx), gid, uid))
		})

	tooMany := http.StatusTooManyRequests
	huma.Register(api, op("banGuildMember", http.MethodPut, "/api/guilds/{guild_id}/bans/{user_id}", "Bane um usuário, membro ou não (BAN_MEMBERS + hierarquia); remove o membro e bloqueia a volta por convite", http.StatusNoContent, notFound, forbidden, invalid, tooMany),
		func(ctx context.Context, in *struct {
			MemberPath
			Body struct {
				Reason string `json:"reason,omitempty" maxLength:"512" doc:"Motivo (opcional)"`
			}
		}) (*struct{}, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			uid, ok := httpx.ParseID(in.UserID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			return nil, httpx.Err(h.svc.Ban(ctx, h.userID(ctx), gid, uid, in.Body.Reason))
		})

	huma.Register(api, op("unbanGuildMember", http.MethodDelete, "/api/guilds/{guild_id}/bans/{user_id}", "Desbane um usuário (BAN_MEMBERS)", http.StatusNoContent, notFound, forbidden, tooMany),
		func(ctx context.Context, in *struct{ MemberPath }) (*struct{}, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			uid, ok := httpx.ParseID(in.UserID)
			if !ok {
				return nil, httpx.BadID("usuário")
			}
			return nil, httpx.Err(h.svc.Unban(ctx, h.userID(ctx), gid, uid))
		})

	huma.Register(api, op("listGuildBans", http.MethodGet, "/api/guilds/{guild_id}/bans", "Banimentos do servidor, por ID de usuário (cursor `after`); exige BAN_MEMBERS", 0, notFound, forbidden),
		func(ctx context.Context, in *struct {
			GuildPath
			After string `query:"after" doc:"ID do último usuário recebido"`
			Limit int    `query:"limit" minimum:"1" maximum:"1000" default:"100"`
		}) (*BanListOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			var after int64
			if in.After != "" {
				if after, ok = httpx.ParseID(in.After); !ok {
					return nil, huma.Error422UnprocessableEntity("after inválido")
				}
			}
			bans, err := h.svc.Bans(ctx, h.userID(ctx), gid, after, in.Limit+1)
			if err != nil {
				return nil, httpx.Err(err)
			}
			out := &BanListOutput{}
			if len(bans) > in.Limit {
				bans, out.Body.HasMore = bans[:in.Limit], true
			}
			out.Body.Bans = make([]BanPayload, len(bans))
			for i, b := range bans {
				out.Body.Bans[i] = b.Payload()
			}
			return out, nil
		})

	huma.Register(api, op("setGuildMemberNickname", http.MethodPatch, "/api/guilds/{guild_id}/members/{user_id}/nick", "Muda o apelido no servidor (`@me` = o seu: CHANGE_NICKNAME; de outro: MANAGE_NICKNAMES + hierarquia). Vazio ou nulo remove", 0, notFound, forbidden, invalid, tooMany),
		func(ctx context.Context, in *struct {
			MemberPath
			Body struct {
				Nick *string `json:"nick" maxLength:"128" nullable:"true" doc:"Apelido de 1 a 32 caracteres; nulo ou vazio remove"`
			}
		}) (*MemberOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			uid, ok := h.parseUser(ctx, in.UserID)
			if !ok {
				return nil, httpx.BadID("membro")
			}
			nick := ""
			if in.Body.Nick != nil {
				nick = *in.Body.Nick
			}
			m, err := h.svc.SetNickname(ctx, h.userID(ctx), gid, uid, nick)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &MemberOutput{Body: m.Payload()}, nil
		})

	huma.Register(api, op("muteGuildMemberVoice", http.MethodPut, "/api/guilds/{guild_id}/members/{user_id}/voice-mute", "Muta o membro na voz pelo servidor (MUTE_MEMBERS + hierarquia); persiste até desmutar", 0, notFound, forbidden, invalid, tooMany),
		func(ctx context.Context, in *struct{ MemberPath }) (*MemberOutput, error) {
			return h.voiceMute(ctx, in.GuildID, in.UserID, true)
		})

	huma.Register(api, op("unmuteGuildMemberVoice", http.MethodDelete, "/api/guilds/{guild_id}/members/{user_id}/voice-mute", "Remove o mute de voz imposto pelo servidor", 0, notFound, forbidden, invalid, tooMany),
		func(ctx context.Context, in *struct{ MemberPath }) (*MemberOutput, error) {
			return h.voiceMute(ctx, in.GuildID, in.UserID, false)
		})

	huma.Register(api, op("listGuildRoles", http.MethodGet, "/api/guilds/{guild_id}/roles", "Cargos do servidor, do mais alto ao mais baixo", 0, notFound),
		func(ctx context.Context, in *struct{ GuildPath }) (*RoleListOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			rs, err := h.svc.Roles(ctx, h.userID(ctx), gid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &RoleListOutput{Body: RolePayloads(rs)}, nil
		})

	huma.Register(api, op("createGuildRole", http.MethodPost, "/api/guilds/{guild_id}/roles", "Cria um cargo (MANAGE_ROLES + hierarquia)", http.StatusCreated, notFound, forbidden, invalid),
		func(ctx context.Context, in *struct {
			GuildPath
			Body struct {
				Name        string `json:"name" minLength:"1" maxLength:"100"`
				Color       *int32 `json:"color,omitempty" minimum:"0" maximum:"16777215"`
				Position    *int32 `json:"position,omitempty" minimum:"1" doc:"Padrão: 1 (logo acima do @everyone)"`
				Permissions *int64 `json:"permissions,omitempty" minimum:"0" doc:"Bitflags; padrão 0"`
				Mentionable *bool  `json:"mentionable,omitempty" doc:"Qualquer pessoa com acesso ao canal pode mencionar o cargo; padrão false"`
			}
		}) (*RoleOutput, error) {
			gid, ok := httpx.ParseID(in.GuildID)
			if !ok {
				return nil, httpx.BadID("servidor")
			}
			p := RoleParams{Name: &in.Body.Name, Color: in.Body.Color, Position: in.Body.Position, Permissions: permPtr(in.Body.Permissions), Mentionable: in.Body.Mentionable}
			r, err := h.svc.CreateRole(ctx, h.userID(ctx), gid, p)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &RoleOutput{Body: r.Payload()}, nil
		})

	huma.Register(api, op("updateGuildRole", http.MethodPatch, "/api/guilds/{guild_id}/roles/{role_id}", "Edita um cargo (MANAGE_ROLES + hierarquia); no @everyone só as permissões", 0, notFound, forbidden, invalid),
		func(ctx context.Context, in *struct {
			RolePath
			Body struct {
				Name        *string `json:"name,omitempty" minLength:"1" maxLength:"100"`
				Color       *int32  `json:"color,omitempty" minimum:"0" maximum:"16777215"`
				RemoveColor bool    `json:"remove_color,omitempty"`
				Position    *int32  `json:"position,omitempty" minimum:"1"`
				Permissions *int64  `json:"permissions,omitempty" minimum:"0"`
				Mentionable *bool   `json:"mentionable,omitempty" doc:"Qualquer pessoa com acesso ao canal pode mencionar o cargo"`
			}
		}) (*RoleOutput, error) {
			gid, rid, err := h.ids(in.GuildID, in.RoleID)
			if err != nil {
				return nil, err
			}
			p := RoleParams{Name: in.Body.Name, Color: in.Body.Color, Position: in.Body.Position, Permissions: permPtr(in.Body.Permissions), Mentionable: in.Body.Mentionable}
			if in.Body.RemoveColor {
				m := int32(-1)
				p.Color = &m
			}
			r, uerr := h.svc.UpdateRole(ctx, h.userID(ctx), gid, rid, p)
			if uerr != nil {
				return nil, httpx.Err(uerr)
			}
			return &RoleOutput{Body: r.Payload()}, nil
		})

	huma.Register(api, op("deleteGuildRole", http.MethodDelete, "/api/guilds/{guild_id}/roles/{role_id}", "Exclui um cargo (o @everyone não pode ser excluído)", http.StatusNoContent, notFound, forbidden, invalid),
		func(ctx context.Context, in *struct{ RolePath }) (*struct{}, error) {
			gid, rid, err := h.ids(in.GuildID, in.RoleID)
			if err != nil {
				return nil, err
			}
			return nil, httpx.Err(h.svc.DeleteRole(ctx, h.userID(ctx), gid, rid))
		})

	huma.Register(api, op("addGuildMemberRole", http.MethodPut, "/api/guilds/{guild_id}/members/{user_id}/roles/{role_id}", "Atribui um cargo a um membro", 0, notFound, forbidden, invalid),
		func(ctx context.Context, in *struct{ MemberRolePath }) (*MemberOutput, error) {
			return h.memberRole(ctx, in.GuildID, in.UserID, in.RoleID, true)
		})

	huma.Register(api, op("removeGuildMemberRole", http.MethodDelete, "/api/guilds/{guild_id}/members/{user_id}/roles/{role_id}", "Remove um cargo de um membro", 0, notFound, forbidden, invalid),
		func(ctx context.Context, in *struct{ MemberRolePath }) (*MemberOutput, error) {
			return h.memberRole(ctx, in.GuildID, in.UserID, in.RoleID, false)
		})
}

func (h *Handler) voiceMute(ctx context.Context, guild, user string, muted bool) (*MemberOutput, error) {
	gid, ok := httpx.ParseID(guild)
	if !ok {
		return nil, httpx.BadID("servidor")
	}
	uid, ok := httpx.ParseID(user)
	if !ok {
		return nil, httpx.BadID("membro")
	}
	m, err := h.svc.SetVoiceMuted(ctx, h.userID(ctx), gid, uid, muted)
	if err != nil {
		return nil, httpx.Err(err)
	}
	return &MemberOutput{Body: m.Payload()}, nil
}

func (h *Handler) ids(guild, role string) (int64, int64, error) {
	gid, ok := httpx.ParseID(guild)
	if !ok {
		return 0, 0, httpx.BadID("servidor")
	}
	rid, ok := httpx.ParseID(role)
	if !ok {
		return 0, 0, httpx.BadID("cargo")
	}
	return gid, rid, nil
}

func (h *Handler) memberRole(ctx context.Context, guild, user, role string, add bool) (*MemberOutput, error) {
	gid, rid, err := h.ids(guild, role)
	if err != nil {
		return nil, err
	}
	uid, ok := h.parseUser(ctx, user)
	if !ok {
		return nil, httpx.BadID("membro")
	}
	var m Member
	if add {
		m, err = h.svc.AddMemberRole(ctx, h.userID(ctx), gid, uid, rid)
	} else {
		m, err = h.svc.RemoveMemberRole(ctx, h.userID(ctx), gid, uid, rid)
	}
	if err != nil {
		return nil, httpx.Err(err)
	}
	return &MemberOutput{Body: m.Payload()}, nil
}

func permPtr(v *int64) *perm.Perm {
	if v == nil {
		return nil
	}
	p := perm.Perm(*v)
	return &p
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
