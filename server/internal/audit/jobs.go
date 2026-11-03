package audit

import (
	"context"
	"time"

	"github.com/riverqueue/river"
)

// PurgeArgs é o job diário que apaga o registro além da retenção (AUDIT_RETENTION_DAYS).
type PurgeArgs struct{}

func (PurgeArgs) Kind() string { return "audit_purge" }

// PurgeEvery é o intervalo do job.
const PurgeEvery = 24 * time.Hour

type PurgeWorker struct {
	river.WorkerDefaults[PurgeArgs]
	svc       *Service
	retention time.Duration
}

func (w *PurgeWorker) Work(ctx context.Context, _ *river.Job[PurgeArgs]) error {
	_, err := w.svc.Purge(ctx, w.retention)
	return err
}

// RegisterWorkers registra o worker da retenção.
func RegisterWorkers(w *river.Workers, svc *Service, retention time.Duration) {
	river.AddWorker(w, &PurgeWorker{svc: svc, retention: retention})
}

// PeriodicJobs são os jobs agendados da auditoria.
func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(PurgeEvery),
			func() (river.JobArgs, *river.InsertOpts) { return PurgeArgs{}, nil },
			&river.PeriodicJobOpts{ID: "audit_purge", RunOnStart: true}),
	}
}
