package dm

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

type PGStore struct {
	db db.DB
	q  *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{db: d, q: dbgen.New(d)} }

func wrap(op string, err error) error { return fmt.Errorf("%s: %w", op, err) }

func (s *PGStore) SharingGuild(ctx context.Context, userID int64, candidates []int64) ([]int64, error) {
	ids, err := s.q.ListUsersSharingGuild(ctx, dbgen.ListUsersSharingGuildParams{UserID: userID, Column2: candidates})
	if err != nil {
		return nil, wrap("verificar servidores em comum", err)
	}
	return ids, nil
}

func (s *PGStore) OpenPair(ctx context.Context, a, b, newID int64) (channel.Channel, bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return channel.Channel{}, false, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	row, err := q.InsertDMChannel(ctx, dbgen.InsertDMChannelParams{ID: newID, Type: int16(channel.TypeDM)})
	if err != nil {
		return channel.Channel{}, false, wrap("criar DM", err)
	}
	// Reserva o par: se outra criação já o tem (ou está prestes a confirmar), o INSERT espera e
	// termina sem linha; o canal recém-criado é descartado e devolvemos o vencedor.
	n, err := q.InsertDMPair(ctx, dbgen.InsertDMPairParams{UserA: a, UserB: b, ChannelID: newID})
	if err != nil {
		return channel.Channel{}, false, wrap("reservar par de DM", err)
	}
	if n == 0 {
		_ = tx.Rollback(ctx)
		existing, err := s.q.GetDMPairChannel(ctx, dbgen.GetDMPairChannelParams{UserA: a, UserB: b})
		if err != nil {
			return channel.Channel{}, false, wrap("buscar DM existente", err)
		}
		return channel.FromRow(existing), false, nil
	}
	for _, u := range []int64{a, b} {
		if _, err := q.InsertRecipient(ctx, dbgen.InsertRecipientParams{ChannelID: newID, UserID: u}); err != nil {
			return channel.Channel{}, false, wrap("adicionar participante", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return channel.Channel{}, false, wrap("confirmar transação", err)
	}
	return channel.FromRow(row), true, nil
}

func (s *PGStore) CreateGroup(ctx context.Context, id, owner int64, recipients []int64) (channel.Channel, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return channel.Channel{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	row, err := q.InsertDMChannel(ctx, dbgen.InsertDMChannelParams{ID: id, Type: int16(channel.TypeGroupDM), OwnerID: &owner})
	if err != nil {
		return channel.Channel{}, wrap("criar DM em grupo", err)
	}
	for _, u := range recipients {
		if _, err := q.InsertRecipient(ctx, dbgen.InsertRecipientParams{ChannelID: id, UserID: u}); err != nil {
			return channel.Channel{}, wrap("adicionar participante", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return channel.Channel{}, wrap("confirmar transação", err)
	}
	return channel.FromRow(row), nil
}

func (s *PGStore) Get(ctx context.Context, id int64) (channel.Channel, error) {
	r, err := s.q.GetChannel(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return channel.Channel{}, channel.ErrNotFound
	}
	if err != nil {
		return channel.Channel{}, wrap("buscar canal", err)
	}
	return channel.FromRow(r), nil
}

func (s *PGStore) Recipients(ctx context.Context, channelIDs []int64) (map[int64][]channel.Recipient, error) {
	rows, err := s.q.ListRecipientsByChannels(ctx, channelIDs)
	if err != nil {
		return nil, wrap("listar participantes", err)
	}
	out := map[int64][]channel.Recipient{}
	for _, r := range rows {
		out[r.ChannelID] = append(out[r.ChannelID], channel.Recipient{
			ID: r.UserID, Username: r.Username, DisplayName: r.DisplayName, AvatarKey: r.AvatarKey, Plan: r.Plan,
		})
	}
	return out, nil
}

func (s *PGStore) ListByUser(ctx context.Context, userID int64) ([]channel.Channel, error) {
	rows, err := s.q.ListDMChannelsByUser(ctx, userID)
	if err != nil {
		return nil, wrap("listar DMs", err)
	}
	out := make([]channel.Channel, len(rows))
	for i, r := range rows {
		out[i] = channel.FromRow(r)
	}
	return out, nil
}

func (s *PGStore) AddRecipient(ctx context.Context, channelID, userID int64, max int) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if _, err := q.LockChannel(ctx, channelID); err != nil {
		return false, wrap("travar canal", err)
	}
	already, err := q.IsRecipient(ctx, dbgen.IsRecipientParams{ChannelID: channelID, UserID: userID})
	if err != nil {
		return false, wrap("verificar participante", err)
	}
	if already {
		return false, nil
	}
	count, err := q.CountRecipients(ctx, channelID)
	if err != nil {
		return false, wrap("contar participantes", err)
	}
	if count >= int64(max) {
		return false, ErrGroupFull
	}
	if _, err := q.InsertRecipient(ctx, dbgen.InsertRecipientParams{ChannelID: channelID, UserID: userID}); err != nil {
		return false, wrap("adicionar participante", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, wrap("confirmar transação", err)
	}
	return true, nil
}

func (s *PGStore) RemoveRecipient(ctx context.Context, channelID, userID int64) (bool, error) {
	n, err := s.q.DeleteRecipient(ctx, dbgen.DeleteRecipientParams{ChannelID: channelID, UserID: userID})
	if err != nil {
		return false, wrap("remover participante", err)
	}
	return n > 0, nil
}

func (s *PGStore) Rename(ctx context.Context, id int64, name string) (channel.Channel, error) {
	r, err := s.q.UpdateDMName(ctx, dbgen.UpdateDMNameParams{ID: id, Name: &name})
	if errors.Is(err, pgx.ErrNoRows) {
		return channel.Channel{}, channel.ErrNotFound
	}
	if err != nil {
		return channel.Channel{}, wrap("renomear DM", err)
	}
	return channel.FromRow(r), nil
}

func (s *PGStore) IsRecipient(ctx context.Context, channelID, userID int64) (bool, error) {
	ok, err := s.q.IsRecipient(ctx, dbgen.IsRecipientParams{ChannelID: channelID, UserID: userID})
	if err != nil {
		return false, wrap("verificar participante", err)
	}
	return ok, nil
}
