// Package app monta a aplicação HTTP: injeção de dependência manual e roteamento.
package app

import (
	"context"
	"net/http"
	"net/http/pprof"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/devGustavoMuniz/spook/server/internal/auth"
	"github.com/devGustavoMuniz/spook/server/internal/health"
	"github.com/devGustavoMuniz/spook/server/internal/platform/config"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/platform/servertiming"
	"github.com/devGustavoMuniz/spook/server/internal/platform/snowflake"
	"github.com/devGustavoMuniz/spook/server/internal/platform/webui"
	"github.com/devGustavoMuniz/spook/server/internal/user"
)

// Pool é o que a aplicação precisa do pgxpool.
type Pool interface {
	dbgen.DBTX
	Ping(ctx context.Context) error
}

type Deps struct {
	Cfg     config.Config
	Pool    Pool
	Storage user.AvatarStorage // nil desliga o upload de avatar
}

// New monta o handler HTTP completo. ctx controla as goroutines de manutenção.
func New(ctx context.Context, d Deps) (http.Handler, error) {
	ids, err := snowflake.New(d.Cfg.NodeID)
	if err != nil {
		return nil, err
	}

	userSvc := user.NewService(user.NewStore(d.Pool), d.Storage, ids)
	authSvc, err := auth.NewService(ctx, userSvc, auth.NewStore(d.Pool), auth.NewHasher(4), ids)
	if err != nil {
		return nil, err
	}
	authSvc.StartJanitor(ctx, time.Hour)

	userH := user.NewHandler(userSvc, auth.UserID)
	authH := auth.NewHandler(authSvc, !d.Cfg.IsDev(), userH.View)

	authLimiter := ratelimit.New(10.0/60, 10) // 10 tentativas por minuto por IP em /api/auth/*
	apiLimiter := ratelimit.New(30, 90)
	startCleanup(ctx, authLimiter, apiLimiter)

	r := chi.NewRouter()
	r.Use(servertiming.Middleware) // primeiro: mede tudo, inclusive o rate limit
	r.Use(middleware.RequestID, middleware.Recoverer)
	r.Use(limitByPath(d.Cfg.RealIPHeader, authLimiter, apiLimiter))

	healthH := health.NewHandler(d.Pool)
	r.Method(http.MethodGet, "/healthz", healthH)
	r.Method(http.MethodGet, "/api/healthz", healthH)

	registerAPI(r, d.Cfg.IsDev(), authH, userH)

	if d.Cfg.IsDev() {
		r.HandleFunc("/debug/pprof/", pprof.Index)
		r.HandleFunc("/debug/pprof/profile", pprof.Profile)
		r.HandleFunc("/debug/pprof/trace", pprof.Trace)
		r.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
		r.Handle("/debug/pprof/{name}", http.HandlerFunc(pprof.Index))
	}
	if d.Cfg.WebDir != "" {
		r.NotFound(webui.Handler(d.Cfg.WebDir).ServeHTTP)
	}

	// Cada requisição vira um span (RNF02).
	return otelhttp.NewHandler(r, "http.server",
		otelhttp.WithSpanNameFormatter(func(_ string, req *http.Request) string {
			return req.Method + " " + req.URL.Path
		})), nil
}

// OpenAPIYAML gera o contrato da API sem precisar de banco (usado por `spook openapi`).
func OpenAPIYAML() ([]byte, error) {
	api := registerAPI(chi.NewRouter(), false, auth.NewHandler(nil, true, nil), user.NewHandler(nil, nil))
	return api.OpenAPI().YAML()
}

func registerAPI(r chi.Router, dev bool, authH *auth.Handler, userH *user.Handler) huma.API {
	cfg := huma.DefaultConfig("Spook API", "0.1.0")
	cfg.CreateHooks = nil // sem o campo "$schema" nas respostas
	cfg.OpenAPIPath = "/api/openapi"
	cfg.DocsPath = ""
	if dev {
		cfg.DocsPath = "/api/docs"
	}
	cfg.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		"cookieAuth": {Type: "apiKey", In: "cookie", Name: auth.CookieName},
		"bearerAuth": {Type: "http", Scheme: "bearer"},
	}
	api := humachi.New(r, cfg)

	authed := huma.Middlewares{authH.Middleware(api)}
	authH.Register(api, authed)
	userH.Register(api, authed, auth.Security)
	return api
}

func limitByPath(realIPHeader string, authL, apiL *ratelimit.Limiter) func(http.Handler) http.Handler {
	authMW := ratelimit.Middleware(authL, realIPHeader)
	apiMW := ratelimit.Middleware(apiL, realIPHeader)
	return func(next http.Handler) http.Handler {
		authNext, apiNext := authMW(next), apiMW(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasPrefix(r.URL.Path, "/api/auth/"):
				authNext.ServeHTTP(w, r)
			case strings.HasPrefix(r.URL.Path, "/api/"):
				apiNext.ServeHTTP(w, r)
			default:
				next.ServeHTTP(w, r)
			}
		})
	}
}

func startCleanup(ctx context.Context, ls ...*ratelimit.Limiter) {
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				for _, l := range ls {
					l.Cleanup(10 * time.Minute)
				}
			}
		}
	}()
}
