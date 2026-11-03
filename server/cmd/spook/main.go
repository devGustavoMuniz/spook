// Comando spook: wiring de configuração, dependências e start do servidor.
//
// Subcomandos: (nenhum) inicia o servidor; `openapi` imprime o contrato OpenAPI;
// `healthcheck` consulta /healthz local (usado pelo HEALTHCHECK do container);
// `admin grant|revoke <username>|list` gerencia administradores do painel /admin;
// `admin reset-password <username>` imprime um link de redefinição de senha (uso único, 30 min).
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

	"github.com/devGustavoMuniz/spook/server/internal/admin"
	"github.com/devGustavoMuniz/spook/server/internal/app"
	"github.com/devGustavoMuniz/spook/server/internal/mailflow"
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
	case len(os.Args) > 1 && os.Args[1] == "admin":
		err = adminCommand(os.Args[2:])
	default:
		err = run()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro fatal:", err)
		os.Exit(1)
	}
}

// adminCommand liga/desliga administradores direto no banco (docker exec no container do backend).
func adminCommand(args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if len(args) > 0 && args[0] == "reset-password" {
		// NodeID próprio do comando: não colide com os IDs Snowflake do servidor em execução.
		return mailflow.RunResetPassword(ctx, pool, cfg.PublicURL, (cfg.NodeID+512)%1024, args[1:], os.Stdout)
	}
	return admin.RunCLI(ctx, pool, args, os.Stdout)
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
	switch {
	case cfg.VAPID.Partial():
		log.Warn("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VAPID_SUBJECT precisam estar todas definidas: Web Push desligado")
	case !cfg.VAPID.Enabled():
		log.Info("Web Push desligado (sem VAPID_*)")
	}

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

	switch {
	case cfg.Mail.Driver == "smtp":
		log.Info("e-mail por SMTP", "host", cfg.Mail.SMTP.Host, "port", cfg.Mail.SMTP.Port)
	case cfg.Mail.Enabled():
		log.Warn("e-mail: driver log com os fluxos ligados (MAIL_FLOWS_ON_LOG); nada é enviado de verdade")
	default:
		log.Warn("e-mail em modo degradado: sem SMTP_HOST (verificação e recuperação por e-mail desligadas; use `spook admin reset-password`)")
	}
	log.Info("login social", "google", cfg.Google.Enabled(), "discord", cfg.Discord.Enabled())

	var avatars app.Storage // interface nil = upload desligado
	if cfg.S3.Enabled() {
		s, err := storage.New(ctx, storage.Config{
			Endpoint: cfg.S3.Endpoint, InternalEndpoint: cfg.S3.InternalEndpoint, Region: cfg.S3.Region, Bucket: cfg.S3.Bucket,
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
	// Espera os jobs em andamento (thumbnails) antes de fechar o pool.
	if err := a.Close(shutdownCtx); err != nil {
		log.Warn("jobs não encerraram a tempo", "err", err)
	}
	return shutdownTelemetry(shutdownCtx)
}
