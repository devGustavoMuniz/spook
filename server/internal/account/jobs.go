package account

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

// PurgeFilesArgs é o job que apaga do S3 os arquivos de uma conta excluída (avatar e banner).
type PurgeFilesArgs struct {
	Keys []string `json:"keys"`
}

func (PurgeFilesArgs) Kind() string { return "account_purge_files" }
func (PurgeFilesArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: river.QueueDefault, MaxAttempts: 5}
}

// ObjectDeleter é o que o worker precisa do storage.
type ObjectDeleter interface {
	Delete(ctx context.Context, key string) error
}

// Enqueuer insere o job na transação da exclusão. O client do River só existe depois dos workers,
// então é ligado depois (Set).
type Enqueuer struct{ client *river.Client[pgx.Tx] }

func (e *Enqueuer) Set(c *river.Client[pgx.Tx]) { e.client = c }

// Enqueue é um EnqueueFunc; sem client (jobs desligados) não faz nada.
func (e *Enqueuer) Enqueue(ctx context.Context, tx pgx.Tx, keys []string) error {
	if e == nil || e.client == nil || len(keys) == 0 {
		return nil
	}
	if _, err := e.client.InsertTx(ctx, tx, PurgeFilesArgs{Keys: keys}, nil); err != nil {
		return fmt.Errorf("enfileirar remoção de arquivos: %w", err)
	}
	return nil
}

type PurgeFilesWorker struct {
	river.WorkerDefaults[PurgeFilesArgs]
	objects ObjectDeleter
}

// RegisterWorkers registra o worker de remoção de arquivos.
func RegisterWorkers(w *river.Workers, objects ObjectDeleter) {
	river.AddWorker(w, &PurgeFilesWorker{objects: objects})
}

// Work apaga cada chave; o Delete do storage é idempotente (chave ausente não é erro).
func (w *PurgeFilesWorker) Work(ctx context.Context, job *river.Job[PurgeFilesArgs]) error {
	ctx, span := tracer.Start(ctx, "account.purge_files")
	defer span.End()
	var firstErr error
	for _, k := range job.Args.Keys {
		if err := w.objects.Delete(ctx, k); err != nil {
			slog.Warn("apagar arquivo de conta excluída", "key", k, "err", err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}
