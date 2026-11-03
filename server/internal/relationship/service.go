package relationship

import (
	"context"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

var tracer = otel.Tracer("spook/relationship")

// Store é o que o service precisa do banco.
type Store interface {
	UserByUsername(ctx context.Context, username string) (int64, error) // ErrUserNotFound
	Brief(ctx context.Context, id int64) (Row, error)                   // ErrUserNotFound
	Request(ctx context.Context, userID, other int64) (Outcome, error)
	Accept(ctx context.Context, userID, other int64) error // ErrRequestNotFound
	Remove(ctx context.Context, userID, other int64) (RemoveResult, error)
	Block(ctx context.Context, userID, other int64) (created bool, res RemoveResult, err error)
	Unblock(ctx context.Context, userID, other int64) (bool, error)
	List(ctx context.Context, userID int64, kind Kind, after int64, limit int) ([]Row, error)
	Ready(ctx context.Context, userID int64, limit int) ([]Row, []int64, Counts, error)
	Get(ctx context.Context, userID, other int64) (Kind, time.Time, error)
	FriendsAmong(ctx context.Context, userID int64, candidates []int64) ([]int64, error)
	BlockedAmong(ctx context.Context, userID int64, candidates []int64) ([]int64, error)
	BlockersAmong(ctx context.Context, userID int64, candidates []int64) ([]int64, error)
	DMPairBlocked(ctx context.Context, channelID int64) (bool, error)
}

// Limiter limita as ações por usuário.
type Limiter interface {
	Take(key string) (ok bool, retryAfter time.Duration)
}

type Avatars interface {
	AvatarURLForKey(ctx context.Context, key *string) string
}

// Service reúne as regras de amizade e bloqueio.
type Service struct {
	store    Store
	pub      events.Publisher
	avatars  Avatars
	requests Limiter // pedidos de amizade ("friends.request")
	actions  Limiter // aceitar, desfazer, bloquear, convidar

	invites *inviteDeps
	changes metric.Int64Counter
}

func NewService(store Store, pub events.Publisher, avatars Avatars, requests, actions Limiter) *Service {
	s := &Service{store: store, pub: pub, avatars: avatars, requests: requests, actions: actions}
	s.changes, _ = otel.Meter("spook/relationship").Int64Counter("spook.relationship.changes",
		metric.WithDescription("Mudanças de relacionamento, por ação (request, accept, remove, block, unblock)"))
	return s
}

func userTopic(id int64) string { return "user:" + strconv.FormatInt(id, 10) }

func (s *Service) count(ctx context.Context, action string) {
	s.changes.Add(ctx, 1, metric.WithAttributes(attribute.String("action", action)))
}

func take(l Limiter, key string, msg string) error {
	if l == nil {
		return nil
	}
	if ok, wait := l.Take(key); !ok {
		return apperr.RateLimited(msg, wait)
	}
	return nil
}

func (s *Service) payload(ctx context.Context, r Row) Relationship {
	u := RelationshipUser{ID: idStr(r.OtherID), Username: r.Username, AvatarURL: s.avatars.AvatarURLForKey(ctx, r.AvatarKey)}
	if r.DisplayName != nil {
		u.DisplayName = *r.DisplayName
	}
	return Relationship{User: u, Type: string(r.Kind), Since: r.Since}
}

func (s *Service) payloads(ctx context.Context, rs []Row) []Relationship {
	out := make([]Relationship, len(rs))
	for i, r := range rs {
		out[i] = s.payload(ctx, r)
	}
	return out
}

func (s *Service) emit(typ string, to int64, data any) {
	s.pub.Publish(events.Event{Type: typ, Topics: []string{userTopic(to)}, Data: data})
}

// view monta o payload de other do ponto de vista de quem consulta.
func (s *Service) view(ctx context.Context, other int64, kind Kind, since time.Time) (Relationship, error) {
	row, err := s.store.Brief(ctx, other)
	if err != nil {
		return Relationship{}, err
	}
	row.Kind, row.Since = kind, since
	return s.payload(ctx, row), nil
}

// Request envia um pedido de amizade por username. Se a outra pessoa já tinha pedido a sua, aceita. Quem foi
// bloqueado pela outra pessoa recebe uma resposta idêntica à de um pedido enviado, mas nada é gravado e a pessoa
// não é avisada (o bloqueio não é revelado).
func (s *Service) Request(ctx context.Context, userID int64, username string) (Relationship, error) {
	ctx, span := tracer.Start(ctx, "relationship.Request")
	defer span.End()
	if err := take(s.requests, "friends.request:"+idStr(userID), "você está enviando pedidos de amizade rápido demais"); err != nil {
		return Relationship{}, err
	}
	name := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	if name == "" || len(name) > MaxUsernameInputLen {
		return Relationship{}, ErrUserNotFound
	}
	other, err := s.store.UserByUsername(ctx, name)
	if err != nil {
		return Relationship{}, err
	}
	if other == userID {
		return Relationship{}, apperr.Invalid("você não pode adicionar a si mesmo como amigo")
	}
	out, err := s.store.Request(ctx, userID, other)
	if err != nil {
		return Relationship{}, err
	}
	span.SetAttributes(attribute.Int("outcome", int(out)))
	now := time.Now()
	switch out {
	case OutcomeBlockedByMe:
		return Relationship{}, ErrBlockedByMe
	case OutcomeBlockedByThem:
		return s.view(ctx, other, KindOutgoing, now) // idêntico a um pedido enviado; nada é gravado nem avisado
	case OutcomeCreated:
		s.count(ctx, "request")
		mine, err := s.view(ctx, other, KindOutgoing, now)
		if err != nil {
			return Relationship{}, err
		}
		s.emit(events.RelationshipAdd, userID, mine)
		if theirs, err := s.view(ctx, userID, KindIncoming, now); err == nil {
			s.emit(events.RelationshipAdd, other, theirs)
		}
		return mine, nil
	case OutcomeAccepted:
		s.count(ctx, "accept")
		return s.publishAccepted(ctx, userID, other, now)
	case OutcomeAlreadyFriend:
		return s.view(ctx, other, KindFriend, now)
	default: // OutcomePending
		return s.view(ctx, other, KindOutgoing, now)
	}
}

// publishAccepted avisa os dois lados de que viraram amigos e devolve o payload de other para userID.
func (s *Service) publishAccepted(ctx context.Context, userID, other int64, now time.Time) (Relationship, error) {
	mine, err := s.view(ctx, other, KindFriend, now)
	if err != nil {
		return Relationship{}, err
	}
	s.emit(events.RelationshipUpdate, userID, mine)
	if theirs, err := s.view(ctx, userID, KindFriend, now); err == nil {
		s.emit(events.RelationshipUpdate, other, theirs)
	}
	return mine, nil
}

// Accept aceita o pedido que other enviou a userID.
func (s *Service) Accept(ctx context.Context, userID, other int64) (Relationship, error) {
	ctx, span := tracer.Start(ctx, "relationship.Accept")
	defer span.End()
	if err := take(s.actions, "friends.action:"+idStr(userID), "muitas ações de amizade seguidas; aguarde um pouco"); err != nil {
		return Relationship{}, err
	}
	if other == userID {
		return Relationship{}, ErrSelf
	}
	if err := s.store.Accept(ctx, userID, other); err != nil {
		return Relationship{}, err
	}
	s.count(ctx, "accept")
	return s.publishAccepted(ctx, userID, other, time.Now())
}

// Remove desfaz a amizade, cancela o pedido enviado ou recusa o recebido (idempotente). Recusar não avisa quem
// pediu (o pedido dele só some quando ele atualizar a lista); desfazer e cancelar avisam os dois.
func (s *Service) Remove(ctx context.Context, userID, other int64) error {
	ctx, span := tracer.Start(ctx, "relationship.Remove")
	defer span.End()
	if err := take(s.actions, "friends.action:"+idStr(userID), "muitas ações de amizade seguidas; aguarde um pouco"); err != nil {
		return err
	}
	if other == userID {
		return ErrSelf
	}
	res, err := s.store.Remove(ctx, userID, other)
	if err != nil || !res.Removed {
		return err
	}
	s.count(ctx, "remove")
	s.emit(events.RelationshipRemove, userID, RelationshipRemoved{UserID: idStr(other)})
	declined := !res.WasAccepted && res.RequestedBy == other
	if !declined {
		s.emit(events.RelationshipRemove, other, RelationshipRemoved{UserID: idStr(userID)})
	}
	return nil
}

// Block bloqueia other: desfaz a amizade e cancela pedidos entre os dois. Idempotente.
func (s *Service) Block(ctx context.Context, userID, other int64) (Relationship, error) {
	ctx, span := tracer.Start(ctx, "relationship.Block")
	defer span.End()
	if err := take(s.actions, "friends.action:"+idStr(userID), "muitas ações de amizade seguidas; aguarde um pouco"); err != nil {
		return Relationship{}, err
	}
	if other == userID {
		return Relationship{}, ErrSelf
	}
	if _, err := s.store.Brief(ctx, other); err != nil {
		return Relationship{}, err
	}
	created, res, err := s.store.Block(ctx, userID, other)
	if err != nil {
		return Relationship{}, err
	}
	span.SetAttributes(attribute.Bool("created", created))
	p, err := s.view(ctx, other, KindBlocked, time.Now())
	if err != nil {
		return Relationship{}, err
	}
	if created {
		s.count(ctx, "block")
		s.emit(events.RelationshipAdd, userID, p)
	}
	// Quem tinha a amizade ou um pedido SEU vê o relacionamento sumir; um pedido que ele enviou a você some só
	// do seu lado (ele não é avisado do bloqueio).
	if res.Removed && (res.WasAccepted || res.RequestedBy == userID) {
		s.emit(events.RelationshipRemove, other, RelationshipRemoved{UserID: idStr(userID)})
	}
	return p, nil
}

// Unblock desbloqueia other (idempotente). Não restaura a amizade.
func (s *Service) Unblock(ctx context.Context, userID, other int64) error {
	ctx, span := tracer.Start(ctx, "relationship.Unblock")
	defer span.End()
	if err := take(s.actions, "friends.action:"+idStr(userID), "muitas ações de amizade seguidas; aguarde um pouco"); err != nil {
		return err
	}
	if other == userID {
		return ErrSelf
	}
	removed, err := s.store.Unblock(ctx, userID, other)
	if err != nil || !removed {
		return err
	}
	s.count(ctx, "unblock")
	s.emit(events.RelationshipRemove, userID, RelationshipRemoved{UserID: idStr(other)})
	return nil
}

// List devolve uma página de relacionamentos (kind vazio = todos), ordenada por ID da outra pessoa.
func (s *Service) List(ctx context.Context, userID int64, kind string, after int64, limit int) (RelationshipPage, error) {
	ctx, span := tracer.Start(ctx, "relationship.List")
	defer span.End()
	if kind != "" && !Kind(kind).valid() {
		return RelationshipPage{}, ErrInvalidKind
	}
	if limit <= 0 {
		limit = DefaultPageSize
	}
	limit = min(limit, MaxPageSize)
	rows, err := s.store.List(ctx, userID, Kind(kind), after, limit+1)
	if err != nil {
		return RelationshipPage{}, err
	}
	page := RelationshipPage{}
	if len(rows) > limit {
		rows = rows[:limit]
		next := idStr(rows[len(rows)-1].OtherID)
		page.NextAfter = &next
	}
	page.Items = s.payloads(ctx, rows)
	return page, nil
}

// Ready monta o resumo do READY.
func (s *Service) Ready(ctx context.Context, userID int64) (RelationshipsReady, error) {
	ctx, span := tracer.Start(ctx, "relationship.Ready")
	defer span.End()
	rows, blocked, counts, err := s.store.Ready(ctx, userID, MaxReadyItems+1)
	if err != nil {
		return RelationshipsReady{}, err
	}
	out := RelationshipsReady{
		FriendCount: counts.Friends, IncomingCount: counts.Incoming, OutgoingCount: counts.Outgoing,
		BlockedIDs: make([]string, len(blocked)),
	}
	for i, id := range blocked {
		out.BlockedIDs[i] = idStr(id)
	}
	if len(rows) > MaxReadyItems {
		rows, out.Truncated = rows[:MaxReadyItems], true
	}
	out.Items = s.payloads(ctx, rows)
	return out, nil
}

// Get devolve o relacionamento de userID com other (um só endpoint para o cartão de perfil). O bloqueio de
// other contra userID nunca aparece aqui.
func (s *Service) Get(ctx context.Context, userID, other int64) (RelationshipState, error) {
	ctx, span := tracer.Start(ctx, "relationship.Get")
	defer span.End()
	if _, err := s.store.Brief(ctx, other); err != nil {
		return RelationshipState{}, err
	}
	kind, since, err := s.store.Get(ctx, userID, other)
	if err != nil {
		return RelationshipState{}, err
	}
	st := RelationshipState{UserID: idStr(other), Type: string(kind)}
	if kind != KindNone {
		st.Since = &since
	}
	return st, nil
}

// ---- consultas das outras features ----

// FriendsAmong devolve, dos candidatos, quem é amigo aceito de userID.
func (s *Service) FriendsAmong(ctx context.Context, userID int64, candidates []int64) ([]int64, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	return s.store.FriendsAmong(ctx, userID, candidates)
}

// BlockedAmong devolve, dos candidatos, quem tem bloqueio com userID em qualquer sentido.
func (s *Service) BlockedAmong(ctx context.Context, userID int64, candidates []int64) ([]int64, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	return s.store.BlockedAmong(ctx, userID, candidates)
}

// BlockersOf devolve, dos candidatos, quem BLOQUEOU userID (para não notificá-los de menções e mensagens dele).
func (s *Service) BlockersOf(ctx context.Context, userID int64, candidates []int64) ([]int64, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	return s.store.BlockersAmong(ctx, userID, candidates)
}

// PairBlocked diz se os dois participantes de uma DM 1:1 têm bloqueio entre si (qualquer sentido).
func (s *Service) PairBlocked(ctx context.Context, channelID int64) (bool, error) {
	return s.store.DMPairBlocked(ctx, channelID)
}
