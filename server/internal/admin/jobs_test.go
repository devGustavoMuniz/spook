package admin

import (
	"context"
	"testing"
	"time"

	"github.com/riverqueue/river"
)

type fakeSampler struct{ sampled, purged int }

func (f *fakeSampler) Sample(context.Context) error { f.sampled++; return nil }
func (f *fakeSampler) PurgeSamples(context.Context, time.Duration) (int64, error) {
	f.purged++
	return 0, nil
}

func TestSampleJobsKindsAndWorkers(t *testing.T) {
	f := &fakeSampler{}
	if err := (&SampleWorker{s: f}).Work(context.Background(), &river.Job[SampleArgs]{}); err != nil || f.sampled != 1 {
		t.Fatalf("sample: %v %d", err, f.sampled)
	}
	if err := (&PurgeSamplesWorker{s: f, retention: time.Hour}).Work(context.Background(), &river.Job[PurgeSamplesArgs]{}); err != nil || f.purged != 1 {
		t.Fatalf("purge: %v %d", err, f.purged)
	}
	if (SampleArgs{}).Kind() != "livekit_sample" || (PurgeSamplesArgs{}).Kind() != "livekit_samples_purge" || SampleEvery != time.Minute {
		t.Fatal("nomes/intervalos dos jobs mudaram")
	}
	if len(PeriodicJobs()) != 2 {
		t.Fatal("2 jobs periódicos esperados")
	}
}
