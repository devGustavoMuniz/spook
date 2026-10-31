// Package message cuida das mensagens de texto dos canais de servidor (RF06).
package message

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/snowflake"
)

const (
	MaxContentRunes = 2000
	DefaultPageSize = 50
	MaxPageSize     = 100
)

var (
	ErrNotFound  = apperr.NotFound("mensagem não encontrada")
	ErrForbidden = apperr.Forbidden("você não tem permissão para isso nesta mensagem")
)

type Author struct {
	ID          int64
	Username    string
	DisplayName *string
	AvatarKey   *string
	AvatarURL   string
}

type Message struct {
	ID        int64
	ChannelID int64
	Author    Author
	Content   string
	EditedAt  *time.Time
}

type AuthorPayload struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

// MessagePayload é a mensagem na API e nos eventos MESSAGE_CREATE e MESSAGE_UPDATE.
type MessagePayload struct {
	ID        string        `json:"id"`
	ChannelID string        `json:"channel_id"`
	Author    AuthorPayload `json:"author"`
	Content   string        `json:"content"`
	EditedAt  *time.Time    `json:"edited_at"`
	CreatedAt time.Time     `json:"created_at" doc:"Derivado do ID Snowflake"`
}

// DeletePayload é o dado do evento MESSAGE_DELETE.
type DeletePayload struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	GuildID   string `json:"guild_id"`
}

func (m Message) Payload() MessagePayload {
	a := AuthorPayload{ID: httpx.ID(m.Author.ID), Username: m.Author.Username, AvatarURL: m.Author.AvatarURL}
	if m.Author.DisplayName != nil {
		a.DisplayName = *m.Author.DisplayName
	}
	return MessagePayload{
		ID: httpx.ID(m.ID), ChannelID: httpx.ID(m.ChannelID), Author: a, Content: m.Content,
		EditedAt: m.EditedAt, CreatedAt: snowflake.Time(m.ID),
	}
}
