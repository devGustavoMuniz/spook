// Package app monta a aplicação HTTP: injeção de dependência manual e roteamento.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
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

	"github.com/devGustavoMuniz/spook/server/internal/account"
	"github.com/devGustavoMuniz/spook/server/internal/admin"
	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/auth"
	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/dm"
	"github.com/devGustavoMuniz/spook/server/internal/dmcall"
	"github.com/devGustavoMuniz/spook/server/internal/gateway"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/health"
	"github.com/devGustavoMuniz/spook/server/internal/invite"
	"github.com/devGustavoMuniz/spook/server/internal/mailflow"
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
	"github.com/devGustavoMuniz/spook/server/internal/platform/mailer"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/platform/secret"
	"github.com/devGustavoMuniz/spook/server/internal/platform/servertiming"
	"github.com/devGustavoMuniz/spook/server/internal/platform/snowflake"
	"github.com/devGustavoMuniz/spook/server/internal/platform/webui"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
	"github.com/devGustavoMuniz/spook/server/internal/relationship"
	"github.com/devGustavoMuniz/spook/server/internal/social"
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
	GatewayLimiter  *ratelimit.Limiter
	Gateway         gateway.Config     // tempos e limites do gateway (zero = padrões)
	Presence        presence.Config    // tolerância de offline etc. (zero = padrões; os testes usam valores curtos)
	AuthLimiter     *ratelimit.Limiter // padrão: 10 tentativas por minuto por IP em /api/auth/*
	DMLimiter       *ratelimit.Limiter // padrão: 10 DMs criadas por minuto por usuário
	TypingLimiter   *ratelimit.Limiter // padrão: 1 TYPING_START a cada 3 s por usuário e canal
	UploadLimiter   *ratelimit.Limiter // padrão: 30 pedidos de upload por minuto por usuário
	PushLimiter     *ratelimit.Limiter // padrão: 30 requisições por minuto por usuário nos endpoints de push
	EveryoneLimiter *ratelimit.Limiter // padrão: 1 uso de @everyone/@here a cada 30 s por usuário e canal
	ModLimiter      *ratelimit.Limiter // padrão: rajada de 20 e 1 por segundo por usuário nas ações de moderação

	// Social (SPEC 7.4, "Adicional: social"): pedidos de amizade, demais ações de amizade/bloqueio/convite e ligações em DM.
	FriendRequestLimiter *ratelimit.Limiter // padrão: rajada de 10 e 20 por hora por usuário ("friends.request")
	SocialLimiter        *ratelimit.Limiter // padrão: rajada de 30 e 1 por segundo por usuário
	CallLimiter          *ratelimit.Limiter // padrão: rajada de 5 e 1 a cada 5 s por usuário ("call.ring")
	// Limitadores por usuário das ações de conta (SPEC 7.x): senha (trocar/confirmar), e-mail e exclusão.
	PasswordLimiter *ratelimit.Limiter // padrão: rajada de 5 e 1 a cada 30 s
	EmailLimiter    *ratelimit.Limiter // padrão: 5 por hora
	DeleteLimiter   *ratelimit.Limiter // padrão: rajada de 3 e 1 por minuto

	// E-mail e login social (SPEC 5.5, "Adicional: e-mail e login social"). Os fluxos por e-mail ficam ligados
	// quando Cfg.Mail.Enabled() (driver smtp, ou log com MAIL_FLOWS_ON_LOG).
	Mailer           mailer.Sender              // testes: substitui o envio (nulo = o do Cfg.Mail.Driver)
	SocialProviders  map[string]social.Provider // testes: substitui os provedores (nulo = os de Cfg.Google/Discord)
	ForgotLimiter    *ratelimit.Limiter         // por IP em "esqueci/redefinir senha" (padrão: rajada 5, 1 a cada 2 min)
	ResendLimiter    *ratelimit.Limiter         // reenvio da verificação por usuário (padrão: rajada 3, 1 por min)
	RecipientLimiter *ratelimit.Limiter         // e-mails por destinatário (padrão: rajada 3, 1 a cada 2 min)
	// ForgotDelay é o piso de duração do "esqueci a senha" (0 = 500 ms; negativo = sem piso, para testes).
	ForgotDelay time.Duration

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
	// Outbox guarda os últimos e-mails do driver log em desenvolvimento (nil fora dele).
	Outbox *mailer.Outbox
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

	// E-mail (mailflow) e login social (social). O River só existe com o pool do pgx; sem ele o e-mail sai direto.
	box, ephemeral, err := secret.New(d.Cfg.SecretKey)
	if err != nil {
		return nil, err
	}
	if ephemeral && (d.Cfg.Mail.Enabled() || d.Cfg.Google.Enabled() || d.Cfg.Discord.Enabled()) && !d.Cfg.IsDev() {
		slog.Warn("SPOOK_SECRET_KEY ausente: chave aleatória por processo; fluxos de login social e e-mails em fila não sobrevivem a um reinício")
	}
	var outbox *mailer.Outbox
	sender := d.Mailer
	if sender == nil {
		switch d.Cfg.Mail.Driver {
		case "smtp":
			sender = mailer.NewSMTP(mailer.SMTPConfig{
				Host: d.Cfg.Mail.SMTP.Host, Port: d.Cfg.Mail.SMTP.Port, User: d.Cfg.Mail.SMTP.User,
				Password: d.Cfg.Mail.SMTP.Password, From: d.Cfg.Mail.SMTP.From,
			})
		default:
			if d.Cfg.IsDev() {
				outbox = &mailer.Outbox{}
			}
			sender = mailer.Log{Verbose: d.Cfg.IsDev(), Outbox: outbox}
		}
	}
	mailEnabled := d.Cfg.Mail.Enabled()
	if !mailEnabled {
		slog.Info("e-mail em modo degradado (sem SMTP): verificação e recuperação por e-mail desligadas; a troca de e-mail é direta")
	}
	mailStore := mailflow.NewStore(pool)
	mailJobs := &mailflow.Enqueuer{} // ligado ao client do River logo abaixo
	deliverer := &mailflow.Deliverer{Sender: sender, Box: box, State: mailStore, PublicURL: d.Cfg.PublicURL}
	recipientLimiter := d.RecipientLimiter
	if recipientLimiter == nil {
		recipientLimiter = ratelimit.New(1.0/120, 3)
	}
	forgotLimiter := d.ForgotLimiter
	if forgotLimiter == nil {
		forgotLimiter = ratelimit.New(1.0/120, 5)
	}
	resendLimiter := d.ResendLimiter
	if resendLimiter == nil {
		resendLimiter = ratelimit.New(1.0/60, 3)
	}
	forgotDelay := d.ForgotDelay
	switch {
	case forgotDelay == 0:
		forgotDelay = 500 * time.Millisecond
	case forgotDelay < 0:
		forgotDelay = 0
	}
	// A fila é ligada depois, com o client do River: até lá (e sem pool do pgx) o envio é direto.
	mailQueue := &lateQueue{direct: deliverer}
	mailSvc := mailflow.NewService(mailflow.Deps{
		Store: mailStore, Users: userSvc, Passwords: authSvc, Queue: mailQueue, Deliver: deliverer, Box: box, IDs: ids,
		Enabled: mailEnabled, Recipient: recipientLimiter, ForgotMinDuration: forgotDelay,
	})
	if mailEnabled {
		userSvc.SetEmailChangeVerifier(mailSvc)
		authSvc.OnRegistered(mailSvc.OnRegistered)
	}
	providers := d.SocialProviders
	if providers == nil {
		providers = map[string]social.Provider{}
		if d.Cfg.Google.Enabled() {
			providers[social.Google] = social.NewGoogle(d.Cfg.Google.ClientID, d.Cfg.Google.ClientSecret, nil, nil)
		}
		if d.Cfg.Discord.Enabled() {
			providers[social.Discord] = social.NewDiscord(d.Cfg.Discord.ClientID, d.Cfg.Discord.ClientSecret, nil, nil)
		}
	}
	socialStore := social.NewStore(pool)
	socialSvc := social.NewService(social.Deps{
		Providers: providers, PublicURL: d.Cfg.PublicURL, Box: box, Store: socialStore, Sessions: authSvc, IDs: ids,
	})
	go func() { // limpeza horária de tokens de e-mail e cadastros sociais vencidos
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if _, err := mailStore.Purge(ctx); err != nil {
					slog.Error("limpeza de tokens de e-mail", "err", err)
				}
				if _, err := socialStore.Purge(ctx); err != nil {
					slog.Error("limpeza de cadastros sociais", "err", err)
				}
			}
		}
	}()

	passwordLimiter := d.PasswordLimiter
	if passwordLimiter == nil {
		passwordLimiter = ratelimit.New(1.0/30, 5)
	}
	emailLimiter := d.EmailLimiter
	if emailLimiter == nil {
		emailLimiter = ratelimit.New(5.0/3600, 5)
	}
	deleteLimiter := d.DeleteLimiter
	if deleteLimiter == nil {
		deleteLimiter = ratelimit.New(1.0/60, 3)
	}
	userH := user.NewHandler(userSvc, auth.UserID).WithLimiter(emailLimiter)
	authH := auth.NewHandler(authSvc, !d.Cfg.IsDev(), userH.View).WithLimiter(passwordLimiter)
	mailH := mailflow.NewHandler(mailSvc, auth.UserID).WithLimiters(forgotLimiter, resendLimiter).RequireVerified(d.Cfg.Mail.RequireVerification)
	socialH := social.NewHandler(socialSvc, auth.UserID, userH.View, !d.Cfg.IsDev()).WithEmailEnabled(mailEnabled).WithLimiter(passwordLimiter)

	authLimiter := d.AuthLimiter
	if authLimiter == nil {
		perMin := 10 // 10 tentativas por minuto por IP em /api/auth/*
		if d.Cfg.AuthRatePerMin > 0 {
			perMin = d.Cfg.AuthRatePerMin
		}
		authLimiter = ratelimit.New(float64(perMin)/60, perMin)
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
	lim := d.Cfg.Limits.Normalize() // limites de domínio configuráveis (LIMIT_*), com os padrões do SPEC
	channelSvc := channel.NewService(channel.NewStore(pool), access, ids, bus)
	channelSvc.SetLimits(lim)
	guildSvc := guild.NewService(guild.NewStore(pool).WithLimits(lim), channelSvc, guildStorage, userSvc, ids, bus)
	guildSvc.SetLimits(lim)
	access.svc = guildSvc
	modLimiter := d.ModLimiter
	if modLimiter == nil {
		modLimiter = ratelimit.New(1, 20) // banir, expulsar, mutar, apelidos alheios, permissões de canal
	}
	auditSvc := audit.NewService(audit.NewStore(pool), guildSvc, userSvc, ids)
	guildSvc.SetAudit(auditSvc)
	guildSvc.SetLimiter(modLimiter)
	channelSvc.SetAudit(auditSvc)
	channelSvc.SetLimiter(modLimiter)
	friendReqLimiter := d.FriendRequestLimiter
	if friendReqLimiter == nil {
		friendReqLimiter = ratelimit.New(20.0/3600, 10)
	}
	socialLimiter := d.SocialLimiter
	if socialLimiter == nil {
		socialLimiter = ratelimit.New(1, 30)
	}
	callLimiter := d.CallLimiter
	if callLimiter == nil {
		callLimiter = ratelimit.New(0.2, 5)
	}
	relSvc := relationship.NewService(relationship.NewStore(pool), bus, userSvc, friendReqLimiter, socialLimiter)
	dmSvc := dm.NewService(dm.NewStore(pool), ids, bus, userSvc, dmLimiter)
	dmSvc.SetRelations(relSvc)
	channelSvc.SetDMs(dmSvc)
	typingSvc := typing.NewService(channelSvc, typingLimiter, bus)
	presenceSvc := presence.NewService(ctx, d.Presence, presence.NewStore(pool), bus, bus)
	uploadLimiter := d.UploadLimiter
	if uploadLimiter == nil {
		uploadLimiter = ratelimit.New(0.5, 30) // 30 pedidos por minuto
	}
	attachmentSvc := attachment.NewService(attachment.NewStore(pool), objects, channelSvc, uploadLimiter, ids)
	attachmentSvc.SetMaxFileSize(lim.AttachmentBytes)
	thumbJobs := &attachment.Enqueuer{} // ligado ao client do River logo abaixo
	messageSvc := message.NewService(message.NewStore(pool, thumbJobs), channelSvc, msgLimiter, userSvc, attachmentSvc, ids, bus)
	messageSvc.SetSystemChannels(guildSvc)
	messageSvc.SetDMGate(relSvc)
	everyoneLimiter := d.EveryoneLimiter
	if everyoneLimiter == nil {
		everyoneLimiter = ratelimit.New(1.0/30, 1) // @everyone/@here: 1 a cada 30 s por usuário e canal
	}
	messageSvc.SetEveryoneLimiter(everyoneLimiter)

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
		Limiter: pushLimiter, Policy: policy, EveryonePushMax: d.Cfg.EveryonePushMax,
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
	notifySvc.SetBlocks(relSvc)
	messageSvc.SetMentions(notifySvc)
	notifySvc.Start(ctx, bus)

	accountJobs := &account.Enqueuer{} // ligado ao client do River logo abaixo
	// Jobs (River): e-mails, thumbnails, limpeza de anexos órfãos e Web Push. Só existem com o pool do pgx.
	var jobClient *jobs.Client
	if rp, ok := d.Pool.(*pgxpool.Pool); ok {
		workers := river.NewWorkers()
		mailflow.RegisterWorkers(workers, deliverer)
		retention := time.Duration(d.Cfg.AuditRetentionDays) * 24 * time.Hour
		if retention <= 0 {
			retention = 90 * 24 * time.Hour
		}
		audit.RegisterWorkers(workers, auditSvc, retention)
		periodic := audit.PeriodicJobs()
		if objects != nil {
			attachment.RegisterWorkers(workers, attachmentSvc, messageSvc)
			periodic = append(periodic, attachment.PeriodicJobs()...)
			account.RegisterWorkers(workers, objects)
		}
		if notifySvc.PushEnabled() {
			notification.RegisterWorkers(workers, notifySvc)
		}
		if jobClient, err = jobs.New(rp, workers, periodic); err != nil {
			return nil, err
		}
		thumbJobs.Set(jobClient)
		pushJobs.Set(jobClient)
		accountJobs.Set(jobClient)
		mailJobs.Set(jobClient)
		mailQueue.queue = mailJobs
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
		Provider: voiceProv, Store: voicememory.New(), Previews: voicememory.NewPreviews(), Pub: bus,
		Access: voiceAccess{channels: channelSvc, guilds: guildSvc, dmBlocked: relSvc.PairBlocked}, Users: voiceUsers{users: userSvc}, Audit: auditSvc,
	})
	cancelVoice := bus.Subscribe(voiceSvc.OnEvent) // reavalia quem está em voz quando permissões mudam
	go func() { <-ctx.Done(); cancelVoice() }()
	reconcileEvery := d.VoiceReconcileEvery
	if reconcileEvery <= 0 {
		reconcileEvery = time.Minute
	}
	go voiceSvc.Run(ctx, reconcileEvery)
	voiceH := voice.NewHandler(voiceSvc, auth.UserID)

	// Chamadas em DM com toque: acompanha a sala de voz pelo barramento e responde ao gateway (READY).
	callSvc := dmcall.NewService(dmcall.Deps{DMs: dmSvc, Voice: voiceSvc, Blocks: relSvc, Notify: notifySvc, Pub: bus, Limiter: callLimiter})
	cancelCalls := bus.Subscribe(callSvc.OnEvent)
	go func() { <-ctx.Done(); cancelCalls(); callSvc.Close() }()

	gwCfg := d.Gateway
	if gwCfg.AllowedOrigins == nil {
		gwCfg.AllowedOrigins = d.Cfg.AllowedOrigins
	}
	gwCfg.Dev = d.Cfg.IsDev()
	hub := gateway.NewHub(ctx, gwCfg, guildSvc, bus, gateway.WithDMs(dmSvc), gateway.WithPresence(presenceSvc), gateway.WithVoice(voiceSvc), gateway.WithReadStates(notifySvc), gateway.WithNotificationSettings(notifySvc), gateway.WithRelationships(relSvc), gateway.WithCalls(callSvc))
	gatewayH := gateway.NewHandler(hub, authSvc, auth.UserID)
	gwLimiter := d.GatewayLimiter
	if gwLimiter == nil {
		gwLimiter = ratelimit.New(50, 200)
	}
	authSvc.OnRevoke(hub.RevokeAuth) // troca de senha e exclusão de conta derrubam as conexões das sessões encerradas
	startCleanup(ctx, passwordLimiter, emailLimiter, deleteLimiter, authLimiter, apiLimiter, msgLimiter, gwLimiter, dmLimiter, typingLimiter, uploadLimiter, pushLimiter, modLimiter, everyoneLimiter, friendReqLimiter, socialLimiter, callLimiter)
	inviteSvc := invite.NewService(invite.NewStore(pool).WithLimits(lim), guildSvc, guildSvc, guildSvc)
	inviteSvc.SetAudit(auditSvc)
	inviteSvc.SetLimits(lim)
	inviteSvc.SetJoiner(messageSvc) // mensagem de sistema "fulano entrou"
	relSvc.SetInvites(guildMembers{guildSvc}, inviteSvc, dmOpener{dmSvc}, messageSender{messageSvc}, d.Cfg.PublicURL)

	guildH := guild.NewHandler(guildSvc, auth.UserID)
	channelH := channel.NewHandler(channelSvc, auth.UserID)
	messageH := message.NewHandler(messageSvc, auth.UserID)
	attachmentH := attachment.NewHandler(attachmentSvc, auth.UserID)
	inviteH := invite.NewHandler(inviteSvc, auth.UserID)
	accountSvc := account.NewService(account.Deps{
		Store: account.NewStore(pool), Passwords: accountPasswords{authSvc}, Pub: bus, Groups: dmSvc,
		Enqueue: accountJobs.Enqueue, Revoke: authSvc.NotifyRevoked,
		LeaveVoice: func(ctx context.Context, userID int64) error {
			if err := voiceSvc.Leave(ctx, userID); err != nil && !errors.Is(err, voice.ErrDisabled) {
				return err
			}
			return nil
		},
	})
	accountH := account.NewHandler(accountSvc, auth.UserID).WithLimiter(deleteLimiter)
	dmH := dm.NewHandler(dmSvc, auth.UserID)
	typingH := typing.NewHandler(typingSvc, auth.UserID)
	notifyH := notification.NewHandler(notifySvc, auth.UserID)
	auditH := audit.NewHandler(auditSvc, auth.UserID)
	presenceH := presence.NewHandler(presenceSvc, auth.UserID)
	relH := relationship.NewHandler(relSvc, auth.UserID)
	callH := dmcall.NewHandler(callSvc, auth.UserID)

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
	r.Use(httpx.SecurityHeaders, httpx.WithClientIP(d.Cfg.RealIPHeader))
	r.Use(cors.Middleware(d.Cfg.AllowedOrigins)) // antes do rate limit: o preflight não consome limite e o 429 leva CORS
	r.Use(limitByPath(d.Cfg.RealIPHeader, authLimiter, apiLimiter, gwLimiter))

	healthH := health.NewHandler(d.Pool)
	r.Method(http.MethodGet, "/healthz", healthH)
	r.Method(http.MethodGet, "/api/healthz", healthH)

	registerAPI(r, d.Cfg.IsDev(), authH, mailH, socialH, userH, accountH, guildH, channelH, messageH, attachmentH, inviteH, dmH, typingH, voiceH, notifyH, presenceH, gatewayH, adminH, auditH, relH, callH)
	socialH.RegisterRoutes(r) // /api/auth/social/{provider}/start|callback: redirecionamentos, fora do OpenAPI
	if outbox != nil {        // SÓ em desenvolvimento com o driver log: lê o último e-mail (E2E e dev local)
		r.Get("/api/dev/mail/last", devMailHandler(outbox))
	}
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
	return &App{Handler: h, Gateway: hub, Voice: voiceSvc, presence: presenceSvc, jobs: jobClient, notify: notifySvc, Outbox: outbox}, nil
}

// OpenAPIYAML gera o contrato da API sem precisar de banco (usado por `spook openapi`).
func OpenAPIYAML() ([]byte, error) {
	return buildOpenAPI().YAML()
}

// buildOpenAPI monta o contrato sem dependências reais (só os tipos das rotas), para o YAML e para os testes.
func buildOpenAPI() *huma.OpenAPI { return buildAPI().OpenAPI() }

// buildAPI registra todas as rotas sem dependências reais (só os tipos), para o contrato e para os testes.
func buildAPI() huma.API {
	return registerAPI(chi.NewRouter(), false, auth.NewHandler(nil, true, nil), mailflow.NewHandler(nil, nil), social.NewHandler(nil, nil, nil, true), user.NewHandler(nil, nil), account.NewHandler(nil, nil),
		guild.NewHandler(nil, nil), channel.NewHandler(nil, nil), message.NewHandler(nil, nil), attachment.NewHandler(nil, nil), invite.NewHandler(nil, nil),
		dm.NewHandler(nil, nil), typing.NewHandler(nil, nil), voice.NewHandler(nil, nil), notification.NewHandler(nil, nil), presence.NewHandler(nil, nil), gateway.NewHandler(nil, nil, nil), admin.NewHandler(nil, nil), audit.NewHandler(nil, nil),
		relationship.NewHandler(nil, nil), dmcall.NewHandler(nil, nil))
}

// lateAccess resolve a dependência circular channel -> guild na montagem.
type lateAccess struct{ svc *guild.Service }

func (a *lateAccess) Member(ctx context.Context, guildID, userID int64) (perm.Member, error) {
	return a.svc.Member(ctx, guildID, userID)
}

func (a *lateAccess) MembersAccess(ctx context.Context, guildID int64) ([]perm.Member, error) {
	return a.svc.MembersAccess(ctx, guildID)
}

func (a *lateAccess) OverwriteTarget(ctx context.Context, guildID int64, t perm.TargetType, id int64) (channel.Target, error) {
	return a.svc.OverwriteTarget(ctx, guildID, t, id)
}

func registerAPI(r chi.Router, dev bool, authH *auth.Handler, mailH *mailflow.Handler, socialH *social.Handler, userH *user.Handler, accountH *account.Handler,
	guildH *guild.Handler, channelH *channel.Handler, messageH *message.Handler, attachmentH *attachment.Handler, inviteH *invite.Handler,
	dmH *dm.Handler, typingH *typing.Handler, voiceH *voice.Handler, notifyH *notification.Handler, presenceH *presence.Handler, gatewayH *gateway.Handler, adminH *admin.Handler, auditH *audit.Handler,
	relH *relationship.Handler, callH *dmcall.Handler) huma.API {
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
	// sensitive: sessão + confirmação de senha nos últimos 10 min (ver auth.Handler.RequireRecentPassword).
	// Outras features aplicam o mesmo valor às suas ações sensíveis (ex.: excluir servidor).
	sensitive := huma.Middlewares{authed[0], authH.RequireRecentPassword(api)}
	authH.Register(api, authed)
	mailH.Register(api, authed)
	socialH.Register(api, authed, sensitive)
	// Criar servidor e convidar exigem e-mail verificado quando REQUIRE_EMAIL_VERIFICATION=true (o gate não faz
	// nada nos demais casos).
	gate := huma.Middlewares{authed[0], mailH.Gate(api)}
	guildH.WithGate(gate)
	inviteH.WithGate(gate)
	userH.WithSensitive(sensitive).Register(api, authed, auth.Security)
	accountH.Register(api, authed, auth.Security)
	guildH.WithSensitive(sensitive).Register(api, authed, auth.Security)
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
	auditH.Register(api, authed, auth.Security)
	relH.Register(api, authed, auth.Security)
	callH.Register(api, authed, auth.Security)
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

// accountPasswords adapta o auth.Service à interface do pacote account.
type accountPasswords struct{ auth *auth.Service }

func (p accountPasswords) CheckPassword(ctx context.Context, userID int64, password string) (bool, error) {
	err := p.auth.VerifyPassword(ctx, userID, password)
	if errors.Is(err, auth.ErrWrongPassword) {
		return false, nil
	}
	return err == nil, err
}

// lateQueue encaminha para o River depois que ele existe; antes (ou sem pool do pgx) entrega direto.
type lateQueue struct {
	queue  mailflow.Queue
	direct *mailflow.Deliverer
}

func (q *lateQueue) Enqueue(ctx context.Context, a mailflow.SendArgs) error {
	if q.queue != nil {
		return q.queue.Enqueue(ctx, a)
	}
	return q.direct.Deliver(ctx, a)
}

// devMailHandler devolve o último e-mail enviado a ?to= (só existe em desenvolvimento com o driver log).
func devMailHandler(ob *mailer.Outbox) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m, ok := ob.Last(r.URL.Query().Get("to"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"to": m.To, "subject": m.Subject, "text": m.Text})
	}
}
