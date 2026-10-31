package attachment

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

// ErrNotFound: o anexo (ou a mensagem dele) não existe mais.
var ErrNotFound = errors.New("anexo não encontrado")

type PGStore struct{ q *dbgen.Queries }

func NewStore(d db.DB) *PGStore { return &PGStore{q: dbgen.New(d)} }

// FromRow converte a linha do banco (também usada pelo store de mensagens, que associa anexos na transação).
func FromRow(r dbgen.Attachment) Attachment {
	return Attachment{
		ID: r.ID, MessageID: r.MessageID, UploaderID: r.UploaderID, ObjectKey: r.ObjectKey, Filename: r.Filename,
		ContentType: r.ContentType, Size: r.SizeBytes, Width: r.Width, Height: r.Height, ThumbnailKey: r.ThumbnailKey,
		CreatedAt: r.CreatedAt.Time,
	}
}

func fromRows(rs []dbgen.Attachment) []Attachment {
	out := make([]Attachment, len(rs))
	for i, r := range rs {
		out[i] = FromRow(r)
	}
	return out
}

func ts(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func (s *PGStore) Insert(ctx context.Context, a Attachment) error {
	err := s.q.InsertAttachment(ctx, dbgen.InsertAttachmentParams{
		ID: a.ID, UploaderID: a.UploaderID, ObjectKey: a.ObjectKey, Filename: a.Filename, ContentType: a.ContentType, SizeBytes: a.Size,
	})
	if err != nil {
		return fmt.Errorf("gravar anexo: %w", err)
	}
	return nil
}

func (s *PGStore) CountPending(ctx context.Context, uploaderID int64, since time.Time) (int, error) {
	n, err := s.q.CountPendingAttachments(ctx, dbgen.CountPendingAttachmentsParams{UploaderID: uploaderID, Since: ts(since)})
	if err != nil {
		return 0, fmt.Errorf("contar anexos pendentes: %w", err)
	}
	return int(n), nil
}

func (s *PGStore) Pending(ctx context.Context, ids []int64, uploaderID int64, keyPrefix string, since time.Time) ([]Attachment, error) {
	rs, err := s.q.ListPendingAttachments(ctx, dbgen.ListPendingAttachmentsParams{
		Ids: ids, UploaderID: uploaderID, Since: ts(since), KeyPrefix: keyPrefix,
	})
	if err != nil {
		return nil, fmt.Errorf("buscar anexos pendentes: %w", err)
	}
	return fromRows(rs), nil
}

func (s *PGStore) ByMessages(ctx context.Context, messageIDs []int64) ([]Attachment, error) {
	rs, err := s.q.ListAttachmentsByMessages(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("listar anexos das mensagens: %w", err)
	}
	return fromRows(rs), nil
}

// ForThumbnail devolve o anexo e o canal da mensagem dele.
func (s *PGStore) ForThumbnail(ctx context.Context, id int64) (Attachment, int64, error) {
	r, err := s.q.GetAttachmentForThumbnail(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Attachment{}, 0, ErrNotFound
	}
	if err != nil {
		return Attachment{}, 0, fmt.Errorf("buscar anexo: %w", err)
	}
	return Attachment{
		ID: r.ID, MessageID: r.MessageID, UploaderID: r.UploaderID, ObjectKey: r.ObjectKey, Filename: r.Filename,
		ContentType: r.ContentType, Size: r.SizeBytes, Width: r.Width, Height: r.Height, ThumbnailKey: r.ThumbnailKey,
		CreatedAt: r.CreatedAt.Time,
	}, r.ChannelID, nil
}

func (s *PGStore) SetThumbnail(ctx context.Context, id int64, width, height int, key string) error {
	w, h := int32(width), int32(height)
	n, err := s.q.SetAttachmentThumbnail(ctx, dbgen.SetAttachmentThumbnailParams{ID: id, Width: &w, Height: &h, ThumbnailKey: &key})
	if err != nil {
		return fmt.Errorf("gravar thumbnail: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PGStore) Orphans(ctx context.Context, before time.Time, limit int) ([]Attachment, error) {
	rs, err := s.q.ListOrphanAttachments(ctx, dbgen.ListOrphanAttachmentsParams{Before: ts(before), MaxRows: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("listar anexos órfãos: %w", err)
	}
	return fromRows(rs), nil
}

// DeletePending apaga as linhas ainda sem mensagem.
func (s *PGStore) DeletePending(ctx context.Context, ids []int64) error {
	if _, err := s.q.DeleteAttachments(ctx, ids); err != nil {
		return fmt.Errorf("apagar anexos: %w", err)
	}
	return nil
}
