// Package guild cuida de servidores, membros e cargos (RF02 e RF04) e das regras de permissão
// aplicadas pelos demais pacotes (via Service.Member).
package guild

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/limits"
)

// TooManyGuilds, TooManyRoles e TooManyMembers devolvem o 409 do limite configurado n (o erro sentinela quando
// n é o padrão do SPEC, para quem compara com errors.Is).
func TooManyGuilds(n int) error {
	if n == limits.DefaultGuildsPerUser {
		return ErrTooManyGuilds
	}
	return apperr.Conflict(limits.GuildsPerUserMsg(n))
}

func TooManyRoles(n int) error {
	if n == limits.DefaultRolesPerGuild {
		return ErrTooManyRoles
	}
	return apperr.Conflict(limits.RolesPerGuildMsg(n))
}

func TooManyMembers(n int) error {
	if n == limits.DefaultMembersPerGuild {
		return ErrTooManyMembers
	}
	return apperr.Conflict(limits.MembersPerGuildMsg(n))
}

var (
	ErrNotFound          = apperr.NotFound("servidor não encontrado")
	ErrMemberNotFound    = apperr.NotFound("membro não encontrado")
	ErrRoleNotFound      = apperr.NotFound("cargo não encontrado")
	ErrForbidden         = apperr.Forbidden("você não tem permissão para isso neste servidor")
	ErrTooManyGuilds     = apperr.Conflict(limits.GuildsPerUserMsg(limits.DefaultGuildsPerUser))
	ErrTooManyRoles      = apperr.Conflict(limits.RolesPerGuildMsg(limits.DefaultRolesPerGuild))
	ErrTooManyMembers    = apperr.Conflict(limits.MembersPerGuildMsg(limits.DefaultMembersPerGuild))
	ErrOwnerCannotLeave  = apperr.Conflict("o dono não pode sair do servidor: transfira a posse antes (ou exclua o servidor)")
	ErrEveryoneImmutable = apperr.Invalid("o cargo @everyone não pode ser excluído, renomeado nem mudar de posição")
	ErrBanned            = apperr.Forbidden("você foi banido deste servidor")
	ErrBanNotFound       = apperr.NotFound("esta pessoa não está banida")
	ErrSelfModeration    = apperr.Invalid("você não pode fazer isso consigo mesmo")
)

// Limites da moderação (SPEC 7.x).
const (
	MaxBanReasonRunes = 512
	MaxNickRunes      = 32
)

type Guild struct {
	ID        int64
	Name      string
	IconKey   *string
	OwnerID   int64
	CreatedAt time.Time
	// SystemChannelID é o canal das mensagens de entrada (nil = o primeiro canal de texto);
	// SystemJoinEnabled liga ou desliga as mensagens de boas-vindas.
	SystemChannelID   *int64
	SystemJoinEnabled bool
}

type Role struct {
	ID          int64
	GuildID     int64
	Name        string
	Color       *int32
	Position    int32
	Permissions perm.Perm
	// Mentionable: qualquer pessoa com acesso ao canal pode mencionar o cargo (@NomeDoCargo).
	Mentionable bool
}

// IsEveryone diz se é o cargo @everyone (id = guild_id).
func (r Role) IsEveryone() bool { return r.ID == r.GuildID }

type Member struct {
	GuildID     int64
	UserID      int64
	Nickname    *string
	JoinedAt    time.Time
	Username    string
	DisplayName *string
	AvatarKey   *string
	AvatarURL   string
	Bio         *string
	Pronouns    *string
	BannerKey   *string
	BannerURL   string
	BannerColor *int32
	RoleIDs     []int64 // sem o @everyone, que todos têm
	VoiceMuted  bool    // mutado na voz por um moderador (persistente)
}

// Access são os dados brutos de permissão de um membro, como o banco os entrega.
type Access struct {
	OwnerID int64
	Perms   perm.Perm // OR do @everyone e dos cargos do membro
	Highest int       // posição do cargo mais alto
	RoleIDs []int64   // cargos do membro, sem o @everyone
}

// Ban é um banimento.
type Ban struct {
	GuildID          int64
	UserID           int64
	BannedBy         *int64
	BannedByUsername *string
	Reason           *string
	CreatedAt        time.Time
	Username         string
	DisplayName      *string
	AvatarKey        *string
	AvatarURL        string
}

// BanPayload é um banimento na API.
type BanPayload struct {
	GuildID          string    `json:"guild_id"`
	UserID           string    `json:"user_id"`
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name,omitempty"`
	AvatarURL        string    `json:"avatar_url,omitempty"`
	Reason           *string   `json:"reason"`
	BannedBy         *string   `json:"banned_by" doc:"Quem baniu; nulo se a conta foi excluída"`
	BannedByUsername *string   `json:"banned_by_username"`
	CreatedAt        time.Time `json:"created_at"`
}

func (b Ban) Payload() BanPayload {
	p := BanPayload{
		GuildID: httpx.ID(b.GuildID), UserID: httpx.ID(b.UserID), Username: b.Username, AvatarURL: b.AvatarURL,
		Reason: b.Reason, BannedBy: httpx.IDPtr(b.BannedBy), BannedByUsername: b.BannedByUsername, CreatedAt: b.CreatedAt,
	}
	if b.DisplayName != nil {
		p.DisplayName = *b.DisplayName
	}
	return p
}

// Detail é o servidor completo para montar a tela do cliente.
type Detail struct {
	Guild     Guild
	IconURL   string
	Roles     []Role
	Channels  []channel.Channel
	Member    perm.Member
	MyRoleIDs []int64
}

// ---- Payloads (API e eventos; JSON snake_case estável) ----

type GuildPayload struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	IconKey   *string   `json:"icon_key"`
	IconURL   string    `json:"icon_url,omitempty" doc:"URL temporária de leitura do ícone"`
	OwnerID   string    `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
	// Canal e interruptor das mensagens de entrada (Configurações do servidor).
	SystemChannelID   *string `json:"system_channel_id" doc:"Canal das mensagens de entrada; null = o primeiro canal de texto"`
	SystemJoinEnabled bool    `json:"system_join_enabled" doc:"Mensagens de boas-vindas ligadas"`
}

type RolePayload struct {
	ID          string `json:"id"`
	GuildID     string `json:"guild_id"`
	Name        string `json:"name"`
	Color       *int32 `json:"color" doc:"RGB (0..16777215) ou null"`
	Position    int32  `json:"position" doc:"Maior = mais alto na hierarquia; @everyone é 0"`
	Permissions int64  `json:"permissions" doc:"Bitflags (SPEC 7.2)"`
	IsEveryone  bool   `json:"is_everyone"`
	Mentionable bool   `json:"mentionable" doc:"Qualquer pessoa com acesso ao canal pode mencionar o cargo (@NomeDoCargo)"`
}

type MemberPayload struct {
	GuildID     string    `json:"guild_id"`
	UserID      string    `json:"user_id"`
	Nickname    *string   `json:"nickname"`
	JoinedAt    time.Time `json:"joined_at"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name,omitempty"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	Bio         string    `json:"bio,omitempty" doc:"Sobre mim (até 190 caracteres)"`
	Pronouns    string    `json:"pronouns,omitempty" doc:"Pronomes (até 40 caracteres)"`
	BannerURL   string    `json:"banner_url,omitempty" doc:"URL temporária de leitura do banner"`
	BannerColor *int32    `json:"banner_color,omitempty" doc:"Cor sólida do banner (RGB 0..16777215), usada quando não há imagem"`
	RoleIDs     []string  `json:"role_ids" doc:"Cargos do membro, sem o @everyone"`
	VoiceMuted  bool      `json:"voice_muted,omitempty" doc:"Mutado na voz por um moderador (MUTE_MEMBERS)"`
}

// DetailPayload é o servidor completo; também é o dado do evento GUILD_CREATE.
type DetailPayload struct {
	GuildPayload
	Roles       []RolePayload            `json:"roles" doc:"Do mais alto para o mais baixo"`
	Channels    []channel.ChannelPayload `json:"channels" doc:"Ordenados por posição"`
	Permissions int64                    `json:"permissions" doc:"Minhas permissões efetivas (bitflags)"`
	IsOwner     bool                     `json:"is_owner"`
	MyRoleIDs   []string                 `json:"my_role_ids"`
}

// Dados dos eventos que não reaproveitam os payloads acima.
type GuildDeletePayload struct {
	ID string `json:"id"`
}

type MemberRemovePayload struct {
	GuildID string `json:"guild_id"`
	UserID  string `json:"user_id"`
}

type RoleDeletePayload struct {
	GuildID string `json:"guild_id"`
	RoleID  string `json:"role_id"`
}

func (r Role) Payload() RolePayload {
	return RolePayload{
		ID: httpx.ID(r.ID), GuildID: httpx.ID(r.GuildID), Name: r.Name, Color: r.Color,
		Position: r.Position, Permissions: int64(r.Permissions), IsEveryone: r.IsEveryone(), Mentionable: r.Mentionable,
	}
}

func RolePayloads(rs []Role) []RolePayload {
	out := make([]RolePayload, len(rs))
	for i, r := range rs {
		out[i] = r.Payload()
	}
	return out
}

func (m Member) Payload() MemberPayload {
	p := MemberPayload{
		GuildID: httpx.ID(m.GuildID), UserID: httpx.ID(m.UserID), Nickname: m.Nickname, JoinedAt: m.JoinedAt,
		Username: m.Username, AvatarURL: m.AvatarURL, RoleIDs: httpx.IDs(m.RoleIDs), VoiceMuted: m.VoiceMuted,
	}
	if m.DisplayName != nil {
		p.DisplayName = *m.DisplayName
	}
	if m.Bio != nil {
		p.Bio = *m.Bio
	}
	if m.Pronouns != nil {
		p.Pronouns = *m.Pronouns
	}
	p.BannerURL, p.BannerColor = m.BannerURL, m.BannerColor
	return p
}

func (g Guild) Payload(iconURL string) GuildPayload {
	return GuildPayload{
		ID: httpx.ID(g.ID), Name: g.Name, IconKey: g.IconKey, IconURL: iconURL,
		OwnerID: httpx.ID(g.OwnerID), CreatedAt: g.CreatedAt,
		SystemChannelID: httpx.IDPtr(g.SystemChannelID), SystemJoinEnabled: g.SystemJoinEnabled,
	}
}

func (d Detail) Payload() DetailPayload {
	return DetailPayload{
		GuildPayload: d.Guild.Payload(d.IconURL), Roles: RolePayloads(d.Roles), Channels: channel.Payloads(d.Channels),
		Permissions: int64(d.Member.Perms), IsOwner: d.Member.IsOwner, MyRoleIDs: httpx.IDs(d.MyRoleIDs),
	}
}
