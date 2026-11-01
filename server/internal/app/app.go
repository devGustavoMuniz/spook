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

	"github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/devGustavoMuniz/spook/server/internal/admin"
	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/auth"
	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/dm"
	"github.com/devGustavoMuniz/spook/server/internal/gateway"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/health"
	"github.com/devGustavoMuniz/spook/server/internal/invite"
	"github.com/devGustavoMuniz/spook/server/internal/message"
	"github.com/devGustavoMuniz/spook/server/internal/notification"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/config"
	"github.com/devGustavoMuniz/spook/server/internal/platform/cors"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/jobs"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/platform/servertiming"
	"github.com/devGustavoMuniz/spook/server/internal/platform/snowflake"
	"github.com/devGustavoMuniz/spook/server/internal/platform/webui"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
	"github.com/devGustavoMuniz/spook/server/internal/typing"
	"github.com/devGustavoMuniz/spook/server/internal/user"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
	voicelivekit "github.com/devGustavoMuniz/spook/server/internal/voice/livekit"
	voicememory "github.com/devGustavoMuniz/spook/server/internal/voice/memory"
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
	Storage Storage // nil desliga o upload de avatar, de ícone e de anexos (e os jobs de thumbnail)

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
	UploadLimiter  *ratelimit.Limiter // padrão: 30 pedidos de upload por minuto por usuário
	PushLimiter    *ratelimit.Limiter // padrão: 30 requisições por minuto por usuário nos endpoints de push

	// Push (testes): AllowPrivate relaxa o anti-SSRF (o "serviço de push" do teste fica em 127.0.0.1) e
	// HTTPClient substitui o cliente do envio (para confiar no certificado do servidor de teste).
	Push PushOptions

	// Voz (testes): substitui o adaptador do LiveKit (nulo = o da configuração, ou voz desligada
	// sem LIVEKIT_*) e muda o intervalo do reconciliador (padrão 60 s).
	VoiceProvider       voice.Provider
	VoiceReconcileEvery time.Duration
}

// PushOptions ajusta o envio de Web Push (só os testes mexem).
type PushOptions struct {
	AllowPrivate bool
	HTTPClient   webpush.HTTPClient
}

// App é a aplicação montada: o handler HTTP e o gateway, que precisa de um desligamento próprio
// (conexões hijacked não são encerradas pelo http.Server.Shutdown).
type App struct {
	Handler  http.Handler
	Gateway  *gateway.Hub
	Voice    *voice.Service
	presence *presence.Service // acessado pelos testes de integração
	jobs     *jobs.Client      // nil sem storage nem push; parado por Close
	notify   *notification.Service
}

// Close para o processamento de jobs: espera os em andamento terminarem (ou ctx expirar). Chame antes de
// fechar o pool de conexões.
func (a *App) Close(ctx context.Context) error {
	if a.notify != nil {
		a.notify.Stop() // antes dos jobs: o que ainda está na fila pode enfileirar push
	}
	if a.jobs == nil {
		return nil
	}
	if err := a.jobs.Stop(ctx); err != nil {
		_ = a.jobs.StopAndCancel(ctx)
		return err
	}
	return nil
}

// Storage é o storage S3 usado para avatares, ícones e anexos.
type Storage interface {
	user.AvatarStorage
	guild.Storage
	attachment.Objects
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
	var objects attachment.Objects
	if d.Storage != nil { // interface nil de verdade quando o storage está desligado
		avatarStorage, guildStorage, objects = d.Storage, d.Storage, d.Storage
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
	uploadLimiter := d.UploadLimiter
	if uploadLimiter == nil {
		uploadLimiter = ratelimit.New(0.5, 30) // 30 pedidos por minuto
	}
	attachmentSvc := attachment.NewService(attachment.NewStore(pool), objects, channelSvc, uploadLimiter, ids)
	thumbJobs := &attachment.Enqueuer{} // ligado ao client do River logo abaixo
	messageSvc := message.NewService(message.NewStore(pool, thumbJobs), channelSvc, msgLimiter, userSvc, attachmentSvc, ids, bus)

	// Notificações (Fase 6b): não lidas, menções e Web Push. Assina MESSAGE_CREATE; message só conhece a
	// interface de menções.
	pushLimiter := d.PushLimiter
	if pushLimiter == nil {
		pushLimiter = ratelimit.New(0.5, 30) // 30 requisições por minuto
	}
	pushCfg := notification.PushConfig{PublicKey: d.Cfg.VAPID.PublicKey, PrivateKey: d.Cfg.VAPID.PrivateKey, Subject: d.Cfg.VAPID.Subject}
	policy := notification.EndpointPolicy{AllowPrivate: d.Push.AllowPrivate}
	notifDeps := notification.Deps{
		Store: notification.NewStore(pool), Channels: channelSvc, Presence: presenceSvc, Pub: bus, IDs: ids,
		Limiter: pushLimiter, Policy: policy,
	}
	pushJobs := &notification.Enqueuer{} // ligado ao client do River logo abaixo
	if pushCfg.Enabled() {
		sender, err := notification.NewWebPushSender(pushCfg, policy, d.Push.HTTPClient)
		if err != nil {
			return nil, err
		}
		notifDeps.Push, notifDeps.Sender, notifDeps.Queue = pushCfg, sender, pushJobs
	}
	notifySvc := notification.NewService(notifDeps)
	messageSvc.SetMentions(notifySvc)
	notifySvc.Start(ctx, bus)

	// Jobs (River): thumbnails, limpeza de anexos órfãos e Web Push. Só existem com o pool do pgx e com
	// storage ou push ligados.
	var jobClient *jobs.Client
	if rp, ok := d.Pool.(*pgxpool.Pool); ok && (objects != nil || notifySvc.PushEnabled()) {
		workers := river.NewWorkers()
		var periodic []*river.PeriodicJob
		if objects != nil {
			attachment.RegisterWorkers(workers, attachmentSvc, messageSvc)
			periodic = attachment.PeriodicJobs()
		}
		if notifySvc.PushEnabled() {
			notification.RegisterWorkers(workers, notifySvc)
		}
		if jobClient, err = jobs.New(rp, workers, periodic); err != nil {
			return nil, err
		}
		thumbJobs.Set(jobClient)
		pushJobs.Set(jobClient)
		// Sem o cancelamento de ctx: o desligamento é explícito (App.Close), para os jobs terminarem.
		if err := jobClient.Start(context.WithoutCancel(ctx)); err != nil {
			return nil, err
		}
	}

	// Voz (hexagonal): porta do LiveKit, estado em memória e permissões ligadas a guild/dm/perm.
	var voiceProv voice.Provider
	switch {
	case d.VoiceProvider != nil:
		voiceProv = d.VoiceProvider
	case d.Cfg.LiveKit.Enabled():
		voiceProv = voicelivekit.New(voicelivekit.Config{
			PublicURL: d.Cfg.LiveKit.URL, InternalURL: d.Cfg.LiveKit.InternalURL,
			APIKey: d.Cfg.LiveKit.APIKey, APISecret: d.Cfg.LiveKit.APISecret,
		})
	}
	voiceSvc := voice.NewService(voice.Deps{
		Provider: voiceProv, Store: voicememory.New(), Pub: bus,
		Access: voiceAccess{channels: channelSvc, guilds: guildSvc}, Users: voiceUsers{users: userSvc},
	})
	cancelVoice := bus.Subscribe(voiceSvc.OnEvent) // reavalia quem está em voz quando permissões mudam
	go func() { <-ctx.Done(); cancelVoice() }()
	reconcileEvery := d.VoiceReconcileEvery
	if reconcileEvery <= 0 {
		reconcileEvery = time.Minute
	}
	go voiceSvc.Run(ctx, reconcileEvery)
	voiceH := voice.NewHandler(voiceSvc, auth.UserID)

	gwCfg := d.Gateway
	if gwCfg.AllowedOrigins == nil {
		gwCfg.AllowedOrigins = d.Cfg.AllowedOrigins
	}
	gwCfg.Dev = d.Cfg.IsDev()
	hub := gateway.NewHub(ctx, gwCfg, guildSvc, bus, gateway.WithDMs(dmSvc), gateway.WithPresence(presenceSvc), gateway.WithVoice(voiceSvc), gateway.WithReadStates(notifySvc), gateway.WithNotificationSettings(notifySvc))
	gatewayH := gateway.NewHandler(hub, authSvc, auth.UserID)
	gwLimiter := d.GatewayLimiter
	if gwLimiter == nil {
		gwLimiter = ratelimit.New(50, 200)
	}
	startCleanup(ctx, authLimiter, apiLimiter, msgLimiter, gwLimiter, dmLimiter, typingLimiter, uploadLimiter, pushLimiter)
	inviteSvc := invite.NewService(invite.NewStore(pool), guildSvc, guildSvc, guildSvc)

	guildH := guild.NewHandler(guildSvc, auth.UserID)
	channelH := channel.NewHandler(channelSvc, auth.UserID)
	messageH := message.NewHandler(messageSvc, auth.UserID)
	attachmentH := attachment.NewHandler(attachmentSvc, auth.UserID)
	inviteH := invite.NewHandler(inviteSvc, auth.UserID)
	dmH := dm.NewHandler(dmSvc, auth.UserID)
	typingH := typing.NewHandler(typingSvc, auth.UserID)
	notifyH := notification.NewHandler(notifySvc, auth.UserID)
	presenceH := presence.NewHandler(presenceSvc, auth.UserID)

	// Painel administrativo (/admin): leituras agregadas; voz, gateway, pool e Prometheus entram por interfaces.
	adminDeps := admin.Deps{
		Store: admin.NewStore(pool), Gateway: adminGateway{hub},
		Env: d.Cfg.Env, Version: d.Cfg.Version, Commit: d.Cfg.Commit,
	}
	if voiceSvc.Enabled() {
		adminDeps.Calls = adminCalls{voiceSvc}
	}
	if pp, ok := d.Pool.(*pgxpool.Pool); ok {
		adminDeps.Pool = adminPool{pp}
	}
	if d.Cfg.LiveKit.Enabled() && d.Cfg.LiveKit.MetricsURL != "" {
		adminDeps.Media = admin.NewPromClient(d.Cfg.LiveKit.MetricsURL)
	}
	adminSvc := admin.NewService(adminDeps)
	if _, err := adminSvc.Bootstrap(ctx, d.Cfg.AdminUsernames); err != nil {
		return nil, err
	}
	adminH := admin.NewHandler(adminSvc, auth.UserID)

	r := chi.NewRouter()
	r.Use(servertiming.Middleware) // primeiro: mede tudo, inclusive o rate limit
	r.Use(middleware.RequestID, httpx.LogServerErrors, middleware.Recoverer)
	r.Use(cors.Middleware(d.Cfg.AllowedOrigins)) // antes do rate limit: o preflight não consome limite e o 429 leva CORS
	r.Use(limitByPath(d.Cfg.RealIPHeader, authLimiter, apiLimiter, gwLimiter))

	healthH := health.NewHandler(d.Pool)
	r.Method(http.MethodGet, "/healthz", healthH)
	r.Method(http.MethodGet, "/api/healthz", healthH)

	registerAPI(r, d.Cfg.IsDev(), authH, userH, guildH, channelH, messageH, attachmentH, inviteH, dmH, typingH, voiceH, notifyH, presenceH, gatewayH, adminH)
	r.Method(http.MethodGet, "/api/gateway", gatewayH) // upgrade WebSocket (fora do OpenAPI)

	// Webhook do LiveKit: sem sessão (a assinatura autentica) e fora do rate limit por IP.
	r.Method(http.MethodPost, voice.WebhookPath, voiceH.WebhookHandler())

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
	return &App{Handler: h, Gateway: hub, Voice: voiceSvc, presence: presenceSvc, jobs: jobClient, notify: notifySvc}, nil
}

// OpenAPIYAML gera o contrato da API sem precisar de banco (usado por `spook openapi`).
func OpenAPIYAML() ([]byte, error) {
	return buildOpenAPI().YAML()
}

// buildOpenAPI monta o contrato sem dependências reais (só os tipos das rotas), para o YAML e para os testes.
func buildOpenAPI() *huma.OpenAPI {
	api := registerAPI(chi.NewRouter(), false, auth.NewHandler(nil, true, nil), user.NewHandler(nil, nil),
		guild.NewHandler(nil, nil), channel.NewHandler(nil, nil), message.NewHandler(nil, nil), attachment.NewHandler(nil, nil), invite.NewHandler(nil, nil),
		dm.NewHandler(nil, nil), typing.NewHandler(nil, nil), voice.NewHandler(nil, nil), notification.NewHandler(nil, nil), presence.NewHandler(nil, nil), gateway.NewHandler(nil, nil, nil), admin.NewHandler(nil, nil))
	return api.OpenAPI()
}

// lateAccess resolve a dependência circular channel -> guild na montagem.
type lateAccess struct{ svc *guild.Service }

func (a *lateAccess) Member(ctx context.Context, guildID, userID int64) (perm.Member, error) {
	return a.svc.Member(ctx, guildID, userID)
}

func registerAPI(r chi.Router, dev bool, authH *auth.Handler, userH *user.Handler,
	guildH *guild.Handler, channelH *channel.Handler, messageH *message.Handler, attachmentH *attachment.Handler, inviteH *invite.Handler,
	dmH *dm.Handler, typingH *typing.Handler, voiceH *voice.Handler, notifyH *notification.Handler, presenceH *presence.Handler, gatewayH *gateway.Handler, adminH *admin.Handler) huma.API {
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
	attachmentH.Register(api, authed, auth.Security)
	inviteH.Register(api, authed, auth.Security)
	dmH.Register(api, authed, auth.Security)
	typingH.Register(api, authed, auth.Security)
	voiceH.Register(api, authed, auth.Security)
	notifyH.Register(api, authed, auth.Security)
	presenceH.Register(api, authed, auth.Security)
	gatewayH.Register(api, authed, auth.Security)
	adminH.Register(api, authed, auth.Security)
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
			case r.URL.Path == voice.WebhookPath: // tráfego do container do LiveKit: sem limite por IP
				next.ServeHTTP(w, r)
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
