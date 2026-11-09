package entitlement

import (
	"context"
	"time"

	"github.com/riverqueue/river"
)

// ExpireArgs é o job periódico que avisa quem teve o plano vencido (publica os eventos e reavalia o perfil).
type ExpireArgs struct{}

func (ExpireArgs) Kind() string { return "entitlement_expire" }
func (ExpireArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: river.QueueDefault, MaxAttempts: 3}
}

// ExpireEvery é o intervalo do job de vencimento. O plano vence na hora, com ou sem o job (concessão vencida não
// conta nas consultas); o job só leva o aviso em tempo real.
const ExpireEvery = time.Minute

// RegisterWorkers registra o worker do vencimento.
func RegisterWorkers(w *river.Workers, svc *Service) {
	river.AddWorker(w, &ExpireWorker{svc: svc})
}

// PeriodicJobs são os jobs agendados dos planos.
func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(ExpireEvery),
			func() (river.JobArgs, *river.InsertOpts) { return ExpireArgs{}, nil },
			&river.PeriodicJobOpts{ID: "entitlement_expire", RunOnStart: true}),
	}
}

type ExpireWorker struct {
	river.WorkerDefaults[ExpireArgs]
	svc *Service
}

func (w *ExpireWorker) Work(ctx context.Context, _ *river.Job[ExpireArgs]) error {
	_, err := w.svc.ExpireDue(ctx)
	return err
}
