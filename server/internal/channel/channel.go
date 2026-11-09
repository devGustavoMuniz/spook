// Package channel cuida dos canais de servidor: texto, voz e categorias (RF05). Os canais de DM
// (tipos 3 e 4) são criados e geridos pelo pacote dm; aqui só entram a autorização de acesso
// (Service.Authorize, usada pelas mensagens) e o formato do payload, que é o mesmo.
package channel

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
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

// MaxTopicRunes é o tamanho máximo do tópico de um canal.
const MaxTopicRunes = 1024

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
	// Topic é o tópico do canal de texto (até MaxTopicRunes caracteres); nil = sem tópico.
	Topic *string

	// Só em DMs: o dono da DM em grupo e os participantes (todos, inclusive quem consulta).
	OwnerID    *int64
	Recipients []Recipient
}

// IsDM diz se é uma DM 1:1 ou em grupo.
func (c Channel) IsDM() bool { return c.Type == TypeDM || c.Type == TypeGroupDM }

// Recipient é um participante de DM.
type Recipient struct {
	ID          int64
	Username    string
	DisplayName *string
	AvatarKey   *string
	AvatarURL   string
	Plan        string // free, nitro ou nitro_plus
}

// RecipientPayload é o participante nos payloads de DM.
type RecipientPayload struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	Plan        string `json:"plan,omitempty" enum:"free,nitro,nitro_plus" doc:"Plano (Grátis, Nitro ou Nitro+). Ausente = free"`
}

func (r Recipient) Payload() RecipientPayload {
	p := RecipientPayload{ID: httpx.ID(r.ID), Username: r.Username, AvatarURL: r.AvatarURL, Plan: plan.Omit(r.Plan)}
	if r.DisplayName != nil {
		p.DisplayName = *r.DisplayName
	}
	return p
}

// ChannelPayload é o canal na API e nos eventos CHANNEL_*.
type ChannelPayload struct {
	ID            string    `json:"id"`
	Type          int       `json:"type" doc:"0 texto, 1 voz, 2 categoria, 3 DM, 4 DM em grupo"`
	GuildID       *string   `json:"guild_id"`
	ParentID      *string   `json:"parent_id" doc:"Categoria que contém o canal"`
	Name          string    `json:"name"`
	Position      int32     `json:"position"`
	LastMessageID *string   `json:"last_message_id"`
	CreatedAt     time.Time `json:"created_at"`
	Topic         *string   `json:"topic" doc:"Tópico do canal de texto (até 1024 caracteres); null = sem tópico"`
	// Só em DMs (omitidos nos canais de servidor).
	OwnerID    *string            `json:"owner_id,omitempty" doc:"Dono da DM em grupo"`
	Recipients []RecipientPayload `json:"recipients,omitempty" doc:"Participantes da DM (todos, inclusive você)"`
}

func (c Channel) Payload() ChannelPayload {
	p := ChannelPayload{
		ID: httpx.ID(c.ID), Type: int(c.Type), GuildID: httpx.IDPtr(c.GuildID), ParentID: httpx.IDPtr(c.ParentID),
		Name: c.Name, Position: c.Position, LastMessageID: httpx.IDPtr(c.LastMessageID), CreatedAt: c.CreatedAt, Topic: c.Topic,
	}
	if c.IsDM() {
		p.OwnerID = httpx.IDPtr(c.OwnerID)
		p.Recipients = make([]RecipientPayload, len(c.Recipients))
		for i, r := range c.Recipients {
			p.Recipients[i] = r.Payload()
		}
	}
	return p
}

func Payloads(cs []Channel) []ChannelPayload {
	out := make([]ChannelPayload, len(cs))
	for i, c := range cs {
		out[i] = c.Payload()
	}
	return out
}
