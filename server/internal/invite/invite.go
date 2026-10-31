// Package invite cuida dos convites de servidor (RF03, SPEC 7.5).
package invite

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

var (
	ErrNotFound  = apperr.NotFound("convite não encontrado")
	ErrGone      = apperr.Gone("este convite expirou ou atingiu o limite de usos")
	ErrForbidden = apperr.Forbidden("você não tem permissão para isso neste servidor")
)

type Invite struct {
	Code      string
	GuildID   int64
	CreatorID int64
	MaxUses   *int32
	Uses      int32
	ExpiresAt *time.Time
	CreatedAt time.Time
}

// Valid diz se o convite ainda pode ser usado em now.
func (i Invite) Valid(now time.Time) bool {
	if i.ExpiresAt != nil && !i.ExpiresAt.After(now) {
		return false
	}
	return i.MaxUses == nil || i.Uses < *i.MaxUses
}

// Preview é o que se mostra antes de entrar.
type Preview struct {
	Invite
	GuildName    string
	GuildIconKey *string
	MemberCount  int64
}

// RedeemResult diz em que servidor o usuário entrou; Joined é falso se ele já era membro (sem consumir uso).
type RedeemResult struct {
	GuildID int64
	Joined  bool
}

type InvitePayload struct {
	Code      string     `json:"code"`
	GuildID   string     `json:"guild_id"`
	CreatorID string     `json:"creator_id"`
	MaxUses   *int32     `json:"max_uses" doc:"null = ilimitado"`
	Uses      int32      `json:"uses"`
	ExpiresAt *time.Time `json:"expires_at" doc:"null = não expira"`
	CreatedAt time.Time  `json:"created_at"`
}

type PreviewPayload struct {
	Code        string     `json:"code"`
	GuildID     string     `json:"guild_id"`
	GuildName   string     `json:"guild_name"`
	GuildIcon   string     `json:"guild_icon_url,omitempty"`
	MemberCount int64      `json:"member_count"`
	MaxUses     *int32     `json:"max_uses"`
	Uses        int32      `json:"uses"`
	ExpiresAt   *time.Time `json:"expires_at"`
}

func (i Invite) Payload() InvitePayload {
	return InvitePayload{
		Code: i.Code, GuildID: httpx.ID(i.GuildID), CreatorID: httpx.ID(i.CreatorID), MaxUses: i.MaxUses,
		Uses: i.Uses, ExpiresAt: i.ExpiresAt, CreatedAt: i.CreatedAt,
	}
}
