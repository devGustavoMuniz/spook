// Package migrate aplica as migrations do banco no boot: primeiro as do goose (SQL embutido no
// binário), depois as do River (tabelas da fila de jobs).
package migrate

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/devGustavoMuniz/spook/server/db/migrations"
	"github.com/devGustavoMuniz/spook/server/internal/platform/jobs"
)

// lockKey é o advisory lock que serializa o migrate: várias instâncias (ou pacotes de teste em
// paralelo) subindo juntas não disputam a criação das tabelas.
const lockKey = 0x5009_0001

func Up(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("conexão para migrar: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lockKey); err != nil {
		return fmt.Errorf("lock das migrations: %w", err)
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", lockKey) }()

	sqlDB := stdlib.OpenDBFromPool(pool)
	defer func() { _ = sqlDB.Close() }()

	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		return fmt.Errorf("criar provider goose: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("aplicar migrations: %w", err)
	}
	return jobs.Migrate(ctx, pool)
}
