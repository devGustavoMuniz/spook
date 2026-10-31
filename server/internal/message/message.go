// Package message cuida das mensagens de texto dos canais de servidor e DMs (RF06 e RF07).
package message

import (
	"reflect"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/snowflake"
)

const (
	MaxContentRunes = 2000
	DefaultPageSize = 50
	// MaxPins é o máximo de mensagens fixadas por canal.
	MaxPins = 50
	// ReplyPreviewRunes é o tamanho máximo (em runes) do trecho da mensagem respondida no payload.
	ReplyPreviewRunes = 100
	MaxPageSize       = 100
)

var (
	ErrNotFound  = apperr.NotFound("mensagem não encontrada")
	ErrForbidden = apperr.Forbidden("você não tem permissão para isso nesta mensagem")

	ErrTooManyAttachments = apperr.Invalid("uma mensagem pode ter no máximo 10 anexos")
	ErrEmptyMessage       = apperr.Invalid("a mensagem não pode ser vazia")

	ErrReplyTarget = apperr.Invalid("a mensagem respondida não existe mais, foi apagada ou é de outro canal")
	ErrTooManyPins = apperr.Conflict("este canal já tem 50 mensagens fixadas; desafixe uma antes de fixar outra")
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
	// MentionIDs são os usuários mencionados (@username) resolvidos no envio.
	MentionIDs []int64
	// ReferenceID é a mensagem respondida (nil = não é resposta); Reply é a prévia montada em lote pelo service.
	ReferenceID *int64
	Reply       *Reply
	// PinnedAt é quando foi fixada (nil = não fixada).
	PinnedAt *time.Time
	// Attachments é preenchido pelo service (com as URLs de leitura) antes de montar o payload.
	Attachments []attachment.AttachmentPayload
}

// Reply é a prévia da mensagem respondida. Deleted = a original foi apagada (sem conteúdo nem anexos).
type Reply struct {
	ID             int64
	Author         Author
	Content        string
	HasAttachments bool
	Deleted        bool
}

// ReplyAuthorPayload é o autor da mensagem respondida (sem avatar: a citação é compacta).
type ReplyAuthorPayload struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
}

// ReplyPreview é a prévia da mensagem respondida (o objeto de MessagePayload.reply_to).
type ReplyPreview struct {
	ID             string             `json:"id"`
	Author         ReplyAuthorPayload `json:"author"`
	Content        string             `json:"content" doc:"Até 100 caracteres (runes); vazio quando deleted"`
	HasAttachments bool               `json:"has_attachments"`
	Deleted        bool               `json:"deleted" doc:"A mensagem original foi apagada (sem conteúdo)"`
}

// ReplyPayload é MessagePayload.reply_to: a prévia ou null quando a mensagem não é uma resposta. O huma
// não gera schema nullable para objetos ($ref); por isso o schema é escrito à mão (oneOf com null).
type ReplyPayload ReplyPreview

// Schema implementa huma.SchemaProvider.
func (ReplyPayload) Schema(r huma.Registry) *huma.Schema {
	return &huma.Schema{
		Description: "Mensagem respondida (null quando não é uma resposta)",
		OneOf:       []*huma.Schema{r.Schema(reflect.TypeFor[ReplyPreview](), true, "ReplyPreview"), {Type: "null"}},
	}
}

func (r Reply) payload() *ReplyPayload {
	p := &ReplyPayload{
		ID: httpx.ID(r.ID), Content: r.Content, HasAttachments: r.HasAttachments, Deleted: r.Deleted,
		Author: ReplyAuthorPayload{ID: httpx.ID(r.Author.ID), Username: r.Author.Username},
	}
	if r.Author.DisplayName != nil {
		p.Author.DisplayName = *r.Author.DisplayName
	}
	return p
}

// truncateRunes corta s em n runes (sem partir um caractere multibyte).
func truncateRunes(s string, n int) string {
	if httpx.Runes(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
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
	// MentionIDs vem sempre ([] sem menções): quem recebeu @username, resolvido no envio entre quem vê o canal.
	MentionIDs []string `json:"mention_ids" nullable:"false" doc:"IDs dos usuários mencionados com @username (só quem vê o canal, no máximo 20)"`
	// ReplyTo é a prévia da mensagem respondida (null = não é resposta).
	ReplyTo *ReplyPayload `json:"reply_to"`
	// Pinned: a mensagem está fixada no canal.
	Pinned bool `json:"pinned" doc:"A mensagem está fixada no canal"`
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
	p := MessagePayload{
		ID: httpx.ID(m.ID), ChannelID: httpx.ID(m.ChannelID), Author: a, Content: m.Content,
		EditedAt: m.EditedAt, CreatedAt: snowflake.Time(m.ID), Attachments: atts, MentionIDs: httpx.IDs(m.MentionIDs),
		Pinned: m.PinnedAt != nil,
	}
	if m.Reply != nil {
		p.ReplyTo = m.Reply.payload()
	} else if m.ReferenceID != nil {
		// Referência sem prévia carregada (não deveria acontecer): o cliente ainda sabe que é uma resposta.
		p.ReplyTo = Reply{ID: *m.ReferenceID, Deleted: true}.payload()
	}
	return p
}
