package message

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// ThumbnailEnqueuer enfileira os jobs de thumbnail na transação que cria a mensagem (River).
type ThumbnailEnqueuer interface {
	EnqueueThumbnails(ctx context.Context, tx pgx.Tx, attachmentIDs []int64) error
}

type PGStore struct {
	d    db.DB
	q    *dbgen.Queries
	jobs ThumbnailEnqueuer // nil = sem thumbnails
}

func NewStore(d db.DB, jobs ThumbnailEnqueuer) *PGStore {
	return &PGStore{d: d, q: dbgen.New(d), jobs: jobs}
}

func edited(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}

func build(id, channelID, authorID int64, content string, editedAt pgtype.Timestamptz, mentions []int64, username string, display, avatar *string) Message {
	return Message{
		ID: id, ChannelID: channelID, Content: content, EditedAt: edited(editedAt), MentionIDs: mentions,
		Author: Author{ID: authorID, Username: username, DisplayName: display, AvatarKey: avatar},
	}
}

// mentionIDs nunca devolve nil (a coluna é NOT NULL).
func mentionIDs(ids []int64) []int64 {
	if ids == nil {
		return []int64{}
	}
	return ids
}

func (s *PGStore) Insert(ctx context.Context, p InsertParams) (Message, []attachment.Attachment, error) {
	if len(p.AttachmentIDs) == 0 {
		r, err := s.q.InsertMessage(ctx, dbgen.InsertMessageParams{ID: p.ID, ChannelID: p.ChannelID, AuthorID: p.AuthorID, Content: p.Content, MentionIds: mentionIDs(p.MentionIDs)})
		if err != nil {
			return Message{}, nil, fmt.Errorf("gravar mensagem: %w", err)
		}
		return build(r.ID, r.ChannelID, r.AuthorID, r.Content, r.EditedAt, r.MentionIds, r.Username, r.DisplayName, r.AvatarKey), nil, nil
	}
	return s.insertWithAttachments(ctx, p)
}

// insertWithAttachments grava a mensagem, associa os anexos e enfileira os thumbnails na MESMA transação:
// ou tudo acontece, ou nada (um anexo que deixou de ser válido desfaz a mensagem inteira).
func (s *PGStore) insertWithAttachments(ctx context.Context, p InsertParams) (Message, []attachment.Attachment, error) {
	tx, err := s.d.Begin(ctx)
	if err != nil {
		return Message{}, nil, fmt.Errorf("abrir transação: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	r, err := q.InsertMessage(ctx, dbgen.InsertMessageParams{ID: p.ID, ChannelID: p.ChannelID, AuthorID: p.AuthorID, Content: p.Content, MentionIds: mentionIDs(p.MentionIDs)})
	if err != nil {
		return Message{}, nil, fmt.Errorf("gravar mensagem: %w", err)
	}
	rows, err := q.ClaimAttachments(ctx, dbgen.ClaimAttachmentsParams{
		MessageID: &p.ID, Ids: p.AttachmentIDs, UploaderID: p.AuthorID, Since: pgtype.Timestamptz{Time: p.Since, Valid: true}, KeyPrefix: p.KeyPrefix,
	})
	if err != nil {
		return Message{}, nil, fmt.Errorf("associar anexos: %w", err)
	}
	if len(rows) != len(p.AttachmentIDs) { // outro envio levou algum, ou expirou no meio do caminho
		return Message{}, nil, attachment.ErrInvalidAttachments
	}
	atts := make([]attachment.Attachment, len(rows))
	var thumbs []int64
	for i, row := range rows {
		atts[i] = attachment.FromRow(row)
		if attachment.IsImage(row.ContentType) {
			thumbs = append(thumbs, row.ID)
		}
	}
	slices.SortFunc(atts, func(a, b attachment.Attachment) int { return cmp.Compare(a.ID, b.ID) })
	if s.jobs != nil && len(thumbs) > 0 {
		if err := s.jobs.EnqueueThumbnails(ctx, tx, thumbs); err != nil {
			return Message{}, nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, nil, fmt.Errorf("confirmar mensagem: %w", err)
	}
	return build(r.ID, r.ChannelID, r.AuthorID, r.Content, r.EditedAt, r.MentionIds, r.Username, r.DisplayName, r.AvatarKey), atts, nil
}

func (s *PGStore) Get(ctx context.Context, id, channelID int64) (Message, error) {
	r, err := s.q.GetMessage(ctx, dbgen.GetMessageParams{ID: id, ChannelID: channelID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	if err != nil {
		return Message{}, fmt.Errorf("buscar mensagem: %w", err)
	}
	return build(r.ID, r.ChannelID, r.AuthorID, r.Content, r.EditedAt, r.MentionIds, r.Username, r.DisplayName, r.AvatarKey), nil
}

func (s *PGStore) List(ctx context.Context, channelID, before int64, limit int) ([]Message, error) {
	rows, err := s.q.ListMessages(ctx, dbgen.ListMessagesParams{ChannelID: channelID, ID: before, Limit: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("listar mensagens: %w", err)
	}
	out := make([]Message, len(rows))
	for i, r := range rows {
		out[i] = build(r.ID, r.ChannelID, r.AuthorID, r.Content, r.EditedAt, r.MentionIds, r.Username, r.DisplayName, r.AvatarKey)
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
