package message

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

var (
	tracer = otel.Tracer("spook/message")

	// withAttachments conta as mensagens enviadas com anexo e os anexos nelas (instrumento no-op sem MeterProvider).
	withAttachments, _ = otel.Meter("spook/message").Int64Counter("spook.messages.with_attachments",
		metric.WithDescription("Mensagens enviadas com anexo"))
	attachmentsSent, _ = otel.Meter("spook/message").Int64Counter("spook.messages.attachments",
		metric.WithDescription("Anexos enviados em mensagens"))
	repliesSent, _ = otel.Meter("spook/message").Int64Counter("spook.messages.replies",
		metric.WithDescription("Mensagens enviadas como resposta a outra"))
	pinOps, _ = otel.Meter("spook/message").Int64Counter("spook.messages.pin_ops",
		metric.WithDescription("Fixações e desafixações de mensagens"))
)

// maxMentionIDs é o teto de mencionados por mensagem (igual a notification.MaxMentions).
const maxMentionIDs = 20

// SendOptions são os dados extras de um envio. ReplyTo = 0 envia uma mensagem comum.
type SendOptions struct {
	ReplyTo int64 // ID da mensagem respondida (mesmo canal, não apagada)
	// MentionReply menciona o autor da mensagem respondida (como um @ direto: contador e push).
	MentionReply bool
}

// Store é o que o service precisa do banco. O autor vem junto (join) para a resposta sair numa consulta só.
type Store interface {
	// Insert grava a mensagem e avança channels.last_message_id. Com AttachmentIDs, associa os anexos e
	// enfileira os thumbnails na mesma transação (anexo que não vale mais = attachment.ErrInvalidAttachments).
	Insert(ctx context.Context, p InsertParams) (Message, []attachment.Attachment, error)
	Get(ctx context.Context, id, channelID int64) (Message, error) // ErrNotFound (inclui apagadas)
	// List devolve até limit mensagens com id < before, da mais nova para a mais antiga, sem as apagadas.
	List(ctx context.Context, channelID, before int64, limit int) ([]Message, error)
	UpdateContent(ctx context.Context, id, channelID int64, content string) error
	Delete(ctx context.Context, id, channelID int64) error // soft delete
	// References devolve a prévia das mensagens respondidas (inclusive apagadas) do canal, por ID, numa consulta só.
	References(ctx context.Context, channelID int64, ids []int64) (map[int64]Reply, error)
	// ListPinned devolve as fixadas (apagadas não entram), a mais recentemente fixada primeiro.
	ListPinned(ctx context.Context, channelID int64, limit int) ([]Message, error)
	// Pin fixa se ainda não está fixada e o canal tem menos de max fixadas; false = nada mudou.
	Pin(ctx context.Context, id, channelID, userID int64, max int) (bool, error)
	// Unpin desafixa; false = não estava fixada.
	Unpin(ctx context.Context, id, channelID int64) (bool, error)
	// HasRecentJoin diz se o usuário já tem uma mensagem de entrada neste canal no último minuto.
	HasRecentJoin(ctx context.Context, channelID, userID int64) (bool, error)
}

// InsertParams são os dados de uma nova mensagem.
type InsertParams struct {
	ID, ChannelID, AuthorID int64
	ReferenceID             *int64 // mensagem respondida
	Content                 string
	Kind                    string // "" = KindDefault
	MentionIDs              []int64
	MentionEveryone         bool
	MentionHere             bool
	MentionRoleIDs          []int64
	AttachmentIDs           []int64
	KeyPrefix               string    // prefixo de chave do canal (prende os anexos ao canal)
	Since                   time.Time // só vale anexo criado depois disto (janela de 1 h)
}

// Attachments é o que message precisa de attachment: validar os anexos de um envio e montar os
// payloads com as URLs de leitura (em lote).
type Attachments interface {
	Verify(ctx context.Context, userID, channelID int64, ids []int64) error
	Payloads(ctx context.Context, as []attachment.Attachment) ([]attachment.AttachmentPayload, error)
	ForMessages(ctx context.Context, messageIDs []int64) (map[int64][]attachment.AttachmentPayload, error)
}

// Channels é o que message precisa de channel: autorização de acesso ao canal. Cobre canais de
// servidor (permissões por cargo) e DMs (ser participante; o perm.Member devolvido é vazio e
// ch.GuildID é nil).
type Channels interface {
	Authorize(ctx context.Context, userID, channelID int64, need perm.Perm) (channel.Channel, perm.Member, error)
	// Get devolve o canal sem checar acesso (jobs que republicam eventos).
	Get(ctx context.Context, channelID int64) (channel.Channel, error)
}

// MentionResult é o que um texto menciona: usuários (@username) que veem o canal e, só quando o autor podia,
// @everyone, @here e cargos.
type MentionResult struct {
	UserIDs  []int64
	Everyone bool
	Here     bool
	RoleIDs  []int64
}

// Mass diz se há menção em massa (@everyone ou @here).
func (r MentionResult) Mass() bool { return r.Everyone || r.Here }

// Mentions resolve as menções de um texto. canMentionAll diz se o autor tem MENTION_EVERYONE: sem ele,
// @everyone e @here são só texto e só cargos mencionáveis valem. Quem implementa é a feature de notificações
// (que também assina MESSAGE_CREATE); a interface evita que message dependa dela. Nil = sem menções.
type Mentions interface {
	Resolve(ctx context.Context, ch channel.Channel, authorID int64, content string, canMentionAll bool) (MentionResult, error)
}

// SystemChannels diz para onde vai a mensagem de entrada de um servidor (implementada por guild.Service):
// canal 0 = o servidor não tem canal de texto; enabled = as mensagens de boas-vindas estão ligadas.
type SystemChannels interface {
	SystemChannel(ctx context.Context, guildID int64) (channelID int64, enabled bool, err error)
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
	atts     Attachments
	ids      IDGenerator
	pub      events.Publisher
	mentions Mentions
	system   SystemChannels
	everyone Limiter // @everyone/@here: 1 por 30 s por usuário e canal (nil = sem limite)
	now      func() time.Time
}

// SetMentions liga a resolução de menções (feita na montagem do app, depois de criar as notificações).
func (s *Service) SetMentions(m Mentions) { s.mentions = m }

// SetSystemChannels liga as mensagens de entrada; SetEveryoneLimiter, o limite de uso de @everyone/@here.
func (s *Service) SetSystemChannels(c SystemChannels) { s.system = c }
func (s *Service) SetEveryoneLimiter(l Limiter)       { s.everyone = l }

func NewService(store Store, channels Channels, limiter Limiter, avatars Avatars, atts Attachments, ids IDGenerator, pub events.Publisher) *Service {
	return &Service{store: store, channels: channels, limiter: limiter, avatars: avatars, atts: atts, ids: ids, pub: pub, now: time.Now}
}

// validContent confere o tamanho (em runes) e rejeita texto só de espaços (a menos que haja anexo);
// devolve o texto sem espaços nas pontas.
func validContent(content string, hasAttachments bool) (string, error) {
	if httpx.Runes(content) > MaxContentRunes {
		return "", apperr.Invalid("a mensagem pode ter no máximo 2000 caracteres")
	}
	trimmed := strings.TrimSpace(content)
	if trimmed == "" && !hasAttachments {
		return "", ErrEmptyMessage
	}
	return trimmed, nil
}

func (s *Service) resolveAvatar(ctx context.Context, m *Message) {
	m.Author.AvatarURL = s.avatars.AvatarURLForKey(ctx, m.Author.AvatarKey)
}

// Send grava a mensagem. attachmentIDs são anexos já enviados ao storage (RF10.1); com anexo o conteúdo
// pode ser vazio (SPEC 7.3).
func (s *Service) Send(ctx context.Context, userID, channelID int64, content string, attachmentIDs []int64, opts SendOptions) (Message, error) {
	ctx, span := tracer.Start(ctx, "message.Send")
	defer span.End()
	span.SetAttributes(attribute.Int64("channel.id", channelID), attribute.Int("attachments.count", len(attachmentIDs)), attribute.Bool("reply", opts.ReplyTo != 0))

	need := perm.SendMessages
	if len(attachmentIDs) > 0 {
		need |= perm.AttachFiles
	}
	_, authSpan := tracer.Start(ctx, "message.authorize")
	ch, member, err := s.channels.Authorize(ctx, userID, channelID, need)
	authSpan.End()
	if err != nil {
		return Message{}, err
	}
	if ch.Type != channel.TypeText && !ch.IsDM() {
		return Message{}, apperr.Invalid("só canais de texto e DMs recebem mensagens")
	}
	if ok, wait := s.limiter.Take("msg:" + strconv.FormatInt(userID, 10) + ":" + strconv.FormatInt(channelID, 10)); !ok {
		return Message{}, apperr.RateLimited("você está enviando mensagens rápido demais", wait)
	}
	if len(attachmentIDs) > attachment.MaxPerMessage {
		return Message{}, ErrTooManyAttachments
	}
	if hasDuplicates(attachmentIDs) {
		return Message{}, apperr.Invalid("anexo repetido na mensagem")
	}
	text, err := validContent(content, len(attachmentIDs) > 0)
	if err != nil {
		return Message{}, err
	}
	if len(attachmentIDs) > 0 {
		if err := s.atts.Verify(ctx, userID, channelID, attachmentIDs); err != nil {
			return Message{}, err
		}
	}

	var reply *Reply
	if opts.ReplyTo != 0 {
		var err error
		if reply, err = s.replyTarget(ctx, channelID, opts.ReplyTo); err != nil {
			return Message{}, err
		}
	}

	var mentionIDs []int64
	var mass MentionResult
	if s.mentions != nil && text != "" {
		// Falha ao resolver menções não impede a mensagem: ela sai sem destaque.
		res, rerr := s.mentions.Resolve(ctx, ch, userID, text, member.Has(perm.MentionEveryone))
		if rerr != nil {
			slog.Warn("menções não resolvidas", "channel", channelID, "err", rerr)
		} else {
			mentionIDs, mass = res.UserIDs, res
		}
	}
	if mass.Mass() && s.everyone != nil {
		if ok, wait := s.everyone.Take("everyone:" + strconv.FormatInt(userID, 10) + ":" + strconv.FormatInt(channelID, 10)); !ok {
			return Message{}, apperr.RateLimited("você usou @everyone ou @here neste canal há pouco; aguarde para usar de novo", wait)
		}
	}

	if reply != nil && opts.MentionReply && s.mentions != nil && reply.Author.ID != userID {
		mentionIDs = s.mentionReplyAuthor(ctx, ch, userID, reply.Author, mentionIDs)
	}

	var refID *int64
	if reply != nil {
		refID = &reply.ID
	}
	_, insSpan := tracer.Start(ctx, "message.insert")
	m, atts, err := s.store.Insert(ctx, InsertParams{
		ID: s.ids.Next(), ChannelID: channelID, AuthorID: userID, ReferenceID: refID, Content: text, AttachmentIDs: attachmentIDs, MentionIDs: mentionIDs,
		MentionEveryone: mass.Everyone, MentionHere: mass.Here, MentionRoleIDs: mass.RoleIDs,
		KeyPrefix: attachment.KeyPrefix(channelID), Since: s.now().Add(-attachment.ClaimWindow),
	})
	insSpan.End()
	if err != nil {
		return Message{}, err
	}
	if len(atts) > 0 {
		if m.Attachments, err = s.atts.Payloads(ctx, atts); err != nil {
			return Message{}, err
		}
		withAttachments.Add(ctx, 1)
		attachmentsSent.Add(ctx, int64(len(atts)))
	}
	m.Reply = reply
	if reply != nil {
		repliesSent.Add(ctx, 1)
	}
	s.resolveAvatar(ctx, &m)
	s.publish(events.MessageCreate, ch, m.Payload())
	return m, nil
}

// replyTarget valida a mensagem respondida: precisa existir, não estar apagada e ser do mesmo canal.
func (s *Service) replyTarget(ctx context.Context, channelID, replyTo int64) (*Reply, error) {
	ctx, span := tracer.Start(ctx, "message.replyTarget")
	defer span.End()
	refs, err := s.store.References(ctx, channelID, []int64{replyTo})
	if err != nil {
		return nil, err
	}
	ref, ok := refs[replyTo]
	if !ok || ref.Deleted {
		return nil, ErrReplyTarget
	}
	if ref.Kind != "" && ref.Kind != KindDefault {
		return nil, ErrSystemMsg
	}
	return &ref, nil
}

// mentionReplyAuthor inclui o autor da mensagem respondida entre os mencionados, se ele vê o canal
// (a checagem reaproveita a resolução de @username). Falha na resolução: a resposta sai sem a menção.
func (s *Service) mentionReplyAuthor(ctx context.Context, ch channel.Channel, userID int64, author Author, ids []int64) []int64 {
	res, err := s.mentions.Resolve(ctx, ch, userID, "@"+author.Username, false)
	if err != nil {
		slog.Warn("menção da resposta não resolvida", "channel", ch.ID, "err", err)
		return ids
	}
	resolved := res.UserIDs
	if !slices.Contains(resolved, author.ID) || slices.Contains(ids, author.ID) {
		return ids
	}
	if len(ids) >= maxMentionIDs {
		ids = ids[:maxMentionIDs-1]
	}
	ids = append(ids[:len(ids):len(ids)], author.ID)
	slices.Sort(ids)
	return ids
}

func hasDuplicates(ids []int64) bool {
	seen := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		if _, dup := seen[id]; dup {
			return true
		}
		seen[id] = struct{}{}
	}
	return false
}

// attach preenche os anexos e a prévia das mensagens respondidas de várias mensagens, cada um com uma
// consulta só (sem N+1). Todas as mensagens são do mesmo canal.
func (s *Service) attach(ctx context.Context, msgs []Message) error {
	if len(msgs) == 0 {
		return nil
	}
	ids := make([]int64, len(msgs))
	var refs []int64
	for i, m := range msgs {
		ids[i] = m.ID
		if m.ReferenceID != nil && !slices.Contains(refs, *m.ReferenceID) {
			refs = append(refs, *m.ReferenceID)
		}
	}
	byMsg, err := s.atts.ForMessages(ctx, ids)
	if err != nil {
		return err
	}
	var replies map[int64]Reply
	if len(refs) > 0 {
		if replies, err = s.store.References(ctx, msgs[0].ChannelID, refs); err != nil {
			return err
		}
	}
	for i := range msgs {
		msgs[i].Attachments = byMsg[msgs[i].ID]
		if id := msgs[i].ReferenceID; id != nil {
			r, ok := replies[*id]
			if !ok {
				r = Reply{ID: *id, Deleted: true} // a original não existe mais
			}
			msgs[i].Reply = &r
		}
	}
	return nil
}

// RepublishUpdate publica MESSAGE_UPDATE com o payload atual (usado pelo job de thumbnail para os
// clientes passarem a ver thumbnail_url). Mensagem apagada nesse meio tempo: nada a fazer.
func (s *Service) RepublishUpdate(ctx context.Context, channelID, messageID int64) error {
	ch, err := s.channels.Get(ctx, channelID)
	if err != nil {
		if errors.Is(err, channel.ErrNotFound) {
			return nil
		}
		return err
	}
	m, err := s.store.Get(ctx, messageID, channelID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	msgs := []Message{m}
	if err := s.attach(ctx, msgs); err != nil {
		return err
	}
	m = msgs[0]
	s.resolveAvatar(ctx, &m)
	s.publish(events.MessageUpdate, ch, m.Payload())
	return nil
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
	s.resolveAvatars(ctx, msgs)
	if err := s.attach(ctx, msgs); err != nil {
		return nil, false, err
	}
	return msgs, hasMore, nil
}

// resolveAvatars preenche o avatar dos autores (uma resolução por autor distinto).
func (s *Service) resolveAvatars(ctx context.Context, msgs []Message) {
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
}

// ListPins devolve as mensagens fixadas do canal (até MaxPins), a mais recentemente fixada primeiro.
func (s *Service) ListPins(ctx context.Context, userID, channelID int64) ([]Message, error) {
	ctx, span := tracer.Start(ctx, "message.ListPins")
	defer span.End()
	if _, _, err := s.channels.Authorize(ctx, userID, channelID, 0); err != nil {
		return nil, err
	}
	msgs, err := s.store.ListPinned(ctx, channelID, MaxPins)
	if err != nil {
		return nil, err
	}
	s.resolveAvatars(ctx, msgs)
	if err := s.attach(ctx, msgs); err != nil {
		return nil, err
	}
	return msgs, nil
}

// Pin fixa a mensagem (idempotente). Em servidor exige MANAGE_MESSAGES; em DM, ser participante. Mudou
// algo: publica MESSAGE_UPDATE com pinned = true.
func (s *Service) Pin(ctx context.Context, userID, channelID, messageID int64) error {
	return s.setPinned(ctx, userID, channelID, messageID, true)
}

// Unpin desafixa a mensagem (idempotente), com as mesmas regras de Pin.
func (s *Service) Unpin(ctx context.Context, userID, channelID, messageID int64) error {
	return s.setPinned(ctx, userID, channelID, messageID, false)
}

func (s *Service) setPinned(ctx context.Context, userID, channelID, messageID int64, pin bool) error {
	ctx, span := tracer.Start(ctx, "message.SetPinned")
	defer span.End()
	span.SetAttributes(attribute.Int64("channel.id", channelID), attribute.Bool("pin", pin))
	ch, _, err := s.channels.Authorize(ctx, userID, channelID, perm.ManageMessages)
	if err != nil {
		return err
	}
	cur, err := s.store.Get(ctx, messageID, channelID)
	if err != nil {
		return err
	}
	if (cur.PinnedAt != nil) == pin {
		return nil // já está no estado pedido
	}
	var changed bool
	if pin {
		if changed, err = s.store.Pin(ctx, messageID, channelID, userID, MaxPins); err != nil {
			return err
		}
	} else if changed, err = s.store.Unpin(ctx, messageID, channelID); err != nil {
		return err
	}
	if !changed {
		// Perdeu uma corrida (outro pedido já mudou) ou o canal está no limite: relê para distinguir.
		again, gerr := s.store.Get(ctx, messageID, channelID)
		if gerr != nil {
			return gerr
		}
		if (again.PinnedAt != nil) == pin {
			return nil
		}
		return ErrTooManyPins
	}
	pinOps.Add(ctx, 1, metric.WithAttributes(attribute.Bool("pin", pin)))
	m, err := s.store.Get(ctx, messageID, channelID)
	if err != nil {
		return err
	}
	msgs := []Message{m}
	if err := s.attach(ctx, msgs); err != nil {
		return err
	}
	m = msgs[0]
	s.resolveAvatar(ctx, &m)
	s.publish(events.MessageUpdate, ch, m.Payload())
	return nil
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
	if cur.Kind != "" && cur.Kind != KindDefault {
		return Message{}, ErrSystemMsg
	}
	if cur.Author.ID != userID {
		return Message{}, apperr.Forbidden("só o autor pode editar a mensagem")
	}
	text, err := validContent(content, false)
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
	msgs := []Message{m}
	if err := s.attach(ctx, msgs); err != nil {
		return Message{}, err
	}
	m = msgs[0]
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
	// Em DM não há cargos nem MANAGE_MESSAGES: só o autor exclui.
	system := cur.Kind != "" && cur.Kind != KindDefault
	if (cur.Author.ID != userID || system) && (ch.IsDM() || !member.Has(perm.ManageMessages)) {
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
		Data:   DeletePayload{ID: httpx.ID(messageID), ChannelID: httpx.ID(channelID), GuildID: guildIDString(gid)},
	})
	return nil
}

// guildIDString devolve "" para DMs (o campo é omitido no JSON).
func guildIDString(gid int64) string {
	if gid == 0 {
		return ""
	}
	return httpx.ID(gid)
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

// MemberJoined grava e publica a mensagem de sistema "fulano entrou" no canal de sistema do servidor
// (implementa invite.Joiner). Não notifica ninguém (a feature de notificações ignora o tipo) e não soma
// menção. Sem efeito se o servidor desligou as boas-vindas, se não há canal de texto ou se a pessoa já tem a
// mensagem no último minuto (entrar, sair e entrar de novo não repete).
func (s *Service) MemberJoined(ctx context.Context, guildID, userID int64) error {
	ctx, span := tracer.Start(ctx, "message.MemberJoined")
	defer span.End()
	if s.system == nil {
		return nil
	}
	channelID, enabled, err := s.system.SystemChannel(ctx, guildID)
	if err != nil {
		return err
	}
	if !enabled || channelID == 0 {
		return nil
	}
	if dup, err := s.store.HasRecentJoin(ctx, channelID, userID); err != nil || dup {
		return err
	}
	ch, err := s.channels.Get(ctx, channelID)
	if err != nil {
		return err
	}
	m, _, err := s.store.Insert(ctx, InsertParams{ID: s.ids.Next(), ChannelID: channelID, AuthorID: userID, Kind: KindMemberJoin})
	if err != nil {
		return err
	}
	s.resolveAvatar(ctx, &m)
	s.publish(events.MessageCreate, ch, m.Payload())
	return nil
}
