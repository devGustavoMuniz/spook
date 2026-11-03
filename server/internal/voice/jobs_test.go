package voice

import (
	"context"
	"errors"
	"testing"

	"github.com/riverqueue/river"
)

type fakeRec struct {
	n   int
	err error
}

func (f *fakeRec) Reconcile(context.Context) error { f.n++; return f.err }

// O worker nunca devolve erro: LiveKit fora do ar vira log + métrica, e o próximo minuto tenta de novo (uma
// fila de retentativas só empilharia rodadas iguais).
func TestReconcileWorkerToleratesLiveKitDown(t *testing.T) {
	r := &fakeRec{err: errors.New("livekit fora do ar")}
	w := &ReconcileWorker{rec: r}
	if err := w.Work(context.Background(), &river.Job[ReconcileArgs]{}); err != nil || r.n != 1 {
		t.Fatalf("Work = %v (chamadas %d)", err, r.n)
	}
	if err := (&ReconcileWorker{}).Work(context.Background(), &river.Job[ReconcileArgs]{}); err != nil {
		t.Fatal(err)
	}
	if len(PeriodicJobs()) != 1 || (ReconcileArgs{}).Kind() != "voice_reconcile" || ReconcileEvery.Seconds() != 60 {
		t.Fatal("o job periódico deveria ser o voice_reconcile de 60 s")
	}
}
