package attachment

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/storage"
)

var tracer = otel.Tracer("spook/attachment")

// Store é o que o service precisa do banco.
type Store interface {
	Insert(ctx context.Context, a Attachment) error
	CountPending(ctx context.Context, uploaderID int64, since time.Time) (int, error)
	Pending(ctx context.Context, ids []int64, uploaderID int64, keyPrefix string, since time.Time) ([]Attachment, error)
	ByMessages(ctx context.Context, messageIDs []int64) ([]Attachment, error)
	ForThumbnail(ctx context.Context, id int64) (Attachment, int64, error)
	SetThumbnail(ctx context.Context, id int64, width, height int, key string) error
	Orphans(ctx context.Context, before time.Time, limit int) ([]Attachment, error)
	DeletePending(ctx context.Context, ids []int64) error
}

// Objects é o storage S3 genérico (nada específico do Garage).
type Objects interface {
	PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error)
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
	Stat(ctx context.Context, key string) (storage.ObjectInfo, error)
	GetRange(ctx context.Context, key string, offset, length int64) ([]byte, error)
	Get(ctx context.Context, key string, maxBytes int64) ([]byte, error)
	Put(ctx context.Context, key, contentType string, data []byte) error
	Delete(ctx context.Context, key string) error
}

// Channels autoriza o acesso ao canal (servidor: permissões; DM: participante).
type Channels interface {
	Authorize(ctx context.Context, userID, channelID int64, need perm.Perm) (channel.Channel, perm.Member, error)
}

// Limiter limita os pedidos de upload por usuário.
type Limiter interface {
	Take(key string) (ok bool, retryAfter time.Duration)
}

type IDGenerator interface{ Next() int64 }

type Service struct {
	store    Store
	objects  Objects // nil = uploads desligados
	channels Channels
	limiter  Limiter
	ids      IDGenerator
	m        *metrics
	now      func() time.Time
	maxSize  int64
}

// SetMaxFileSize troca o tamanho máximo de um anexo (LIMIT_ATTACHMENT_MB); o padrão é MaxFileSize (25 MB, SPEC 7.3).
func (s *Service) SetMaxFileSize(n int64) {
	if n > 0 {
		s.maxSize = n
	}
}

func NewService(store Store, objects Objects, channels Channels, limiter Limiter, ids IDGenerator) *Service {
	return &Service{store: store, objects: objects, channels: channels, limiter: limiter, ids: ids, m: newMetrics(), now: time.Now, maxSize: MaxFileSize}
}

// KeyPrefix é o prefixo das chaves dos anexos de um canal; é ele que prende o anexo ao canal.
func KeyPrefix(channelID int64) string { return "attachments/" + httpx.ID(channelID) + "/" }

// RequestUpload cria o anexo pendente e devolve a URL de PUT (RF10.1, passo 1).
func (s *Service) RequestUpload(ctx context.Context, userID, channelID int64, filename, contentType string, size int64) (UploadPayload, error) {
	ctx, span := tracer.Start(ctx, "attachment.RequestUpload")
	defer span.End()
	span.SetAttributes(attribute.Int64("channel.id", channelID), attribute.Int64("upload.size", size), attribute.String("upload.content_type", contentType))

	if s.objects == nil {
		return UploadPayload{}, ErrUploadsDisabled
	}
	ch, _, err := s.channels.Authorize(ctx, userID, channelID, perm.SendMessages|perm.AttachFiles)
	if err != nil {
		return UploadPayload{}, err
	}
	if ch.Type != channel.TypeText && !ch.IsDM() {
		return UploadPayload{}, apperr.Invalid("só canais de texto e DMs recebem anexos")
	}
	if ok, wait := s.limiter.Take("upload:" + httpx.ID(userID)); !ok {
		s.reject(ctx, "rate_limit")
		return UploadPayload{}, apperr.RateLimited("você está pedindo uploads rápido demais", wait)
	}
	name, err := ValidateUploadMax(filename, contentType, size, s.maxSize)
	if err != nil {
		s.reject(ctx, "invalid")
		return UploadPayload{}, err
	}
	pending, err := s.store.CountPending(ctx, userID, s.now().Add(-ClaimWindow))
	if err != nil {
		return UploadPayload{}, err
	}
	if pending >= MaxPending {
		s.reject(ctx, "too_many_pending")
		return UploadPayload{}, apperr.Conflict("muitos anexos pendentes; envie uma mensagem ou espere expirarem")
	}

	id := s.ids.Next()
	key := KeyPrefix(channelID) + httpx.ID(id) + "/" + keySafe(name)
	if err := s.store.Insert(ctx, Attachment{ID: id, UploaderID: userID, ObjectKey: key, Filename: name, ContentType: contentType, Size: size}); err != nil {
		return UploadPayload{}, err
	}
	url, err := s.objects.PresignPut(ctx, key, contentType, size, UploadTTL)
	if err != nil {
		return UploadPayload{}, err
	}
	s.m.uploads.Add(ctx, 1, metric.WithAttributes(attribute.String("content_type", contentType)))
	s.m.uploadBytes.Add(ctx, size)
	return UploadPayload{
		ID: httpx.ID(id), UploadURL: url, Headers: map[string]string{"Content-Type": contentType}, ExpiresIn: int(UploadTTL.Seconds()),
	}, nil
}

func (s *Service) reject(ctx context.Context, reason string) {
	s.m.rejected.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", reason)))
}

// Verify confere se os anexos podem entrar numa mensagem do usuário no canal: são dele, do canal,
// ainda livres e recentes; o objeto existe no storage com o tamanho declarado; e, para imagens, PDF e
// zip, os primeiros bytes batem com o tipo. Divergência de tamanho ou de conteúdo apaga o objeto.
func (s *Service) Verify(ctx context.Context, userID, channelID int64, ids []int64) error {
	ctx, span := tracer.Start(ctx, "attachment.Verify")
	defer span.End()
	span.SetAttributes(attribute.Int("attachments.count", len(ids)))
	if s.objects == nil {
		return ErrUploadsDisabled
	}
	rows, err := s.store.Pending(ctx, ids, userID, KeyPrefix(channelID), s.now().Add(-ClaimWindow))
	if err != nil {
		return err
	}
	if len(rows) != len(ids) {
		s.reject(ctx, "not_claimable")
		return ErrInvalidAttachments
	}

	errs := make([]error, len(rows))
	var wg sync.WaitGroup
	for i := range rows {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = s.verifyObject(ctx, rows[i])
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) verifyObject(ctx context.Context, a Attachment) error {
	info, err := s.objects.Stat(ctx, a.ObjectKey)
	if errors.Is(err, storage.ErrNotFound) {
		s.reject(ctx, "not_uploaded")
		return apperr.Invalid(fmt.Sprintf("o arquivo %q ainda não foi enviado ao storage", a.Filename))
	}
	if err != nil {
		return err
	}
	if info.Size != a.Size {
		s.discard(ctx, a)
		s.reject(ctx, "size_mismatch")
		return apperr.Invalid(fmt.Sprintf("o tamanho de %q não confere com o declarado", a.Filename))
	}
	if NeedsSniff(a.ContentType) {
		head, err := s.objects.GetRange(ctx, a.ObjectKey, 0, SniffLen)
		if err != nil {
			return err
		}
		if !MatchesContent(a.ContentType, head) {
			s.discard(ctx, a)
			s.reject(ctx, "content_mismatch")
			return apperr.Invalid(fmt.Sprintf("o conteúdo de %q não corresponde ao tipo %s", a.Filename, a.ContentType))
		}
	}
	return nil
}

// discard apaga o objeto e a linha de um anexo recusado (melhor esforço).
func (s *Service) discard(ctx context.Context, a Attachment) {
	ctx = context.WithoutCancel(ctx)
	if err := s.objects.Delete(ctx, a.ObjectKey); err != nil {
		slog.Warn("apagar objeto recusado", "key", a.ObjectKey, "err", err)
	}
	if err := s.store.DeletePending(ctx, []int64{a.ID}); err != nil {
		slog.Warn("apagar anexo recusado", "id", a.ID, "err", err)
	}
}

// Payloads monta os anexos para a API (com as URLs de leitura).
func (s *Service) Payloads(ctx context.Context, as []Attachment) ([]AttachmentPayload, error) {
	out := make([]AttachmentPayload, len(as))
	for i, a := range as {
		p, err := s.payload(ctx, a)
		if err != nil {
			return nil, err
		}
		out[i] = p
	}
	return out, nil
}

func (s *Service) payload(ctx context.Context, a Attachment) (AttachmentPayload, error) {
	url, err := s.objects.PresignGet(ctx, a.ObjectKey, ReadTTL)
	if err != nil {
		return AttachmentPayload{}, err
	}
	p := AttachmentPayload{ID: httpx.ID(a.ID), Filename: a.Filename, ContentType: a.ContentType, Size: a.Size, URL: url, Width: a.Width, Height: a.Height}
	if a.ThumbnailKey != nil {
		if p.ThumbnailURL, err = s.objects.PresignGet(ctx, *a.ThumbnailKey, ReadTTL); err != nil {
			return AttachmentPayload{}, err
		}
	}
	return p, nil
}

// ForMessages devolve os anexos de várias mensagens numa consulta só (sem N+1), por ID de mensagem.
func (s *Service) ForMessages(ctx context.Context, messageIDs []int64) (map[int64][]AttachmentPayload, error) {
	if s.objects == nil || len(messageIDs) == 0 {
		return nil, nil
	}
	ctx, span := tracer.Start(ctx, "attachment.ForMessages")
	defer span.End()
	rows, err := s.store.ByMessages(ctx, messageIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[int64][]AttachmentPayload, len(rows))
	for _, a := range rows {
		if a.MessageID == nil {
			continue
		}
		p, err := s.payload(ctx, a)
		if err != nil {
			return nil, err
		}
		out[*a.MessageID] = append(out[*a.MessageID], p)
	}
	return out, nil
}

// CleanupOrphans apaga os anexos sem mensagem há mais de ClaimWindow (linha e objeto). Devolve quantos.
func (s *Service) CleanupOrphans(ctx context.Context) (int, error) {
	ctx, span := tracer.Start(ctx, "attachment.CleanupOrphans")
	defer span.End()
	if s.objects == nil {
		return 0, nil
	}
	total := 0
	for {
		rows, err := s.store.Orphans(ctx, s.now().Add(-ClaimWindow), 100)
		if err != nil {
			return total, err
		}
		if len(rows) == 0 {
			break
		}
		ids := make([]int64, 0, len(rows))
		for _, a := range rows {
			if err := s.objects.Delete(ctx, a.ObjectKey); err != nil {
				return total, err
			}
			ids = append(ids, a.ID)
		}
		if err := s.store.DeletePending(ctx, ids); err != nil {
			return total, err
		}
		total += len(rows)
		if len(rows) < 100 {
			break
		}
	}
	span.SetAttributes(attribute.Int("orphans.deleted", total))
	if total > 0 {
		s.m.orphansDeleted.Add(ctx, int64(total))
		slog.Info("anexos órfãos apagados", "count", strconv.Itoa(total))
	}
	return total, nil
}
