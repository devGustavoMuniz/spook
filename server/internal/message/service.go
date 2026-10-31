package message

import (
	"context"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

var tracer = otel.Tracer("spook/message")

// Store é o que o service precisa do banco. O autor vem junto (join) para a resposta sair numa consulta só.
type Store interface {
	// Insert grava a mensagem e avança channels.last_message_id.
	Insert(ctx context.Context, id, channelID, authorID int64, content string) (Message, error)
	Get(ctx context.Context, id, channelID int64) (Message, error) // ErrNotFound (inclui apagadas)
	// List devolve até limit mensagens com id < before, da mais nova para a mais antiga, sem as apagadas.
	List(ctx context.Context, channelID, before int64, limit int) ([]Message, error)
	UpdateContent(ctx context.Context, id, channelID int64, content string) error
	Delete(ctx context.Context, id, channelID int64) error // soft delete
}

// Channels é o que message precisa de channel: autorização de acesso ao canal.
type Channels interface {
	Authorize(ctx context.Context, userID, channelID int64, need perm.Perm) (channel.Channel, perm.Member, error)
}

// Limiter limita o envio (5 mensagens a cada 5 s por usuário e canal).
type Limiter interface {
	Take(key string) (ok bool, retryAfter time.Duration)
}

type Avatars interface {
	AvatarURLForKey(ctx context.Context, key *string) string
}

type IDGenerator interface{ Next() int64 }

type Service struct {
	store    Store
	channels Channels
	limiter  Limiter
	avatars  Avatars
	ids      IDGenerator
	pub      events.Publisher
}

func NewService(store Store, channels Channels, limiter Limiter, avatars Avatars, ids IDGenerator, pub events.Publisher) *Service {
	return &Service{store: store, channels: channels, limiter: limiter, avatars: avatars, ids: ids, pub: pub}
}

// validContent confere o tamanho (em runes) e rejeita texto só de espaços; devolve o texto sem espaços nas pontas.
func validContent(content string) (string, error) {
	if httpx.Runes(content) > MaxContentRunes {
		return "", apperr.Invalid("a mensagem pode ter no máximo 2000 caracteres")
	}
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return "", apperr.Invalid("a mensagem não pode ser vazia")
	}
	return trimmed, nil
}

func (s *Service) resolveAvatar(ctx context.Context, m *Message) {
	m.Author.AvatarURL = s.avatars.AvatarURLForKey(ctx, m.Author.AvatarKey)
}

func (s *Service) Send(ctx context.Context, userID, channelID int64, content string) (Message, error) {
	ctx, span := tracer.Start(ctx, "message.Send")
	defer span.End()
	span.SetAttributes(attribute.Int64("channel.id", channelID))

	_, authSpan := tracer.Start(ctx, "message.authorize")
	ch, _, err := s.channels.Authorize(ctx, userID, channelID, perm.SendMessages)
	authSpan.End()
	if err != nil {
		return Message{}, err
	}
	if ch.Type != channel.TypeText {
		return Message{}, apperr.Invalid("só canais de texto recebem mensagens")
	}
	if ok, wait := s.limiter.Take("msg:" + strconv.FormatInt(userID, 10) + ":" + strconv.FormatInt(channelID, 10)); !ok {
		return Message{}, apperr.RateLimited("você está enviando mensagens rápido demais", wait)
	}
	text, err := validContent(content)
	if err != nil {
		return Message{}, err
	}

	_, insSpan := tracer.Start(ctx, "message.insert")
	m, err := s.store.Insert(ctx, s.ids.Next(), channelID, userID, text)
	insSpan.End()
	if err != nil {
		return Message{}, err
	}
	s.resolveAvatar(ctx, &m)
	s.publish(events.MessageCreate, ch, m.Payload())
	return m, nil
}

// List devolve uma página do histórico, da mais nova para a mais antiga. before = 0 começa pela mais nova.
func (s *Service) List(ctx context.Context, userID, channelID, before int64, limit int) (msgs []Message, hasMore bool, err error) {
	ctx, span := tracer.Start(ctx, "message.List")
	defer span.End()
	if limit <= 0 {
		limit = DefaultPageSize
	}
	if limit > MaxPageSize {
		limit = MaxPageSize
	}
	if _, _, err := s.channels.Authorize(ctx, userID, channelID, 0); err != nil {
		return nil, false, err
	}
	if before <= 0 {
		before = 1<<63 - 1
	}
	msgs, err = s.store.List(ctx, channelID, before, limit+1)
	if err != nil {
		return nil, false, err
	}
	if len(msgs) > limit {
		msgs, hasMore = msgs[:limit], true
	}
	cache := map[int64]string{}
	for i := range msgs {
		a := &msgs[i].Author
		url, ok := cache[a.ID]
		if !ok {
			url = s.avatars.AvatarURLForKey(ctx, a.AvatarKey)
			cache[a.ID] = url
		}
		a.AvatarURL = url
	}
	return msgs, hasMore, nil
}

// Edit altera o conteúdo; só o autor edita.
func (s *Service) Edit(ctx context.Context, userID, channelID, messageID int64, content string) (Message, error) {
	ctx, span := tracer.Start(ctx, "message.Edit")
	defer span.End()
	ch, _, err := s.channels.Authorize(ctx, userID, channelID, 0)
	if err != nil {
		return Message{}, err
	}
	cur, err := s.store.Get(ctx, messageID, channelID)
	if err != nil {
		return Message{}, err
	}
	if cur.Author.ID != userID {
		return Message{}, apperr.Forbidden("só o autor pode editar a mensagem")
	}
	text, err := validContent(content)
	if err != nil {
		return Message{}, err
	}
	if err := s.store.UpdateContent(ctx, messageID, channelID, text); err != nil {
		return Message{}, err
	}
	m, err := s.store.Get(ctx, messageID, channelID)
	if err != nil {
		return Message{}, err
	}
	s.resolveAvatar(ctx, &m)
	s.publish(events.MessageUpdate, ch, m.Payload())
	return m, nil
}

// Delete apaga (soft delete) a mensagem; o autor ou quem tem MANAGE_MESSAGES.
func (s *Service) Delete(ctx context.Context, userID, channelID, messageID int64) error {
	ctx, span := tracer.Start(ctx, "message.Delete")
	defer span.End()
	ch, member, err := s.channels.Authorize(ctx, userID, channelID, 0)
	if err != nil {
		return err
	}
	cur, err := s.store.Get(ctx, messageID, channelID)
	if err != nil {
		return err
	}
	if cur.Author.ID != userID && !member.Has(perm.ManageMessages) {
		return apperr.Forbidden("só o autor ou quem gerencia mensagens pode excluí-la")
	}
	if err := s.store.Delete(ctx, messageID, channelID); err != nil {
		return err
	}
	var gid int64
	if ch.GuildID != nil {
		gid = *ch.GuildID
	}
	s.pub.Publish(events.Event{
		Type: events.MessageDelete, GuildID: gid, ChannelID: channelID,
		Topics: []string{"channel:" + strconv.FormatInt(channelID, 10)},
		Data:   DeletePayload{ID: httpx.ID(messageID), ChannelID: httpx.ID(channelID), GuildID: httpx.ID(gid)},
	})
	return nil
}

func (s *Service) publish(typ string, ch channel.Channel, data MessagePayload) {
	var gid int64
	if ch.GuildID != nil {
		gid = *ch.GuildID
	}
	s.pub.Publish(events.Event{
		Type: typ, GuildID: gid, ChannelID: ch.ID,
		Topics: []string{"channel:" + strconv.FormatInt(ch.ID, 10)}, Data: data,
	})
}
