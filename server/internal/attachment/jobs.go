package attachment

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/platform/jobs"
	"github.com/devGustavoMuniz/spook/server/internal/platform/storage"
)

// ThumbnailArgs é o job que gera o thumbnail de uma imagem anexada. Enfileirado na mesma transação
// que cria a mensagem; até 3 tentativas para falhas transitórias (storage fora do ar).
type ThumbnailArgs struct {
	AttachmentID int64 `json:"attachment_id"`
}

func (ThumbnailArgs) Kind() string { return "thumbnail" }
func (ThumbnailArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueThumbnail, MaxAttempts: 3}
}

// CleanupArgs é o job periódico que apaga anexos órfãos.
type CleanupArgs struct{}

func (CleanupArgs) Kind() string { return "attachment_cleanup" }
func (CleanupArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: river.QueueDefault, MaxAttempts: 3}
}

// CleanupEvery é o intervalo da limpeza de órfãos.
const CleanupEvery = 10 * time.Minute

// Republisher republica a mensagem (MESSAGE_UPDATE com o payload completo) depois do thumbnail.
// Quem implementa é o service de mensagens; a interface evita o ciclo de importação.
type Republisher interface {
	RepublishUpdate(ctx context.Context, channelID, messageID int64) error
}

// Enqueuer enfileira os thumbnails dentro da transação que cria a mensagem. O client do River só
// existe depois de montar os workers, então ele é ligado depois (Set).
type Enqueuer struct {
	client atomic.Pointer[river.Client[pgx.Tx]]
}

func (e *Enqueuer) Set(c *river.Client[pgx.Tx]) { e.client.Store(c) }

// EnqueueThumbnails insere um job por anexo; sem client (jobs desligados) não faz nada.
func (e *Enqueuer) EnqueueThumbnails(ctx context.Context, tx pgx.Tx, attachmentIDs []int64) error {
	c := e.client.Load()
	if c == nil || len(attachmentIDs) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(attachmentIDs))
	for i, id := range attachmentIDs {
		params[i] = river.InsertManyParams{Args: ThumbnailArgs{AttachmentID: id}}
	}
	if _, err := c.InsertManyTx(ctx, tx, params); err != nil {
		return fmt.Errorf("enfileirar thumbnails: %w", err)
	}
	return nil
}

// RegisterWorkers registra os workers de anexos (thumbnail e limpeza de órfãos).
func RegisterWorkers(w *river.Workers, svc *Service, pub Republisher) {
	river.AddWorker(w, &ThumbnailWorker{svc: svc, pub: pub})
	river.AddWorker(w, &CleanupWorker{svc: svc})
}

// PeriodicJobs são os jobs agendados dos anexos.
func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(CleanupEvery),
			func() (river.JobArgs, *river.InsertOpts) { return CleanupArgs{}, nil },
			&river.PeriodicJobOpts{ID: "attachment_cleanup", RunOnStart: true}),
	}
}

type CleanupWorker struct {
	river.WorkerDefaults[CleanupArgs]
	svc *Service
}

func (w *CleanupWorker) Work(ctx context.Context, _ *river.Job[CleanupArgs]) error {
	_, err := w.svc.CleanupOrphans(ctx)
	return err
}

type ThumbnailWorker struct {
	river.WorkerDefaults[ThumbnailArgs]
	svc *Service
	pub Republisher
}

// Work gera o thumbnail. Falha irrecuperável (imagem corrompida ou grande demais, anexo sumido)
// cancela o job sem retentar; a mensagem segue com o original. Falha transitória retenta.
func (w *ThumbnailWorker) Work(ctx context.Context, job *river.Job[ThumbnailArgs]) error {
	ctx, span := tracer.Start(ctx, "attachment.thumbnail")
	defer span.End()
	span.SetAttributes(attribute.Int64("attachment.id", job.Args.AttachmentID), attribute.Int("job.attempt", job.Attempt))
	start := time.Now()

	err := w.process(ctx, job.Args.AttachmentID)
	result := "ok"
	switch {
	case err == nil:
	case errors.Is(err, errDiscard):
		result = "discarded"
		slog.Warn("thumbnail descartado", "attachment", job.Args.AttachmentID, "err", err)
		err = river.JobCancel(err)
	default:
		result = "error"
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		slog.Warn("thumbnail falhou", "attachment", job.Args.AttachmentID, "attempt", job.Attempt, "err", err)
	}
	elapsed := time.Since(start)
	attrs := metric.WithAttributes(attribute.String("result", result))
	w.svc.m.thumbJobs.Add(ctx, 1, attrs)
	w.svc.m.thumbDuration.Record(ctx, elapsed.Seconds(), attrs)
	span.SetAttributes(attribute.String("job.result", result))
	if err == nil {
		slog.Info("thumbnail gerado", "attachment", job.Args.AttachmentID, "ms", elapsed.Milliseconds())
	}
	return err
}

// errDiscard marca falhas que nenhuma nova tentativa resolve.
var errDiscard = errors.New("descartar")

func (w *ThumbnailWorker) process(ctx context.Context, id int64) error {
	s := w.svc
	if s.objects == nil {
		return fmt.Errorf("%w: storage desligado", errDiscard)
	}
	a, channelID, err := s.store.ForThumbnail(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return fmt.Errorf("%w: anexo não existe mais", errDiscard)
	}
	if err != nil {
		return err
	}
	if a.MessageID == nil || !IsImage(a.ContentType) {
		return fmt.Errorf("%w: anexo sem mensagem ou não é imagem", errDiscard)
	}

	// Já feito (retentativa depois de falhar só a publicação): apenas republica.
	if a.ThumbnailKey == nil {
		if err := w.generate(ctx, a); err != nil {
			return err
		}
	}
	return w.pub.RepublishUpdate(ctx, channelID, *a.MessageID)
}

func (w *ThumbnailWorker) generate(ctx context.Context, a Attachment) error {
	s := w.svc

	_, dl := tracer.Start(ctx, "attachment.thumbnail.download")
	data, err := s.objects.Get(ctx, a.ObjectKey, MaxFileSize)
	dl.End()
	switch {
	case errors.Is(err, storage.ErrNotFound), errors.Is(err, storage.ErrTooLarge):
		return fmt.Errorf("%w: %w", errDiscard, err)
	case err != nil:
		return err
	}

	_, rs := tracer.Start(ctx, "attachment.thumbnail.resize")
	th, err := MakeThumbnail(data)
	rs.End()
	if errors.Is(err, ErrUnprocessable) {
		return fmt.Errorf("%w: %w", errDiscard, err)
	}
	if err != nil {
		return err
	}

	key := thumbnailKey(a.ID, th.Ext)
	_, up := tracer.Start(ctx, "attachment.thumbnail.upload")
	err = s.objects.Put(ctx, key, th.ContentType, th.Data)
	up.End()
	if err != nil {
		return err
	}
	return s.store.SetThumbnail(ctx, a.ID, th.Width, th.Height, key)
}
