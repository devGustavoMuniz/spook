// Package jobs configura o River (fila de jobs sobre o próprio Postgres, sem Redis): migrations,
// client e métricas. Os workers são registrados pelas features (injeção manual no app).
package jobs

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// QueueThumbnail processa as imagens; no máximo 2 jobs ao mesmo tempo (cada um decodifica uma imagem
// inteira na memória).
const QueueThumbnail = "thumbnail"

// Concorrência por fila (pequena, de propósito: o container tem pouca RAM e 1 CPU).
const (
	DefaultWorkers   = 2
	ThumbnailWorkers = 2
)

// Client é o client do River sobre pgx.
type Client = river.Client[pgx.Tx]

// Migrate aplica as migrations do River (tabelas river_*). Roda depois do goose.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	m, err := rivermigrate.New(riverpgxv5.New(pool), nil)
	if err != nil {
		return fmt.Errorf("criar migrator do River: %w", err)
	}
	if _, err := m.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		return fmt.Errorf("aplicar migrations do River: %w", err)
	}
	return nil
}

// New cria o client (ainda parado: use Start) e liga o gauge do tamanho das filas.
func New(pool *pgxpool.Pool, workers *river.Workers, periodic []*river.PeriodicJob) (*Client, error) {
	c, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: DefaultWorkers},
			QueueThumbnail:     {MaxWorkers: ThumbnailWorkers},
		},
		Workers:      workers,
		PeriodicJobs: periodic,
		Logger:       slog.New(minLevel{slog.Default().Handler(), slog.LevelWarn}),
	})
	if err != nil {
		return nil, fmt.Errorf("criar client do River: %w", err)
	}
	registerQueueGauge(pool)
	return c, nil
}

// registerQueueGauge expõe quantos jobs esperam (disponíveis, agendados ou à espera de retentativa) por fila.
func registerQueueGauge(pool *pgxpool.Pool) {
	_, _ = otel.Meter("spook/jobs").Int64ObservableGauge("spook.jobs.queue.size",
		metric.WithDescription("Jobs aguardando execução, por fila"),
		metric.WithInt64Callback(func(ctx context.Context, o metric.Int64Observer) error {
			counts := map[string]int64{river.QueueDefault: 0, QueueThumbnail: 0}
			rows, err := pool.Query(ctx, `SELECT queue, count(*) FROM river_job WHERE state IN ('available', 'scheduled', 'retryable') GROUP BY queue`)
			if err != nil {
				return nil // o gauge é opcional; erro de consulta não deve derrubar a exportação
			}
			defer rows.Close()
			for rows.Next() {
				var q string
				var n int64
				if err := rows.Scan(&q, &n); err != nil {
					return nil
				}
				counts[q] = n
			}
			for q, n := range counts {
				o.Observe(n, metric.WithAttributes(attribute.String("queue", q)))
			}
			return nil
		}))
}

// minLevel esconde os logs de debug do River (batimentos de liderança e estatísticas a cada poucos
// segundos), que inundariam o log de desenvolvimento.
type minLevel struct {
	slog.Handler
	min slog.Level
}

func (h minLevel) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= h.min && h.Handler.Enabled(ctx, l)
}
func (h minLevel) WithAttrs(a []slog.Attr) slog.Handler {
	return minLevel{h.Handler.WithAttrs(a), h.min}
}
func (h minLevel) WithGroup(n string) slog.Handler { return minLevel{h.Handler.WithGroup(n), h.min} }
