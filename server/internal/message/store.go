package message

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

type PGStore struct{ q *dbgen.Queries }

func NewStore(d db.DB) *PGStore { return &PGStore{q: dbgen.New(d)} }

func edited(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}

func build(id, channelID, authorID int64, content string, editedAt pgtype.Timestamptz, username string, display, avatar *string) Message {
	return Message{
		ID: id, ChannelID: channelID, Content: content, EditedAt: edited(editedAt),
		Author: Author{ID: authorID, Username: username, DisplayName: display, AvatarKey: avatar},
	}
}

func (s *PGStore) Insert(ctx context.Context, id, channelID, authorID int64, content string) (Message, error) {
	r, err := s.q.InsertMessage(ctx, dbgen.InsertMessageParams{ID: id, ChannelID: channelID, AuthorID: authorID, Content: content})
	if err != nil {
		return Message{}, fmt.Errorf("gravar mensagem: %w", err)
	}
	return build(r.ID, r.ChannelID, r.AuthorID, r.Content, r.EditedAt, r.Username, r.DisplayName, r.AvatarKey), nil
}

func (s *PGStore) Get(ctx context.Context, id, channelID int64) (Message, error) {
	r, err := s.q.GetMessage(ctx, dbgen.GetMessageParams{ID: id, ChannelID: channelID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	if err != nil {
		return Message{}, fmt.Errorf("buscar mensagem: %w", err)
	}
	return build(r.ID, r.ChannelID, r.AuthorID, r.Content, r.EditedAt, r.Username, r.DisplayName, r.AvatarKey), nil
}

func (s *PGStore) List(ctx context.Context, channelID, before int64, limit int) ([]Message, error) {
	rows, err := s.q.ListMessages(ctx, dbgen.ListMessagesParams{ChannelID: channelID, ID: before, Limit: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("listar mensagens: %w", err)
	}
	out := make([]Message, len(rows))
	for i, r := range rows {
		out[i] = build(r.ID, r.ChannelID, r.AuthorID, r.Content, r.EditedAt, r.Username, r.DisplayName, r.AvatarKey)
	}
	return out, nil
}

func (s *PGStore) UpdateContent(ctx context.Context, id, channelID int64, content string) error {
	n, err := s.q.UpdateMessageContent(ctx, dbgen.UpdateMessageContentParams{ID: id, ChannelID: channelID, Content: content})
	if err != nil {
		return fmt.Errorf("editar mensagem: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PGStore) Delete(ctx context.Context, id, channelID int64) error {
	n, err := s.q.SoftDeleteMessage(ctx, dbgen.SoftDeleteMessageParams{ID: id, ChannelID: channelID})
	if err != nil {
		return fmt.Errorf("excluir mensagem: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
