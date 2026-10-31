package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
	"github.com/devGustavoMuniz/spook/server/internal/platform/servertiming"
)

// DB é o que os stores precisam do pool: consultas e transações.
type DB interface {
	dbgen.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Timed envolve o banco somando o tempo gasto nas consultas na métrica `db` do Server-Timing
// da requisição em curso (o tempo de rows.Next/Scan após Query não entra).
func Timed(inner DB) DB { return timed{inner} }

type timed struct{ DB }

func record(ctx context.Context, start time.Time) { servertiming.Add(ctx, "db", time.Since(start)) }

func (t timed) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	defer record(ctx, time.Now())
	return t.DB.Exec(ctx, sql, args...)
}

func (t timed) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	defer record(ctx, time.Now())
	return t.DB.Query(ctx, sql, args...)
}

func (t timed) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return timedRow{ctx: ctx, start: time.Now(), Row: t.DB.QueryRow(ctx, sql, args...)}
}

func (t timed) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := t.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return timedTx{Tx: tx}, nil
}

type timedRow struct {
	pgx.Row
	ctx   context.Context
	start time.Time
}

func (r timedRow) Scan(dest ...any) error {
	defer record(r.ctx, r.start)
	return r.Row.Scan(dest...)
}

type timedTx struct{ pgx.Tx }

func (t timedTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	defer record(ctx, time.Now())
	return t.Tx.Exec(ctx, sql, args...)
}

func (t timedTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	defer record(ctx, time.Now())
	return t.Tx.Query(ctx, sql, args...)
}

func (t timedTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return timedRow{ctx: ctx, start: time.Now(), Row: t.Tx.QueryRow(ctx, sql, args...)}
}
