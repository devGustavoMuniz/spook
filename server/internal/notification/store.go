package notification

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// ErrNotFound: a inscrição ou a mensagem não existe mais (ou foi apagada).
var ErrNotFound = errors.New("não encontrado")

// MentionState é o estado de um usuário depois de somar uma menção.
type MentionState struct {
	UserID, LastRead int64
	Mentions         int
}

// Subscription é uma inscrição de Web Push.
type Subscription struct {
	ID       int64
	UserID   int64
	Endpoint string
	P256dh   string
	Auth     string
}

// PushContext são os dados da mensagem para montar o push na hora do envio.
type PushContext struct {
	Content         string
	Username        string
	DisplayName     string
	ChannelName     string
	GuildID         *int64
	GuildName       string
	AttachmentCount int
}

// Store é o que o service precisa do banco.
type Store interface {
	// Ack avança a leitura (nunca regride, nunca passa da última mensagem do canal) e zera as menções
	// quando alcança a última mensagem.
	Ack(ctx context.Context, userID, channelID, messageID int64) (lastRead int64, mentions int, err error)
	// DeleteGuildReadStates apaga o estado de leitura de quem saiu do servidor (a volta recomeça da nova entrada).
	DeleteGuildReadStates(ctx context.Context, guildID, userID int64) error
	IncrementMentions(ctx context.Context, channelID int64, guildID *int64, userIDs []int64) ([]MentionState, error)
	// ReadStates devolve o estado de todos os canais acessíveis em UMA consulta (sem N+1).
	ReadStates(ctx context.Context, userID int64) ([]ReadState, error)
	// ResolveGuildMentions devolve, entre os usernames dados, os membros do servidor que veem os canais.
	ResolveGuildMentions(ctx context.Context, guildID, authorID int64, usernames []string) ([]int64, error)
	ResolveDMMentions(ctx context.Context, channelID, authorID int64, usernames []string) ([]int64, error)
	RecipientIDs(ctx context.Context, channelID int64) ([]int64, error)

	PushContext(ctx context.Context, messageID int64) (PushContext, error) // ErrNotFound se apagada
	// Subscribe grava a inscrição (upsert pelo endpoint) respeitando o limite por usuário; ErrTooManySubs.
	Subscribe(ctx context.Context, s Subscription, limit int) error
	Unsubscribe(ctx context.Context, userID int64, endpoint string) error
	Subscription(ctx context.Context, id int64) (Subscription, error) // ErrNotFound
	DeleteSubscription(ctx context.Context, id int64) error
	SubscriptionsOf(ctx context.Context, userIDs []int64) ([]Subscription, error)
}

type PGStore struct {
	d db.DB
	q *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{d: d, q: dbgen.New(d)} }

func wrap(what string, err error) error { return fmt.Errorf("%s: %w", what, err) }

func (s *PGStore) Ack(ctx context.Context, userID, channelID, messageID int64) (int64, int, error) {
	r, err := s.q.AckChannel(ctx, dbgen.AckChannelParams{UserID: userID, ChannelID: channelID, MessageID: messageID})
	if errors.Is(err, pgx.ErrNoRows) { // canal inexistente
		return 0, 0, ErrNotFound
	}
	if err != nil {
		return 0, 0, wrap("registrar leitura", err)
	}
	return r.LastReadMessageID, int(r.MentionCount), nil
}

func (s *PGStore) DeleteGuildReadStates(ctx context.Context, guildID, userID int64) error {
	if err := s.q.DeleteGuildReadStates(ctx, dbgen.DeleteGuildReadStatesParams{GuildID: guildID, UserID: userID}); err != nil {
		return wrap("apagar estados de leitura do servidor", err)
	}
	return nil
}

func (s *PGStore) IncrementMentions(ctx context.Context, channelID int64, guildID *int64, userIDs []int64) ([]MentionState, error) {
	rows, err := s.q.IncrementMentions(ctx, dbgen.IncrementMentionsParams{ChannelID: channelID, GuildID: guildID, UserIds: userIDs})
	if err != nil {
		return nil, wrap("somar menções", err)
	}
	out := make([]MentionState, len(rows))
	for i, r := range rows {
		out[i] = MentionState{UserID: r.UserID, LastRead: r.LastReadMessageID, Mentions: int(r.MentionCount)}
	}
	return out, nil
}

func (s *PGStore) ReadStates(ctx context.Context, userID int64) ([]ReadState, error) {
	access, err := s.q.ListAccessByUser(ctx, userID)
	if err != nil {
		return nil, wrap("buscar permissões", err)
	}
	guilds := make([]int64, 0, len(access))
	for _, a := range access {
		if perm.NewMember(userID, a.OwnerID == userID, perm.Perm(a.Permissions), 0).Has(perm.ViewChannel) {
			guilds = append(guilds, a.GuildID)
		}
	}
	rows, err := s.q.ListReadStates(ctx, dbgen.ListReadStatesParams{UserID: userID, GuildIds: guilds})
	if err != nil {
		return nil, wrap("listar estados de leitura", err)
	}
	out := make([]ReadState, len(rows))
	for i, r := range rows {
		out[i] = ReadState{
			ChannelID: r.ChannelID, GuildID: r.GuildID, LastRead: r.LastReadMessageID,
			Mentions: int(r.MentionCount), Unread: min(int(r.UnreadCount), MaxUnread),
		}
	}
	return out, nil
}

func (s *PGStore) ResolveGuildMentions(ctx context.Context, guildID, authorID int64, usernames []string) ([]int64, error) {
	rows, err := s.q.ResolveGuildMentions(ctx, dbgen.ResolveGuildMentionsParams{GuildID: guildID, Usernames: usernames, AuthorID: authorID})
	if err != nil {
		return nil, wrap("resolver menções", err)
	}
	var out []int64
	for _, r := range rows {
		if perm.NewMember(r.UserID, r.OwnerID == r.UserID, perm.Perm(r.Permissions), 0).Has(perm.ViewChannel) {
			out = append(out, r.UserID)
		}
	}
	return out, nil
}

func (s *PGStore) ResolveDMMentions(ctx context.Context, channelID, authorID int64, usernames []string) ([]int64, error) {
	ids, err := s.q.ResolveDMMentions(ctx, dbgen.ResolveDMMentionsParams{ChannelID: channelID, Usernames: usernames, AuthorID: authorID})
	if err != nil {
		return nil, wrap("resolver menções da DM", err)
	}
	return ids, nil
}

func (s *PGStore) RecipientIDs(ctx context.Context, channelID int64) ([]int64, error) {
	ids, err := s.q.ListChannelRecipientIDs(ctx, channelID)
	if err != nil {
		return nil, wrap("listar participantes", err)
	}
	return ids, nil
}

func (s *PGStore) PushContext(ctx context.Context, messageID int64) (PushContext, error) {
	r, err := s.q.GetPushContext(ctx, messageID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PushContext{}, ErrNotFound
	}
	if err != nil {
		return PushContext{}, wrap("buscar mensagem do push", err)
	}
	pc := PushContext{Content: r.Content, Username: r.Username, GuildID: r.GuildID, AttachmentCount: int(r.AttachmentCount)}
	if r.DisplayName != nil {
		pc.DisplayName = *r.DisplayName
	}
	if r.ChannelName != nil {
		pc.ChannelName = *r.ChannelName
	}
	if r.GuildName != nil {
		pc.GuildName = *r.GuildName
	}
	return pc, nil
}

func (s *PGStore) Subscribe(ctx context.Context, sub Subscription, limit int) error {
	tx, err := s.d.Begin(ctx)
	if err != nil {
		return wrap("abrir transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if _, err := q.LockUser(ctx, sub.UserID); err != nil { // serializa inscrições concorrentes do usuário
		return wrap("travar usuário", err)
	}
	n, err := q.CountPushSubscriptionsExcept(ctx, dbgen.CountPushSubscriptionsExceptParams{UserID: sub.UserID, Endpoint: sub.Endpoint})
	if err != nil {
		return wrap("contar inscrições", err)
	}
	if int(n) >= limit {
		return ErrTooManySubs
	}
	if _, err := q.UpsertPushSubscription(ctx, dbgen.UpsertPushSubscriptionParams{
		ID: sub.ID, UserID: sub.UserID, Endpoint: sub.Endpoint, P256dh: sub.P256dh, Auth: sub.Auth,
	}); err != nil {
		return wrap("gravar inscrição", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return wrap("confirmar inscrição", err)
	}
	return nil
}

func (s *PGStore) Unsubscribe(ctx context.Context, userID int64, endpoint string) error {
	if _, err := s.q.DeletePushSubscription(ctx, dbgen.DeletePushSubscriptionParams{UserID: userID, Endpoint: endpoint}); err != nil {
		return wrap("remover inscrição", err)
	}
	return nil
}

func fromRow(r dbgen.PushSubscription) Subscription {
	return Subscription{ID: r.ID, UserID: r.UserID, Endpoint: r.Endpoint, P256dh: r.P256dh, Auth: r.Auth}
}

func (s *PGStore) Subscription(ctx context.Context, id int64) (Subscription, error) {
	r, err := s.q.GetPushSubscription(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Subscription{}, ErrNotFound
	}
	if err != nil {
		return Subscription{}, wrap("buscar inscrição", err)
	}
	return fromRow(r), nil
}

func (s *PGStore) DeleteSubscription(ctx context.Context, id int64) error {
	if err := s.q.DeletePushSubscriptionByID(ctx, id); err != nil {
		return wrap("remover inscrição", err)
	}
	return nil
}

func (s *PGStore) SubscriptionsOf(ctx context.Context, userIDs []int64) ([]Subscription, error) {
	rows, err := s.q.ListPushSubscriptionsByUsers(ctx, userIDs)
	if err != nil {
		return nil, wrap("listar inscrições", err)
	}
	out := make([]Subscription, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r)
	}
	return out, nil
}
