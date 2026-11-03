package voice

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/riverqueue/river"
)

// ReconcileArgs é o job periódico `voice_reconcile`: confere o estado de voz em memória com o LiveKit.
type ReconcileArgs struct{}

func (ReconcileArgs) Kind() string { return "voice_reconcile" }

// ReconcileEvery é o intervalo do job.
const ReconcileEvery = time.Minute

// Reconciler é o que o worker precisa do service (permite o service ser ligado depois do client do River).
type Reconciler interface {
	Reconcile(ctx context.Context) error
}

type ReconcileWorker struct {
	river.WorkerDefaults[ReconcileArgs]
	rec Reconciler
}

// Work não devolve erro quando o LiveKit está fora do ar: o próximo minuto tenta de novo e uma fila de
// retentativas só empilharia rodadas iguais. A falha fica no log e na métrica spook.voice.reconcile.runs.
func (w *ReconcileWorker) Work(ctx context.Context, _ *river.Job[ReconcileArgs]) error {
	if w.rec == nil {
		return nil
	}
	if err := w.rec.Reconcile(ctx); err != nil && !errors.Is(err, ErrDisabled) {
		slog.Warn("voice: reconciliação falhou (segue no próximo minuto)", "err", err)
	}
	return nil
}

// RegisterWorkers registra o worker do reconciliador.
func RegisterWorkers(w *river.Workers, rec Reconciler) {
	river.AddWorker(w, &ReconcileWorker{rec: rec})
}

// PeriodicJobs são os jobs agendados da voz. Sem retentativa: o job é uma rodada de uma fotografia.
func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(ReconcileEvery),
			func() (river.JobArgs, *river.InsertOpts) { return ReconcileArgs{}, &river.InsertOpts{MaxAttempts: 1} },
			&river.PeriodicJobOpts{ID: "voice_reconcile"}),
	}
}
