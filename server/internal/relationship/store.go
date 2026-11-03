package relationship

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// PGStore implementa Store sobre o Postgres. Toda mudança de um par trava as duas linhas de usuário em ordem de
// ID (LockFriendshipUsers), então pedidos, aceites, bloqueios e os limites são serializados por par.
type PGStore struct {
	db db.DB
	q  *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{db: d, q: dbgen.New(d)} }

func wrap(op string, err error) error { return fmt.Errorf("%s: %w", op, err) }

// order devolve o par ordenado (a < b).
func order(x, y int64) (int64, int64) {
	if x > y {
		return y, x
	}
	return x, y
}

func (s *PGStore) UserByUsername(ctx context.Context, username string) (int64, error) {
	id, err := s.q.FindUserByUsername(ctx, username)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrUserNotFound
	}
	if err != nil {
		return 0, wrap("buscar usuário", err)
	}
	return id, nil
}

func (s *PGStore) Brief(ctx context.Context, id int64) (Row, error) {
	u, err := s.q.GetUserBrief(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Row{}, ErrUserNotFound
	}
	if err != nil {
		return Row{}, wrap("buscar usuário", err)
	}
	return Row{OtherID: u.ID, Username: u.Username, DisplayName: u.DisplayName, AvatarKey: u.AvatarKey}, nil
}

// Request registra o pedido de userID a other, de forma atômica e respeitando os limites.
func (s *PGStore) Request(ctx context.Context, userID, other int64) (Outcome, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := q.LockFriendshipUsers(ctx, []int64{userID, other}); err != nil {
		return 0, wrap("travar usuários", err)
	}
	switch rel, err := q.GetRelationship(ctx, dbgen.GetRelationshipParams{UserID: userID, OtherID: other}); {
	case err == nil && Kind(rel.Kind) == KindBlocked:
		return OutcomeBlockedByMe, nil
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return 0, wrap("ler relacionamento", err)
	}
	if blocked, err := q.BlockedEitherWay(ctx, dbgen.BlockedEitherWayParams{BlockerID: userID, BlockedID: other}); err != nil {
		return 0, wrap("verificar bloqueio", err)
	} else if blocked {
		return OutcomeBlockedByThem, nil
	}
	a, b := order(userID, other)
	f, err := q.GetFriendship(ctx, dbgen.GetFriendshipParams{UserA: a, UserB: b})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		n, err := q.CountOutgoingRequests(ctx, userID)
		if err != nil {
			return 0, wrap("contar pedidos", err)
		}
		if n >= MaxPendingOutgoing {
			return 0, ErrTooManyPending
		}
		if _, err := q.InsertFriendshipPending(ctx, dbgen.InsertFriendshipPendingParams{UserA: a, UserB: b, RequestedBy: userID}); err != nil {
			return 0, wrap("criar pedido", err)
		}
		return OutcomeCreated, commit(ctx, tx)
	case err != nil:
		return 0, wrap("ler amizade", err)
	case f.Status == "accepted":
		return OutcomeAlreadyFriend, nil
	case f.RequestedBy == userID:
		return OutcomePending, nil
	}
	// Pedido inverso: aceita.
	if err := s.checkFriendLimits(ctx, q, userID, other); err != nil {
		return 0, err
	}
	if _, err := q.AcceptFriendship(ctx, dbgen.AcceptFriendshipParams{UserA: a, UserB: b, RequestedBy: userID}); err != nil {
		return 0, wrap("aceitar pedido", err)
	}
	return OutcomeAccepted, commit(ctx, tx)
}

func commit(ctx context.Context, tx pgx.Tx) error {
	if err := tx.Commit(ctx); err != nil {
		return wrap("confirmar transação", err)
	}
	return nil
}

func (s *PGStore) checkFriendLimits(ctx context.Context, q *dbgen.Queries, x, y int64) error {
	for _, u := range []int64{x, y} {
		n, err := q.CountFriends(ctx, u)
		if err != nil {
			return wrap("contar amigos", err)
		}
		if n >= MaxFriends {
			return ErrTooManyFriends
		}
	}
	return nil
}

// Accept aceita o pedido que other enviou a userID.
func (s *PGStore) Accept(ctx context.Context, userID, other int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := q.LockFriendshipUsers(ctx, []int64{userID, other}); err != nil {
		return wrap("travar usuários", err)
	}
	a, b := order(userID, other)
	f, err := q.GetFriendship(ctx, dbgen.GetFriendshipParams{UserA: a, UserB: b})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (f.Status != "pending" || f.RequestedBy == userID)) {
		return ErrRequestNotFound
	}
	if err != nil {
		return wrap("ler amizade", err)
	}
	if err := s.checkFriendLimits(ctx, q, userID, other); err != nil {
		return err
	}
	if _, err := q.AcceptFriendship(ctx, dbgen.AcceptFriendshipParams{UserA: a, UserB: b, RequestedBy: userID}); err != nil {
		return wrap("aceitar pedido", err)
	}
	return commit(ctx, tx)
}

// Remove apaga a amizade ou o pedido do par (idempotente).
func (s *PGStore) Remove(ctx context.Context, userID, other int64) (RemoveResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RemoveResult{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := q.LockFriendshipUsers(ctx, []int64{userID, other}); err != nil {
		return RemoveResult{}, wrap("travar usuários", err)
	}
	res, err := s.deleteFriendship(ctx, q, userID, other)
	if err != nil {
		return RemoveResult{}, err
	}
	return res, commit(ctx, tx)
}

func (s *PGStore) deleteFriendship(ctx context.Context, q *dbgen.Queries, x, y int64) (RemoveResult, error) {
	a, b := order(x, y)
	r, err := q.DeleteFriendship(ctx, dbgen.DeleteFriendshipParams{UserA: a, UserB: b})
	if errors.Is(err, pgx.ErrNoRows) {
		return RemoveResult{}, nil
	}
	if err != nil {
		return RemoveResult{}, wrap("remover amizade", err)
	}
	return RemoveResult{Removed: true, WasAccepted: r.Status == "accepted", RequestedBy: r.RequestedBy}, nil
}

// Block grava o bloqueio e desfaz a amizade ou o pedido do par, numa transação. created é false se já bloqueava.
func (s *PGStore) Block(ctx context.Context, userID, other int64) (created bool, res RemoveResult, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, RemoveResult{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if err := q.LockFriendshipUsers(ctx, []int64{userID, other}); err != nil {
		return false, RemoveResult{}, wrap("travar usuários", err)
	}
	n, err := q.CountBlocks(ctx, userID)
	if err != nil {
		return false, RemoveResult{}, wrap("contar bloqueios", err)
	}
	rows, err := q.InsertBlock(ctx, dbgen.InsertBlockParams{BlockerID: userID, BlockedID: other})
	if err != nil {
		return false, RemoveResult{}, wrap("bloquear", err)
	}
	if rows > 0 && n >= MaxBlocks {
		return false, RemoveResult{}, ErrTooManyBlocks
	}
	if res, err = s.deleteFriendship(ctx, q, userID, other); err != nil {
		return false, RemoveResult{}, err
	}
	return rows > 0, res, commit(ctx, tx)
}

func (s *PGStore) Unblock(ctx context.Context, userID, other int64) (bool, error) {
	n, err := s.q.DeleteBlock(ctx, dbgen.DeleteBlockParams{BlockerID: userID, BlockedID: other})
	if err != nil {
		return false, wrap("desbloquear", err)
	}
	return n > 0, nil
}

func toRow(otherID int64, kind string, since time.Time, username string, dn, ak *string) Row {
	return Row{OtherID: otherID, Kind: Kind(kind), Since: since, Username: username, DisplayName: dn, AvatarKey: ak}
}

func (s *PGStore) List(ctx context.Context, userID int64, kind Kind, after int64, limit int) ([]Row, error) {
	rs, err := s.q.ListRelationships(ctx, dbgen.ListRelationshipsParams{UserID: userID, OtherID: after, Column3: string(kind), Limit: int32(limit)})
	if err != nil {
		return nil, wrap("listar relacionamentos", err)
	}
	out := make([]Row, len(rs))
	for i, r := range rs {
		out[i] = toRow(r.OtherID, r.Kind, r.Since.Time, r.Username, r.DisplayName, r.AvatarKey)
	}
	return out, nil
}

func (s *PGStore) Ready(ctx context.Context, userID int64, limit int) (rows []Row, blocked []int64, counts Counts, err error) {
	rs, err := s.q.ListRelationshipsReady(ctx, dbgen.ListRelationshipsReadyParams{UserID: userID, Limit: int32(limit)})
	if err != nil {
		return nil, nil, Counts{}, wrap("listar relacionamentos", err)
	}
	for _, r := range rs {
		rows = append(rows, toRow(r.OtherID, r.Kind, r.Since.Time, r.Username, r.DisplayName, r.AvatarKey))
	}
	if blocked, err = s.q.ListBlockedIDs(ctx, userID); err != nil {
		return nil, nil, Counts{}, wrap("listar bloqueados", err)
	}
	cs, err := s.q.CountRelationshipKinds(ctx, userID)
	if err != nil {
		return nil, nil, Counts{}, wrap("contar relacionamentos", err)
	}
	for _, c := range cs {
		switch Kind(c.Kind) {
		case KindFriend:
			counts.Friends = int(c.N)
		case KindIncoming:
			counts.Incoming = int(c.N)
		case KindOutgoing:
			counts.Outgoing = int(c.N)
		case KindBlocked:
			counts.Blocked = int(c.N)
		}
	}
	return rows, blocked, counts, nil
}

func (s *PGStore) Get(ctx context.Context, userID, other int64) (Kind, time.Time, error) {
	r, err := s.q.GetRelationship(ctx, dbgen.GetRelationshipParams{UserID: userID, OtherID: other})
	if errors.Is(err, pgx.ErrNoRows) {
		return KindNone, time.Time{}, nil
	}
	if err != nil {
		return "", time.Time{}, wrap("ler relacionamento", err)
	}
	return Kind(r.Kind), r.Since.Time, nil
}

func (s *PGStore) FriendsAmong(ctx context.Context, userID int64, candidates []int64) ([]int64, error) {
	ids, err := s.q.ListFriendsAmong(ctx, dbgen.ListFriendsAmongParams{UserA: userID, Column2: candidates})
	if err != nil {
		return nil, wrap("filtrar amigos", err)
	}
	return ids, nil
}

func (s *PGStore) BlockedAmong(ctx context.Context, userID int64, candidates []int64) ([]int64, error) {
	ids, err := s.q.ListBlockedAmong(ctx, dbgen.ListBlockedAmongParams{BlockerID: userID, Column2: candidates})
	if err != nil {
		return nil, wrap("filtrar bloqueios", err)
	}
	return ids, nil
}

func (s *PGStore) BlockersAmong(ctx context.Context, userID int64, candidates []int64) ([]int64, error) {
	ids, err := s.q.ListBlockersAmong(ctx, dbgen.ListBlockersAmongParams{BlockedID: userID, Column2: candidates})
	if err != nil {
		return nil, wrap("filtrar quem bloqueou", err)
	}
	return ids, nil
}

func (s *PGStore) DMPairBlocked(ctx context.Context, channelID int64) (bool, error) {
	ok, err := s.q.DMPairBlocked(ctx, channelID)
	if err != nil {
		return false, wrap("verificar bloqueio da DM", err)
	}
	return ok, nil
}
