package notification

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
)

// PushArgs é o job que entrega UMA notificação a UMA inscrição. Não carrega o texto da mensagem (os
// jobs concluídos ficam na tabela do River): o worker lê a mensagem na hora do envio, e uma mensagem
// apagada nesse meio tempo não gera push. Até 3 tentativas para falhas transitórias.
type PushArgs struct {
	SubscriptionID int64 `json:"subscription_id"`
	MessageID      int64 `json:"message_id"`
	ChannelID      int64 `json:"channel_id"`
}

func (PushArgs) Kind() string { return "push" }
func (PushArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueuePush, MaxAttempts: 3}
}

// PushQueue enfileira os jobs de push.
type PushQueue interface {
	EnqueuePush(ctx context.Context, args []PushArgs) error
}

// Enqueuer implementa PushQueue sobre o River. O client só existe depois de montar os workers, então é
// ligado depois (Set).
type Enqueuer struct {
	client atomic.Pointer[river.Client[pgx.Tx]]
}

func (e *Enqueuer) Set(c *river.Client[pgx.Tx]) { e.client.Store(c) }

func (e *Enqueuer) EnqueuePush(ctx context.Context, args []PushArgs) error {
	c := e.client.Load()
	if c == nil || len(args) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(args))
	for i, a := range args {
		params[i] = river.InsertManyParams{Args: a}
	}
	if _, err := c.InsertMany(ctx, params); err != nil {
		return fmt.Errorf("enfileirar push: %w", err)
	}
	return nil
}

// RegisterWorkers registra o worker de push (só chame com o push ligado).
func RegisterWorkers(w *river.Workers, svc *Service) {
	river.AddWorker(w, &PushWorker{svc: svc})
}

type PushWorker struct {
	river.WorkerDefaults[PushArgs]
	svc *Service
}

// Resultados do job (rótulo da métrica spook.push.jobs).
const (
	resSent    = "sent"
	resRemoved = "removed" // inscrição apagada (404/410 do serviço de push, ou destino bloqueado)
	resFailed  = "failed"
	resSkipped = "skipped" // usuário voltou a ficar online, mensagem apagada ou inscrição já removida
)

// Work envia a notificação. 404/410 e destino bloqueado removem a inscrição; 429/5xx/timeout retentam
// (backoff do River, no máximo 3 tentativas); 4xx definitivo cancela sem retentar.
func (w *PushWorker) Work(ctx context.Context, job *river.Job[PushArgs]) error {
	ctx, span := tracer.Start(ctx, "notification.push")
	defer span.End()
	span.SetAttributes(attribute.Int64("subscription.id", job.Args.SubscriptionID), attribute.Int("job.attempt", job.Attempt))
	start := time.Now()

	res, err := w.svc.deliver(ctx, job.Args)
	switch {
	case err != nil && res == resFailed && errors.Is(err, errPermanent):
		slog.Warn("push recusado pelo serviço de push", "subscription", job.Args.SubscriptionID, "err", err)
		span.SetStatus(codes.Error, err.Error())
		err = river.JobCancel(err)
	case err != nil:
		slog.Warn("push falhou", "subscription", job.Args.SubscriptionID, "attempt", job.Attempt, "err", err)
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	attrs := metric.WithAttributes(attribute.String("result", res))
	w.svc.m.pushJobs.Add(ctx, 1, attrs)
	w.svc.m.pushDur.Record(ctx, time.Since(start).Seconds(), attrs)
	span.SetAttributes(attribute.String("job.result", res))
	return err
}
