package message

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

type ChannelPath struct {
	ChannelID string `path:"channel_id" doc:"ID do canal"`
}

type MessagePath struct {
	ChannelPath
	MessageID string `path:"message_id" doc:"ID da mensagem"`
}

type ContentBody struct {
	Content string `json:"content" minLength:"1" maxLength:"2000" doc:"1 a 2000 caracteres (contados em runes), não só espaços"`
}

// SendBody é o corpo do envio: texto, anexos ou os dois.
type SendBody struct {
	Content       string   `json:"content,omitempty" maxLength:"2000" doc:"Até 2000 caracteres (runes); pode ser vazio se houver anexo"`
	AttachmentIDs []string `json:"attachment_ids,omitempty" doc:"Até 10 IDs de uploads já enviados ao storage (POST /channels/{id}/uploads); só anexos seus, deste canal, ainda sem mensagem e com menos de 1 h"`
	ReplyTo       string   `json:"reply_to,omitempty" doc:"ID da mensagem respondida; precisa existir, não estar apagada e ser deste canal (422 caso contrário)"`
	MentionReply  *bool    `json:"mention_reply,omitempty" doc:"Menciona o autor da mensagem respondida (padrão true): ele recebe contador de menção e push, como um @ direto"`
}

// PinPath identifica a mensagem fixada/desafixada.
type PinPath struct {
	ChannelPath
	MessageID string `path:"message_id" doc:"ID da mensagem"`
}

type PinsOutput struct {
	Body struct {
		Messages []MessagePayload `json:"messages" nullable:"false" doc:"Fixadas (até 50), a mais recentemente fixada primeiro"`
	}
}

type MessageOutput struct{ Body MessagePayload }

type MessageListOutput struct {
	Body struct {
		Messages []MessagePayload `json:"messages" doc:"Da mais nova para a mais antiga"`
		HasMore  bool             `json:"has_more" doc:"Há mensagens mais antigas; use before = id da última"`
	}
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, method, path, summary string, status int, errs ...int) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
			Tags: []string{"messages"}, Security: security, Middlewares: mw,
			Errors: append([]int{http.StatusUnauthorized, http.StatusNotFound}, errs...),
		}
	}
	forbidden, invalid := http.StatusForbidden, http.StatusUnprocessableEntity

	huma.Register(api, op("sendMessage", http.MethodPost, "/api/channels/{channel_id}/messages", "Envia uma mensagem, com ou sem anexos (limite: 5 a cada 5 s por canal)", http.StatusCreated, forbidden, invalid, http.StatusTooManyRequests),
		func(ctx context.Context, in *struct {
			ChannelPath
			Body SendBody
		}) (*MessageOutput, error) {
			cid, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			var attIDs []int64
			for _, raw := range in.Body.AttachmentIDs {
				id, ok := httpx.ParseID(raw)
				if !ok {
					return nil, huma.Error422UnprocessableEntity("attachment_ids inválido")
				}
				attIDs = append(attIDs, id)
			}
			opts := SendOptions{MentionReply: in.Body.MentionReply == nil || *in.Body.MentionReply}
			if in.Body.ReplyTo != "" {
				if opts.ReplyTo, ok = httpx.ParseID(in.Body.ReplyTo); !ok {
					return nil, huma.Error422UnprocessableEntity("reply_to inválido")
				}
			}
			m, err := h.svc.Send(ctx, h.userID(ctx), cid, in.Body.Content, attIDs, opts)
			if err != nil {
				return nil, httpx.Err(err)
			}
			return &MessageOutput{Body: m.Payload()}, nil
		})

	huma.Register(api, op("listPinnedMessages", http.MethodGet, "/api/channels/{channel_id}/pins", "Mensagens fixadas do canal (até 50, a mais recentemente fixada primeiro)", 0, forbidden),
		func(ctx context.Context, in *struct{ ChannelPath }) (*PinsOutput, error) {
			cid, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			ms, err := h.svc.ListPins(ctx, h.userID(ctx), cid)
			if err != nil {
				return nil, httpx.Err(err)
			}
			out := &PinsOutput{}
			out.Body.Messages = make([]MessagePayload, len(ms))
			for i, m := range ms {
				out.Body.Messages[i] = m.Payload()
			}
			return out, nil
		})

	huma.Register(api, op("pinMessage", http.MethodPut, "/api/channels/{channel_id}/pins/{message_id}", "Fixa a mensagem (idempotente; MANAGE_MESSAGES em servidor, qualquer participante em DM; máximo 50 por canal)", http.StatusNoContent, forbidden, http.StatusConflict),
		func(ctx context.Context, in *struct{ PinPath }) (*struct{}, error) {
			cid, mid, err := ids(in.ChannelID, in.MessageID)
			if err != nil {
				return nil, err
			}
			return nil, httpx.Err(h.svc.Pin(ctx, h.userID(ctx), cid, mid))
		})

	huma.Register(api, op("unpinMessage", http.MethodDelete, "/api/channels/{channel_id}/pins/{message_id}", "Desafixa a mensagem (idempotente; mesmas permissões de fixar)", http.StatusNoContent, forbidden),
		func(ctx context.Context, in *struct{ PinPath }) (*struct{}, error) {
			cid, mid, err := ids(in.ChannelID, in.MessageID)
			if err != nil {
				return nil, err
			}
			return nil, httpx.Err(h.svc.Unpin(ctx, h.userID(ctx), cid, mid))
		})

	huma.Register(api, op("listMessages", http.MethodGet, "/api/channels/{channel_id}/messages", "Histórico paginado por cursor, da mais nova para a mais antiga", 0, forbidden, invalid),
		func(ctx context.Context, in *struct {
			ChannelPath
			Before string `query:"before" doc:"Devolve mensagens com ID menor que este"`
			Limit  int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
		}) (*MessageListOutput, error) {
			cid, ok := httpx.ParseID(in.ChannelID)
			if !ok {
				return nil, httpx.BadID("canal")
			}
			var before int64
			if in.Before != "" {
				if before, ok = httpx.ParseID(in.Before); !ok {
					return nil, huma.Error422UnprocessableEntity("before inválido")
				}
			}
			ms, more, err := h.svc.List(ctx, h.userID(ctx), cid, before, in.Limit)
			if err != nil {
				return nil, httpx.Err(err)
			}
			out := &MessageListOutput{}
			out.Body.HasMore = more
			out.Body.Messages = make([]MessagePayload, len(ms))
			for i, m := range ms {
				out.Body.Messages[i] = m.Payload()
			}
			return out, nil
		})

	huma.Register(api, op("editMessage", http.MethodPatch, "/api/channels/{channel_id}/messages/{message_id}", "Edita a própria mensagem", 0, forbidden, invalid),
		func(ctx context.Context, in *struct {
			MessagePath
			Body ContentBody
		}) (*MessageOutput, error) {
			cid, mid, err := ids(in.ChannelID, in.MessageID)
			if err != nil {
				return nil, err
			}
			m, eerr := h.svc.Edit(ctx, h.userID(ctx), cid, mid, in.Body.Content)
			if eerr != nil {
				return nil, httpx.Err(eerr)
			}
			return &MessageOutput{Body: m.Payload()}, nil
		})

	huma.Register(api, op("deleteMessage", http.MethodDelete, "/api/channels/{channel_id}/messages/{message_id}", "Exclui a mensagem (autor ou MANAGE_MESSAGES)", http.StatusNoContent, forbidden),
		func(ctx context.Context, in *struct{ MessagePath }) (*struct{}, error) {
			cid, mid, err := ids(in.ChannelID, in.MessageID)
			if err != nil {
				return nil, err
			}
			return nil, httpx.Err(h.svc.Delete(ctx, h.userID(ctx), cid, mid))
		})
}

func ids(channel, message string) (int64, int64, error) {
	cid, ok := httpx.ParseID(channel)
	if !ok {
		return 0, 0, httpx.BadID("canal")
	}
	mid, ok := httpx.ParseID(message)
	if !ok {
		return 0, 0, httpx.BadID("mensagem")
	}
	return cid, mid, nil
}
