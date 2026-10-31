// Package message cuida das mensagens de texto dos canais de servidor e DMs (RF06 e RF07).
package message

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/attachment"
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

	ErrTooManyAttachments = apperr.Invalid("uma mensagem pode ter no máximo 10 anexos")
	ErrEmptyMessage       = apperr.Invalid("a mensagem não pode ser vazia")
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
	// Attachments é preenchido pelo service (com as URLs de leitura) antes de montar o payload.
	Attachments []attachment.AttachmentPayload
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
	// Attachments vem sempre (vazio quando não há); thumbnail_url aparece depois por MESSAGE_UPDATE.
	Attachments []attachment.AttachmentPayload `json:"attachments" nullable:"false"`
}

// DeletePayload é o dado do evento MESSAGE_DELETE.
type DeletePayload struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	GuildID   string `json:"guild_id,omitempty" doc:"Omitido em DMs"`
}

func (m Message) Payload() MessagePayload {
	a := AuthorPayload{ID: httpx.ID(m.Author.ID), Username: m.Author.Username, AvatarURL: m.Author.AvatarURL}
	if m.Author.DisplayName != nil {
		a.DisplayName = *m.Author.DisplayName
	}
	atts := m.Attachments
	if atts == nil {
		atts = []attachment.AttachmentPayload{}
	}
	return MessagePayload{
		ID: httpx.ID(m.ID), ChannelID: httpx.ID(m.ChannelID), Author: a, Content: m.Content,
		EditedAt: m.EditedAt, CreatedAt: snowflake.Time(m.ID), Attachments: atts,
	}
}
