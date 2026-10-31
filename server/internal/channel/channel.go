// Package channel cuida dos canais de servidor: texto, voz e categorias (RF05).
// Canais de DM (tipos 3 e 4) pertencem à Fase 4.
package channel

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type Type int16

const (
	TypeText     Type = 0
	TypeVoice    Type = 1
	TypeCategory Type = 2
	TypeDM       Type = 3
	TypeGroupDM  Type = 4
)

var (
	ErrNotFound  = apperr.NotFound("canal não encontrado")
	ErrForbidden = apperr.Forbidden("você não tem permissão para isso neste canal")
)

type Channel struct {
	ID            int64
	Type          Type
	GuildID       *int64
	ParentID      *int64
	Name          string
	Position      int32
	LastMessageID *int64
	CreatedAt     time.Time
}

// ChannelPayload é o canal na API e nos eventos CHANNEL_*.
type ChannelPayload struct {
	ID            string    `json:"id"`
	Type          int       `json:"type" doc:"0 texto, 1 voz, 2 categoria"`
	GuildID       *string   `json:"guild_id"`
	ParentID      *string   `json:"parent_id" doc:"Categoria que contém o canal"`
	Name          string    `json:"name"`
	Position      int32     `json:"position"`
	LastMessageID *string   `json:"last_message_id"`
	CreatedAt     time.Time `json:"created_at"`
}

func (c Channel) Payload() ChannelPayload {
	return ChannelPayload{
		ID: httpx.ID(c.ID), Type: int(c.Type), GuildID: httpx.IDPtr(c.GuildID), ParentID: httpx.IDPtr(c.ParentID),
		Name: c.Name, Position: c.Position, LastMessageID: httpx.IDPtr(c.LastMessageID), CreatedAt: c.CreatedAt,
	}
}

func Payloads(cs []Channel) []ChannelPayload {
	out := make([]ChannelPayload, len(cs))
	for i, c := range cs {
		out[i] = c.Payload()
	}
	return out
}
