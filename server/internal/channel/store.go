package channel

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

type PGStore struct {
	db db.DB
	q  *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{db: d, q: dbgen.New(d)} }

// FromRow converte a linha do banco no tipo de domínio (usado também por quem insere canais na criação do servidor).
func FromRow(r dbgen.Channel) Channel {
	c := Channel{
		ID: r.ID, Type: Type(r.Type), GuildID: r.GuildID, ParentID: r.ParentID,
		Position: r.Position, LastMessageID: r.LastMessageID, CreatedAt: r.CreatedAt.Time, OwnerID: r.OwnerID,
	}
	if r.Name != nil {
		c.Name = *r.Name
	}
	return c
}

func (s *PGStore) Create(ctx context.Context, c Channel) (Channel, error) {
	r, err := s.q.InsertChannel(ctx, dbgen.InsertChannelParams{
		ID: c.ID, Type: int16(c.Type), GuildID: c.GuildID, ParentID: c.ParentID, Name: &c.Name, Position: c.Position,
	})
	if err != nil {
		return Channel{}, fmt.Errorf("criar canal: %w", err)
	}
	return FromRow(r), nil
}

func (s *PGStore) Get(ctx context.Context, id int64) (Channel, error) {
	r, err := s.q.GetChannel(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	if err != nil {
		return Channel{}, fmt.Errorf("buscar canal: %w", err)
	}
	return FromRow(r), nil
}

func (s *PGStore) ListByGuild(ctx context.Context, guildID int64) ([]Channel, error) {
	rows, err := s.q.ListChannelsByGuild(ctx, &guildID)
	if err != nil {
		return nil, fmt.Errorf("listar canais: %w", err)
	}
	out := make([]Channel, len(rows))
	for i, r := range rows {
		out[i] = FromRow(r)
	}
	return out, nil
}

func (s *PGStore) ListByGuilds(ctx context.Context, guildIDs []int64) (map[int64][]Channel, error) {
	rows, err := s.q.ListChannelsByGuilds(ctx, guildIDs)
	if err != nil {
		return nil, fmt.Errorf("listar canais: %w", err)
	}
	out := map[int64][]Channel{}
	for _, r := range rows {
		c := FromRow(r)
		out[*c.GuildID] = append(out[*c.GuildID], c)
	}
	return out, nil
}

func (s *PGStore) NextPosition(ctx context.Context, guildID int64) (int32, error) {
	p, err := s.q.NextChannelPosition(ctx, &guildID)
	if err != nil {
		return 0, fmt.Errorf("próxima posição: %w", err)
	}
	return p, nil
}

func (s *PGStore) Update(ctx context.Context, id int64, name string, position int32) (Channel, error) {
	cur, err := s.q.GetChannel(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	if err != nil {
		return Channel{}, fmt.Errorf("buscar canal: %w", err)
	}
	r, err := s.q.UpdateChannel(ctx, dbgen.UpdateChannelParams{ID: id, Name: &name, Position: position, ParentID: cur.ParentID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	if err != nil {
		return Channel{}, fmt.Errorf("atualizar canal: %w", err)
	}
	return FromRow(r), nil
}

// UpdatePlacements aplica posição e categoria de vários canais numa transação.
func (s *PGStore) UpdatePlacements(ctx context.Context, guildID int64, ps []Placement) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("iniciar transação: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	for _, p := range ps {
		cur, err := q.GetChannel(ctx, p.ID)
		if err != nil {
			return fmt.Errorf("buscar canal: %w", err)
		}
		if cur.GuildID == nil || *cur.GuildID != guildID {
			return ErrNotFound
		}
		if _, err := q.UpdateChannel(ctx, dbgen.UpdateChannelParams{ID: p.ID, Name: cur.Name, Position: p.Position, ParentID: p.ParentID}); err != nil {
			return fmt.Errorf("reordenar canal: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("confirmar transação: %w", err)
	}
	return nil
}

func (s *PGStore) Delete(ctx context.Context, id int64) error {
	n, err := s.q.DeleteChannel(ctx, id)
	if err != nil {
		return fmt.Errorf("excluir canal: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
