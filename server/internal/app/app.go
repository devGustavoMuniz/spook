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

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/auth"
	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/dm"
	"github.com/devGustavoMuniz/spook/server/internal/gateway"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/health"
	"github.com/devGustavoMuniz/spook/server/internal/invite"
	"github.com/devGustavoMuniz/spook/server/internal/message"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/config"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/platform/servertiming"
	"github.com/devGustavoMuniz/spook/server/internal/platform/snowflake"
	"github.com/devGustavoMuniz/spook/server/internal/platform/webui"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
	"github.com/devGustavoMuniz/spook/server/internal/typing"
	"github.com/devGustavoMuniz/spook/server/internal/user"
)

// Pool é o que a aplicação precisa do pgxpool.
type Pool interface {
	dbgen.DBTX
	Ping(ctx context.Context) error
	Begin(ctx context.Context) (pgx.Tx, error)
}

type Deps struct {
	Cfg     config.Config
	Pool    Pool
	Storage Storage // nil desliga o upload de avatar e de ícone

	// Opcionais (testes): barramento de eventos e limitadores.
	Bus        *events.Bus
	APILimiter *ratelimit.Limiter // padrão: 30 req/s por IP, rajada de 90
	MsgLimiter *ratelimit.Limiter // padrão: 5 mensagens a cada 5 s por usuário e canal
	// GatewayLimiter limita os handshakes de /api/gateway por IP (padrão: 50/s, rajada de 200).
	GatewayLimiter *ratelimit.Limiter
	Gateway        gateway.Config     // tempos e limites do gateway (zero = padrões)
	Presence       presence.Config    // tolerância de offline etc. (zero = padrões; os testes usam valores curtos)
	AuthLimiter    *ratelimit.Limiter // padrão: 10 tentativas por minuto por IP em /api/auth/*
	DMLimiter      *ratelimit.Limiter // padrão: 10 DMs criadas por minuto por usuário
	TypingLimiter  *ratelimit.Limiter // padrão: 1 TYPING_START a cada 3 s por usuário e canal
}

// App é a aplicação montada: o handler HTTP e o gateway, que precisa de um desligamento próprio
// (conexões hijacked não são encerradas pelo http.Server.Shutdown).
type App struct {
	Handler  http.Handler
	Gateway  *gateway.Hub
	presence *presence.Service // acessado pelos testes de integração
}

// Storage é o storage S3 usado para avatares e ícones.
type Storage interface {
	user.AvatarStorage
	guild.Storage
}

// New monta o handler HTTP completo. ctx controla as goroutines de manutenção.
func New(ctx context.Context, d Deps) (http.Handler, error) {
	a, err := Build(ctx, d)
	if err != nil {
		return nil, err
	}
	return a.Handler, nil
}

// Build monta a aplicação. Cancelar ctx também encerra o gateway (close 1001); use
// App.Gateway.Shutdown para esperar as conexões terminarem.
func Build(ctx context.Context, d Deps) (*App, error) {
	ids, err := snowflake.New(d.Cfg.NodeID)
	if err != nil {
		return nil, err
	}

	pool := db.Timed(d.Pool) // soma o tempo de banco na métrica `db` do Server-Timing

	var avatarStorage user.AvatarStorage
	var guildStorage guild.Storage
	if d.Storage != nil { // interface nil de verdade quando o storage está desligado
		avatarStorage, guildStorage = d.Storage, d.Storage
	}
	bus := d.Bus
	if bus == nil {
		// Fila grande: o gateway é um só assinante e recebe todos os eventos em rajada.
		bus = events.NewBus(4096)
	}

	userSvc := user.NewService(user.NewStore(pool), avatarStorage, ids)
	authSvc, err := auth.NewService(ctx, userSvc, auth.NewStore(pool), auth.NewHasher(4), ids)
	if err != nil {
		return nil, err
	}
	authSvc.StartJanitor(ctx, time.Hour)

	userH := user.NewHandler(userSvc, auth.UserID)
	authH := auth.NewHandler(authSvc, !d.Cfg.IsDev(), userH.View)

	authLimiter := d.AuthLimiter
	if authLimiter == nil {
		authLimiter = ratelimit.New(10.0/60, 10) // 10 tentativas por minuto por IP em /api/auth/*
	}
	apiLimiter := d.APILimiter
	if apiLimiter == nil {
		apiLimiter = ratelimit.New(30, 90)
	}
	msgLimiter := d.MsgLimiter
	if msgLimiter == nil {
		msgLimiter = ratelimit.New(1, 5) // 5 mensagens a cada 5 s (SPEC 7.3)
	}

	dmLimiter := d.DMLimiter
	if dmLimiter == nil {
		dmLimiter = ratelimit.New(10.0/60, 10) // 10 criações por minuto (SPEC 7.4)
	}
	typingLimiter := d.TypingLimiter
	if typingLimiter == nil {
		typingLimiter = ratelimit.New(1/typing.Throttle.Seconds(), 1)
	}

	// Ligação entre as features: guild expõe as permissões; channel, message e invite as consomem.
	// channel não conhece guild (só a interface Access), então guild recebe channel por interface e
	// channelSvc é criado com um proxy que aponta para guildSvc depois de pronto.
	access := &lateAccess{}
	channelSvc := channel.NewService(channel.NewStore(pool), access, ids, bus)
	guildSvc := guild.NewService(guild.NewStore(pool), channelSvc, guildStorage, userSvc, ids, bus)
	access.svc = guildSvc
	dmSvc := dm.NewService(dm.NewStore(pool), ids, bus, userSvc, dmLimiter)
	channelSvc.SetDMs(dmSvc)
	typingSvc := typing.NewService(channelSvc, typingLimiter, bus)
	presenceSvc := presence.NewService(ctx, d.Presence, presence.NewStore(pool), bus, bus)
	messageSvc := message.NewService(message.NewStore(pool), channelSvc, msgLimiter, userSvc, ids, bus)
	gwCfg := d.Gateway
	if gwCfg.AllowedOrigins == nil {
		gwCfg.AllowedOrigins = d.Cfg.AllowedOrigins
	}
	gwCfg.Dev = d.Cfg.IsDev()
	hub := gateway.NewHub(ctx, gwCfg, guildSvc, bus, gateway.WithDMs(dmSvc), gateway.WithPresence(presenceSvc))
	gatewayH := gateway.NewHandler(hub, authSvc, auth.UserID)
	gwLimiter := d.GatewayLimiter
	if gwLimiter == nil {
		gwLimiter = ratelimit.New(50, 200)
	}
	startCleanup(ctx, authLimiter, apiLimiter, msgLimiter, gwLimiter, dmLimiter, typingLimiter)
	inviteSvc := invite.NewService(invite.NewStore(pool), guildSvc, guildSvc, guildSvc)

	guildH := guild.NewHandler(guildSvc, auth.UserID)
	channelH := channel.NewHandler(channelSvc, auth.UserID)
	messageH := message.NewHandler(messageSvc, auth.UserID)
	inviteH := invite.NewHandler(inviteSvc, auth.UserID)
	dmH := dm.NewHandler(dmSvc, auth.UserID)
	typingH := typing.NewHandler(typingSvc, auth.UserID)

	r := chi.NewRouter()
	r.Use(servertiming.Middleware) // primeiro: mede tudo, inclusive o rate limit
	r.Use(middleware.RequestID, middleware.Recoverer)
	r.Use(limitByPath(d.Cfg.RealIPHeader, authLimiter, apiLimiter, gwLimiter))

	healthH := health.NewHandler(d.Pool)
	r.Method(http.MethodGet, "/healthz", healthH)
	r.Method(http.MethodGet, "/api/healthz", healthH)

	registerAPI(r, d.Cfg.IsDev(), authH, userH, guildH, channelH, messageH, inviteH, dmH, typingH, gatewayH)
	r.Method(http.MethodGet, "/api/gateway", gatewayH) // upgrade WebSocket (fora do OpenAPI)

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
	h := otelhttp.NewHandler(r, "http.server",
		otelhttp.WithSpanNameFormatter(func(_ string, req *http.Request) string {
			return req.Method + " " + req.URL.Path
		}))
	return &App{Handler: h, Gateway: hub, presence: presenceSvc}, nil
}

// OpenAPIYAML gera o contrato da API sem precisar de banco (usado por `spook openapi`).
func OpenAPIYAML() ([]byte, error) {
	api := registerAPI(chi.NewRouter(), false, auth.NewHandler(nil, true, nil), user.NewHandler(nil, nil),
		guild.NewHandler(nil, nil), channel.NewHandler(nil, nil), message.NewHandler(nil, nil), invite.NewHandler(nil, nil),
		dm.NewHandler(nil, nil), typing.NewHandler(nil, nil), gateway.NewHandler(nil, nil, nil))
	return api.OpenAPI().YAML()
}

// lateAccess resolve a dependência circular channel -> guild na montagem.
type lateAccess struct{ svc *guild.Service }

func (a *lateAccess) Member(ctx context.Context, guildID, userID int64) (perm.Member, error) {
	return a.svc.Member(ctx, guildID, userID)
}

func registerAPI(r chi.Router, dev bool, authH *auth.Handler, userH *user.Handler,
	guildH *guild.Handler, channelH *channel.Handler, messageH *message.Handler, inviteH *invite.Handler,
	dmH *dm.Handler, typingH *typing.Handler, gatewayH *gateway.Handler) huma.API {
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
	guildH.Register(api, authed, auth.Security)
	channelH.Register(api, authed, auth.Security)
	messageH.Register(api, authed, auth.Security)
	inviteH.Register(api, authed, auth.Security)
	dmH.Register(api, authed, auth.Security)
	typingH.Register(api, authed, auth.Security)
	gatewayH.Register(api, authed, auth.Security)
	return api
}

func limitByPath(realIPHeader string, authL, apiL, gwL *ratelimit.Limiter) func(http.Handler) http.Handler {
	authMW := ratelimit.Middleware(authL, realIPHeader)
	apiMW := ratelimit.Middleware(apiL, realIPHeader)
	gwMW := ratelimit.Middleware(gwL, realIPHeader)
	return func(next http.Handler) http.Handler {
		authNext, apiNext, gwNext := authMW(next), apiMW(next), gwMW(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/api/gateway": // handshake: limite próprio, mais folgado
				gwNext.ServeHTTP(w, r)
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
