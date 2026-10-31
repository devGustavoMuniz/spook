// Comando spook: wiring de configuração, dependências e start do servidor.
//
// Subcomandos: (nenhum) inicia o servidor; `openapi` imprime o contrato OpenAPI;
// `healthcheck` consulta /healthz local (usado pelo HEALTHCHECK do container).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/app"
	"github.com/devGustavoMuniz/spook/server/internal/platform/config"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/logger"
	"github.com/devGustavoMuniz/spook/server/internal/platform/migrate"
	"github.com/devGustavoMuniz/spook/server/internal/platform/storage"
	"github.com/devGustavoMuniz/spook/server/internal/platform/telemetry"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

func main() {
	var err error
	switch {
	case len(os.Args) > 1 && os.Args[1] == "openapi":
		err = printOpenAPI()
	case len(os.Args) > 1 && os.Args[1] == "healthcheck":
		err = healthcheck()
	default:
		err = run()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro fatal:", err)
		os.Exit(1)
	}
}

func printOpenAPI() error {
	y, err := app.OpenAPIYAML()
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(y)
	return err
}

func healthcheck() error {
	addr := os.Getenv("SPOOK_ADDR")
	if addr == "" {
		addr = ":8090"
	}
	if addr[0] == ':' {
		addr = "127.0.0.1" + addr
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz = %d", resp.StatusCode)
	}
	return nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := logger.New(cfg.Env)
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	shutdownTelemetry, err := telemetry.Setup(ctx, cfg.OTLPEndpoint, "spook")
	if err != nil {
		return err
	}

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := migrate.Up(ctx, pool); err != nil {
		return err
	}

	var avatars app.Storage // interface nil = upload desligado
	if cfg.S3.Enabled() {
		s, err := storage.New(ctx, storage.Config{
			Endpoint: cfg.S3.Endpoint, Region: cfg.S3.Region, Bucket: cfg.S3.Bucket,
			AccessKeyID: cfg.S3.AccessKeyID, SecretAccessKey: cfg.S3.SecretAccessKey,
		})
		if err != nil {
			return err
		}
		avatars = s
	}

	a, err := app.Build(ctx, app.Deps{Cfg: cfg, Pool: pool, Storage: avatars, Presence: presence.Config{OfflineGrace: cfg.PresenceOfflineGrace}})
	if err != nil {
		return err
	}
	srv := &http.Server{Addr: cfg.Addr, Handler: a.Handler, ReadHeaderTimeout: 5 * time.Second}

	errCh := make(chan error, 1)
	go func() {
		log.Info("servidor iniciado", "addr", cfg.Addr, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	log.Info("encerrando")
	// O gateway fecha as conexões WebSocket com 1001 (o http.Server não espera conexões hijacked).
	if err := a.Gateway.Shutdown(shutdownCtx); err != nil {
		log.Warn("gateway não encerrou a tempo", "err", err)
	}
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	return shutdownTelemetry(shutdownCtx)
}
