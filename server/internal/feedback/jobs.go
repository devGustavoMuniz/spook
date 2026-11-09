package feedback

import (
	"context"
	"time"

	"github.com/riverqueue/river"
)

// CleanupArgs é o job periódico que apaga anexos de chamados órfãos (enviados e nunca ligados a uma mensagem).
type CleanupArgs struct{}

func (CleanupArgs) Kind() string { return "ticket_attachment_cleanup" }
func (CleanupArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: river.QueueDefault, MaxAttempts: 3}
}

// CleanupEvery é o intervalo da limpeza de órfãos.
const CleanupEvery = 10 * time.Minute

// RegisterWorkers registra o worker da limpeza de órfãos.
func RegisterWorkers(w *river.Workers, svc *Service) {
	river.AddWorker(w, &CleanupWorker{svc: svc})
}

// PeriodicJobs são os jobs agendados dos anexos de chamados.
func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(CleanupEvery),
			func() (river.JobArgs, *river.InsertOpts) { return CleanupArgs{}, nil },
			&river.PeriodicJobOpts{ID: "ticket_attachment_cleanup", RunOnStart: true}),
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
