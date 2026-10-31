// Package guild cuida de servidores, membros e cargos (RF02 e RF04) e das regras de permissão
// aplicadas pelos demais pacotes (via Service.Member).
package guild

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// MaxGuildsPerUser é o limite de servidores por usuário (SPEC 7.1).
const MaxGuildsPerUser = 100

var (
	ErrNotFound          = apperr.NotFound("servidor não encontrado")
	ErrMemberNotFound    = apperr.NotFound("membro não encontrado")
	ErrRoleNotFound      = apperr.NotFound("cargo não encontrado")
	ErrForbidden         = apperr.Forbidden("você não tem permissão para isso neste servidor")
	ErrTooManyGuilds     = apperr.Conflict("limite de 100 servidores por usuário atingido")
	ErrOwnerCannotLeave  = apperr.Conflict("o dono não pode sair do servidor: transfira a posse antes (ou exclua o servidor)")
	ErrEveryoneImmutable = apperr.Invalid("o cargo @everyone não pode ser excluído, renomeado nem mudar de posição")
)

type Guild struct {
	ID        int64
	Name      string
	IconKey   *string
	OwnerID   int64
	CreatedAt time.Time
}

type Role struct {
	ID          int64
	GuildID     int64
	Name        string
	Color       *int32
	Position    int32
	Permissions perm.Perm
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
	RoleIDs     []int64 // sem o @everyone, que todos têm
}

// Access são os dados brutos de permissão de um membro, como o banco os entrega.
type Access struct {
	OwnerID int64
	Perms   perm.Perm // OR do @everyone e dos cargos do membro
	Highest int       // posição do cargo mais alto
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
}

type RolePayload struct {
	ID          string `json:"id"`
	GuildID     string `json:"guild_id"`
	Name        string `json:"name"`
	Color       *int32 `json:"color" doc:"RGB (0..16777215) ou null"`
	Position    int32  `json:"position" doc:"Maior = mais alto na hierarquia; @everyone é 0"`
	Permissions int64  `json:"permissions" doc:"Bitflags (SPEC 7.2)"`
	IsEveryone  bool   `json:"is_everyone"`
}

type MemberPayload struct {
	GuildID     string    `json:"guild_id"`
	UserID      string    `json:"user_id"`
	Nickname    *string   `json:"nickname"`
	JoinedAt    time.Time `json:"joined_at"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name,omitempty"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	RoleIDs     []string  `json:"role_ids" doc:"Cargos do membro, sem o @everyone"`
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
		Position: r.Position, Permissions: int64(r.Permissions), IsEveryone: r.IsEveryone(),
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
		Username: m.Username, AvatarURL: m.AvatarURL, RoleIDs: httpx.IDs(m.RoleIDs),
	}
	if m.DisplayName != nil {
		p.DisplayName = *m.DisplayName
	}
	return p
}

func (g Guild) Payload(iconURL string) GuildPayload {
	return GuildPayload{
		ID: httpx.ID(g.ID), Name: g.Name, IconKey: g.IconKey, IconURL: iconURL,
		OwnerID: httpx.ID(g.OwnerID), CreatedAt: g.CreatedAt,
	}
}

func (d Detail) Payload() DetailPayload {
	return DetailPayload{
		GuildPayload: d.Guild.Payload(d.IconURL), Roles: RolePayloads(d.Roles), Channels: channel.Payloads(d.Channels),
		Permissions: int64(d.Member.Perms), IsOwner: d.Member.IsOwner, MyRoleIDs: httpx.IDs(d.MyRoleIDs),
	}
}
