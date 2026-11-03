package admin

import (
	"context"
	"log/slog"
	"time"

	"github.com/riverqueue/river"
)

// SampleArgs é o job por minuto `livekit_sample`: grava uma amostra do LiveKit e do gateway.
type SampleArgs struct{}

func (SampleArgs) Kind() string { return "livekit_sample" }

// PurgeSamplesArgs é o job diário `livekit_samples_purge`: apaga as amostras além da retenção, em lote.
type PurgeSamplesArgs struct{}

func (PurgeSamplesArgs) Kind() string { return "livekit_samples_purge" }

// PurgeEvery é o intervalo do job de limpeza.
const PurgeEvery = 24 * time.Hour

// Sampler é o que os workers precisam do service (ligado depois do client do River, ver app).
type Sampler interface {
	Sample(ctx context.Context) error
	PurgeSamples(ctx context.Context, retention time.Duration) (int64, error)
}

type SampleWorker struct {
	river.WorkerDefaults[SampleArgs]
	s Sampler
}

// Work: uma falha ao gravar só perde esta amostra (a próxima vem em 1 min); não há retentativa.
func (w *SampleWorker) Work(ctx context.Context, _ *river.Job[SampleArgs]) error {
	if w.s == nil {
		return nil
	}
	if err := w.s.Sample(ctx); err != nil {
		slog.Warn("admin: amostra do LiveKit não gravada", "err", err)
	}
	return nil
}

type PurgeSamplesWorker struct {
	river.WorkerDefaults[PurgeSamplesArgs]
	s         Sampler
	retention time.Duration
}

func (w *PurgeSamplesWorker) Work(ctx context.Context, _ *river.Job[PurgeSamplesArgs]) error {
	if w.s == nil {
		return nil
	}
	_, err := w.s.PurgeSamples(ctx, w.retention)
	return err
}

// RegisterWorkers registra os workers de amostragem e de retenção.
func RegisterWorkers(w *river.Workers, s Sampler, retention time.Duration) {
	river.AddWorker(w, &SampleWorker{s: s})
	river.AddWorker(w, &PurgeSamplesWorker{s: s, retention: retention})
}

// PeriodicJobs são os jobs agendados do painel.
func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(SampleEvery),
			func() (river.JobArgs, *river.InsertOpts) { return SampleArgs{}, &river.InsertOpts{MaxAttempts: 1} },
			&river.PeriodicJobOpts{ID: "livekit_sample", RunOnStart: true}),
		river.NewPeriodicJob(river.PeriodicInterval(PurgeEvery),
			func() (river.JobArgs, *river.InsertOpts) { return PurgeSamplesArgs{}, nil },
			&river.PeriodicJobOpts{ID: "livekit_samples_purge", RunOnStart: true}),
	}
}
