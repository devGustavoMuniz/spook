// Package config carrega a configuração do processo a partir de variáveis de ambiente.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/limits"
)

type S3 struct {
	Endpoint         string // endpoint público: as URLs pré-assinadas são entregues ao navegador
	InternalEndpoint string // endpoint interno para as operações do servidor (HEAD/GET/PUT/DELETE); vazio = Endpoint
	Region           string
	Bucket           string
	AccessKeyID      string
	SecretAccessKey  string
}

func (s S3) Enabled() bool { return s.Endpoint != "" }

// LiveKit reúne a configuração da voz (Fase 5). Sem URL, chave e segredo a voz fica desligada
// (os endpoints respondem 503).
type LiveKit struct {
	URL         string // URL pública para o cliente (wss://… em produção, ws://localhost:7880 em dev)
	APIKey      string
	APISecret   string
	InternalURL string // API server-to-server (padrão http://livekit:7880)
	// MetricsURL é o endpoint Prometheus do LiveKit (rede interna), lido pelo painel /admin. Padrão: a
	// mesma máquina de InternalURL na porta 6789, /metrics. Vazio desliga a leitura.
	MetricsURL string
	// MonthlyTrafficGB é o tráfego de saída mensal do plano (LIVEKIT_MONTHLY_TRAFFIC_GB, opcional; 0 = sem limite):
	// o painel mostra o uso do mês contra ele.
	MonthlyTrafficGB float64
}

// MonthlyTrafficBytes converte MonthlyTrafficGB em bytes (1 GB = 10^9 bytes, como os planos de nuvem).
func (l LiveKit) MonthlyTrafficBytes() int64 { return int64(l.MonthlyTrafficGB * 1e9) }

func (l LiveKit) Enabled() bool { return l.URL != "" && l.APIKey != "" && l.APISecret != "" }

// Billing reúne o pagamento do Nitro pelo Mercado Pago (Checkout Pro). Sem o Access Token fica 100% desligado.
type Billing struct {
	AccessToken    string // MERCADOPAGO_ACCESS_TOKEN (segredo; nunca logado)
	WebhookSecret  string // MERCADOPAGO_WEBHOOK_SECRET (chave secreta da assinatura x-signature; segredo)
	NitroCents     int    // NITRO_PRICE_CENTS (padrão 1490)
	NitroPlusCents int    // NITRO_PLUS_PRICE_CENTS (padrão 2990)
}

func (b Billing) Enabled() bool { return b.AccessToken != "" }

// VAPID reúne as chaves do Web Push (Fase 6b). Sem as três o push fica desligado (os endpoints respondem 503).
type VAPID struct {
	PublicKey  string // VAPID_PUBLIC_KEY (base64url, ponto P-256 não comprimido)
	PrivateKey string // VAPID_PRIVATE_KEY (base64url, 32 bytes)
	Subject    string // VAPID_SUBJECT (mailto: ou https: de contato)
}

func (v VAPID) Enabled() bool { return v.PublicKey != "" && v.PrivateKey != "" && v.Subject != "" }

// Partial diz que alguma variável VAPID foi definida mas não todas (push desligado por engano).
func (v VAPID) Partial() bool {
	n := 0
	for _, s := range []string{v.PublicKey, v.PrivateKey, v.Subject} {
		if s != "" {
			n++
		}
	}
	return n > 0 && n < 3
}

// SMTP reúne o envio de e-mail por SMTP (SMTP_*). Porta 465 usa TLS direto; as demais, STARTTLS.
type SMTP struct {
	Host     string
	Port     int
	User     string
	Password string // segredo: nunca logar
	From     string
}

// Mail reúne a configuração de e-mail. Driver "smtp" entrega de verdade; "log" só escreve no log
// (modo degradado: as funções que dependem de e-mail ficam desligadas, a menos que LogActive).
type Mail struct {
	Driver string // MAILER_DRIVER: smtp | log (padrão: smtp se SMTP_HOST existir, senão log)
	SMTP   SMTP
	// LogActive (MAIL_FLOWS_ON_LOG=true) mantém os fluxos por e-mail ligados mesmo com o driver log: serve
	// ao desenvolvimento e ao E2E, onde o link sai no log e na caixa de saída de desenvolvimento.
	LogActive bool
	// RequireVerification (REQUIRE_EMAIL_VERIFICATION=true) exige e-mail verificado para criar servidor e convidar.
	RequireVerification bool
}

// Enabled diz se os fluxos por e-mail (verificar, recuperar senha, confirmar troca) estão ligados.
func (m Mail) Enabled() bool { return m.Driver == "smtp" || (m.Driver == "log" && m.LogActive) }

// OAuthApp é um app OAuth2 de provedor social; sem ID e segredo o provedor fica desligado.
type OAuthApp struct{ ClientID, ClientSecret string }

func (a OAuthApp) Enabled() bool { return a.ClientID != "" && a.ClientSecret != "" }

type Config struct {
	Addr         string
	Env          string
	DatabaseURL  string
	OTLPEndpoint string
	NodeID       int64  // nó do Snowflake (0..1023)
	WebDir       string // build do front servido pelo backend; vazio desliga
	RealIPHeader string // ex.: CF-Connecting-IP atrás do Cloudflare Tunnel
	S3           S3
	LiveKit      LiveKit
	VAPID        VAPID
	Billing      Billing
	// AllowedOrigins são as origens extras aceitas no handshake do gateway, além do próprio host
	// (SPOOK_ALLOWED_ORIGINS, separadas por vírgula).
	AllowedOrigins []string
	// PresenceOfflineGrace é a tolerância antes de declarar offline quem perdeu a última sessão
	// (SPOOK_PRESENCE_OFFLINE_GRACE, duration do Go; zero = padrão de 15 s). Existe para o E2E usar
	// um valor curto; em produção deixe sem definir.
	PresenceOfflineGrace time.Duration
	// AuthRatePerMin é o limite de requisições por minuto, por IP, em /api/auth/* (SPOOK_AUTH_RATE_PER_MIN;
	// zero = padrão de 10). Existe para o E2E, onde todas as contas saem do mesmo IP; em produção deixe sem definir.
	AuthRatePerMin int
	// AuditRetentionDays é por quantos dias o registro de auditoria é guardado (AUDIT_RETENTION_DAYS; padrão 90).
	AuditRetentionDays int
	// AdminUsernames (ADMIN_USERNAMES, separados por vírgula) são promovidos a administradores do painel
	// /admin no boot, de forma idempotente. Nunca rebaixa ninguém.
	AdminUsernames []string
	// PublicURL é a URL pública do app (PUBLIC_URL, sem barra final): base dos links dos e-mails e dos
	// callbacks OAuth (PUBLIC_URL/api/auth/social/{provider}/callback).
	PublicURL string
	// Limits são os limites de domínio (LIMIT_*), com os padrões do SPEC; EveryonePushMax (EVERYONE_PUSH_MAX,
	// padrão 200) é o máximo de destinatários de push de uma menção em massa (@everyone, @here, cargo).
	Limits          limits.Limits
	EveryonePushMax int
	Mail            Mail
	// GitHubReleasesRepo (GITHUB_RELEASES_REPO, dono/repo; padrão devGustavoMuniz/spook) é de onde /api/downloads/latest
	// lê o último release do desktop. GitHubToken (GITHUB_TOKEN) é opcional e NÃO é necessário: só sobe o limite da
	// API do GitHub (60/h por IP), que o cache de 5 min já evita. Nunca é logado.
	GitHubReleasesRepo string
	GitHubToken        string
	Google             OAuthApp // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
	Discord            OAuthApp // DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET
	// SecretKey (SPOOK_SECRET_KEY) assina o estado OAuth e cifra os tokens em jobs. Vazio = chave aleatória por
	// processo (fluxos em andamento e e-mails na fila não sobrevivem a um reinício).
	SecretKey string
	// LiveKitSamplesRetentionDays é por quantos dias o histórico por minuto do LiveKit/gateway é guardado
	// (LIVEKIT_SAMPLES_RETENTION_DAYS; padrão 35, de 2 a 365).
	LiveKitSamplesRetentionDays int
	// AdminDiskPath é o diretório cujo volume o painel mede (ADMIN_DISK_PATH; padrão "/").
	AdminDiskPath string
	// RateLimitPerMin guarda as substituições RATELIMIT_<NOME>_PER_MIN dos limites nomeados por ação, indexadas
	// pelo nome estável (ex.: "servers.create"); só valem nomes conhecidos (ver app/ratelimits.go).
	RateLimitPerMin map[string]int
	// Version identifica o build no painel (SPOOK_VERSION; em produção, a imagem). Vazio = "dev".
	Version string
	// Commit é opcional (SPOOK_COMMIT); sem ele o painel usa o vcs.revision do build, se houver.
	Commit string
}

// DefaultAllowedOrigins são as origens do app desktop (Tauri) no macOS/Linux e no Windows.
var DefaultAllowedOrigins = []string{"tauri://localhost", "http://tauri.localhost"}

// Load lê as variáveis SPOOK_* e S3_*. SPOOK_DATABASE_URL é obrigatória.
func Load() (Config, error) {
	c := Config{
		Addr:         getenv("SPOOK_ADDR", ":8090"),
		Env:          getenv("SPOOK_ENV", "development"),
		DatabaseURL:  os.Getenv("SPOOK_DATABASE_URL"),
		OTLPEndpoint: os.Getenv("SPOOK_OTLP_ENDPOINT"),
		WebDir:       os.Getenv("SPOOK_WEB_DIR"),
		RealIPHeader: os.Getenv("SPOOK_REAL_IP_HEADER"),
		S3: S3{
			Endpoint:         os.Getenv("S3_ENDPOINT"),
			InternalEndpoint: os.Getenv("S3_INTERNAL_ENDPOINT"),
			Region:           getenv("S3_REGION", "garage"),
			Bucket:           getenv("S3_BUCKET", "spook"),
			AccessKeyID:      os.Getenv("S3_ACCESS_KEY_ID"),
			SecretAccessKey:  os.Getenv("S3_SECRET_ACCESS_KEY"),
		},
		VAPID: VAPID{
			PublicKey:  strings.TrimSpace(os.Getenv("VAPID_PUBLIC_KEY")),
			PrivateKey: strings.TrimSpace(os.Getenv("VAPID_PRIVATE_KEY")),
			Subject:    strings.TrimSpace(os.Getenv("VAPID_SUBJECT")),
		},
		LiveKit: LiveKit{
			URL:         os.Getenv("LIVEKIT_URL"),
			APIKey:      os.Getenv("LIVEKIT_API_KEY"),
			APISecret:   os.Getenv("LIVEKIT_API_SECRET"),
			InternalURL: getenv("LIVEKIT_INTERNAL_URL", "http://livekit:7880"),
		},
	}
	if err := loadMail(&c); err != nil {
		return Config{}, err
	}
	c.Version, c.Commit = strings.TrimSpace(os.Getenv("SPOOK_VERSION")), strings.TrimSpace(os.Getenv("SPOOK_COMMIT"))
	for _, u := range splitList(os.Getenv("ADMIN_USERNAMES")) {
		c.AdminUsernames = append(c.AdminUsernames, strings.ToLower(u))
	}
	c.LiveKit.MetricsURL = os.Getenv("LIVEKIT_METRICS_URL")
	if c.LiveKit.MetricsURL == "" {
		c.LiveKit.MetricsURL = defaultMetricsURL(c.LiveKit.InternalURL)
	}
	c.AllowedOrigins = DefaultAllowedOrigins
	if v, ok := os.LookupEnv("SPOOK_ALLOWED_ORIGINS"); ok {
		c.AllowedOrigins = splitList(v)
	}
	if c.DatabaseURL == "" {
		return Config{}, errors.New("SPOOK_DATABASE_URL é obrigatória")
	}
	if v := os.Getenv("SPOOK_NODE_ID"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("SPOOK_NODE_ID inválido: %w", err)
		}
		c.NodeID = n
	}
	if v := os.Getenv("SPOOK_PRESENCE_OFFLINE_GRACE"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d < 0 {
			return Config{}, fmt.Errorf("SPOOK_PRESENCE_OFFLINE_GRACE inválido: %q", v)
		}
		c.PresenceOfflineGrace = d
	}
	if v := os.Getenv("SPOOK_AUTH_RATE_PER_MIN"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return Config{}, fmt.Errorf("SPOOK_AUTH_RATE_PER_MIN inválido: %q", v)
		}
		c.AuthRatePerMin = n
	}
	c.AuditRetentionDays = 90
	if v := os.Getenv("AUDIT_RETENTION_DAYS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 3650 {
			return Config{}, fmt.Errorf("AUDIT_RETENTION_DAYS inválido (1 a 3650): %q", v)
		}
		c.AuditRetentionDays = n
	}
	c.GitHubReleasesRepo = getenv("GITHUB_RELEASES_REPO", DefaultGitHubReleasesRepo)
	if !githubRepoRe.MatchString(c.GitHubReleasesRepo) {
		return Config{}, fmt.Errorf("GITHUB_RELEASES_REPO inválido (use dono/repo): %q", c.GitHubReleasesRepo)
	}
	c.GitHubToken = strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
	if err := loadLimits(&c); err != nil {
		return Config{}, err
	}
	if err := loadBilling(&c); err != nil {
		return Config{}, err
	}
	if err := loadAdmin(&c); err != nil {
		return Config{}, err
	}
	if c.S3.Enabled() && (c.S3.AccessKeyID == "" || c.S3.SecretAccessKey == "") {
		return Config{}, errors.New("S3_ENDPOINT definido sem S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY")
	}
	return c, nil
}

// DefaultGitHubReleasesRepo é o padrão de GITHUB_RELEASES_REPO.
const DefaultGitHubReleasesRepo = "devGustavoMuniz/spook"

var githubRepoRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// DefaultEveryonePushMax é o padrão de EVERYONE_PUSH_MAX.
const DefaultEveryonePushMax = 200

// loadLimits lê LIMIT_* e EVERYONE_PUSH_MAX; valor fora da faixa recusa o boot (erro de configuração).
func loadLimits(c *Config) error {
	c.Limits = limits.Default()
	c.EveryonePushMax = DefaultEveryonePushMax
	ints := []struct {
		env      string
		dst      *int
		min, max int
	}{
		{"LIMIT_GUILDS_PER_USER", &c.Limits.GuildsPerUser, 1, limits.MaxGuildsPerUser},
		{"LIMIT_CHANNELS_PER_GUILD", &c.Limits.ChannelsPerGuild, 1, limits.MaxChannelsPerGuild},
		{"LIMIT_MEMBERS_PER_GUILD", &c.Limits.MembersPerGuild, 1, limits.MaxMembersPerGuild},
		{"LIMIT_ROLES_PER_GUILD", &c.Limits.RolesPerGuild, 2, limits.MaxRolesPerGuild},
		{"LIMIT_INVITES_PER_GUILD", &c.Limits.InvitesPerGuild, 1, limits.MaxInvitesPerGuild},
		{"EVERYONE_PUSH_MAX", &c.EveryonePushMax, 0, 100_000},
	}
	for _, f := range ints {
		v := os.Getenv(f.env)
		if v == "" {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < f.min || n > f.max {
			return fmt.Errorf("%s inválido (%d a %d): %q", f.env, f.min, f.max, v)
		}
		*f.dst = n
	}
	if v := os.Getenv("LIMIT_ATTACHMENT_MB"); v != "" {
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 1 || n > limits.MaxAttachmentMB {
			return fmt.Errorf("LIMIT_ATTACHMENT_MB inválido (1 a %d): %q", limits.MaxAttachmentMB, v)
		}
		c.Limits.AttachmentBytes = int64(n) << 20
	}
	return nil
}

func loadBilling(c *Config) error {
	c.Billing = Billing{
		AccessToken: strings.TrimSpace(os.Getenv("MERCADOPAGO_ACCESS_TOKEN")), WebhookSecret: strings.TrimSpace(os.Getenv("MERCADOPAGO_WEBHOOK_SECRET")),
		NitroCents: 1490, NitroPlusCents: 2990,
	}
	for name, dst := range map[string]*int{"NITRO_PRICE_CENTS": &c.Billing.NitroCents, "NITRO_PLUS_PRICE_CENTS": &c.Billing.NitroPlusCents} {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 100 || n > 10_000_000 {
				return fmt.Errorf("%s inválido (centavos, de 100 a 10000000): %q", name, v)
			}
			*dst = n
		}
	}
	if c.Billing.Enabled() && c.Billing.WebhookSecret == "" {
		return errors.New("MERCADOPAGO_ACCESS_TOKEN definido sem MERCADOPAGO_WEBHOOK_SECRET (o webhook precisa da chave para validar a assinatura)")
	}
	if c.Billing.Enabled() && !c.IsDev() && c.PublicURL == "" {
		return errors.New("PUBLIC_URL é obrigatória com o pagamento (base das URLs de retorno e de notificação)")
	}
	return nil
}

func loadMail(c *Config) error {
	c.PublicURL = strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_URL")), "/")
	if c.PublicURL == "" && c.IsDev() {
		c.PublicURL = "http://localhost:8090"
	}
	c.SecretKey = os.Getenv("SPOOK_SECRET_KEY")
	c.Google = OAuthApp{strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID")), strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_SECRET"))}
	c.Discord = OAuthApp{strings.TrimSpace(os.Getenv("DISCORD_CLIENT_ID")), strings.TrimSpace(os.Getenv("DISCORD_CLIENT_SECRET"))}
	m := &c.Mail
	m.SMTP = SMTP{
		Host: strings.TrimSpace(os.Getenv("SMTP_HOST")), User: os.Getenv("SMTP_USER"),
		Password: os.Getenv("SMTP_PASSWORD"), From: strings.TrimSpace(os.Getenv("SMTP_FROM")), Port: 587,
	}
	if v := os.Getenv("SMTP_PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 65535 {
			return fmt.Errorf("SMTP_PORT inválido: %q", v)
		}
		m.SMTP.Port = n
	}
	m.Driver = strings.ToLower(strings.TrimSpace(os.Getenv("MAILER_DRIVER")))
	switch m.Driver {
	case "":
		m.Driver = "log"
		if m.SMTP.Host != "" {
			m.Driver = "smtp"
		}
	case "smtp", "log":
	default:
		return fmt.Errorf("MAILER_DRIVER inválido: %q (use smtp ou log)", m.Driver)
	}
	if m.Driver == "smtp" && m.SMTP.Host == "" {
		// Sem SMTP_HOST o app sobe em modo degradado em vez de recusar o boot (ver SPEC 5.5).
		m.Driver = "log"
	}
	if m.Driver == "smtp" && m.SMTP.From == "" {
		return errors.New("SMTP_HOST definido sem SMTP_FROM")
	}
	m.LogActive = os.Getenv("MAIL_FLOWS_ON_LOG") == "true"
	m.RequireVerification = os.Getenv("REQUIRE_EMAIL_VERIFICATION") == "true"
	if !c.IsDev() && c.PublicURL == "" && (m.Driver == "smtp" || c.Google.Enabled() || c.Discord.Enabled()) {
		return errors.New("PUBLIC_URL é obrigatória com SMTP ou login social (base dos links e callbacks)")
	}
	return nil
}

// defaultMetricsURL deriva o Prometheus do LiveKit (porta 6789) do host da API interna.
func defaultMetricsURL(internal string) string {
	u, err := url.Parse(internal)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	return "http://" + net.JoinHostPort(u.Hostname(), "6789") + "/metrics"
}

func (c Config) IsDev() bool { return c.Env == "development" }

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// loadAdmin lê as variáveis do histórico do painel e os limites nomeados por ação (RATELIMIT_*_PER_MIN).
func loadAdmin(c *Config) error {
	c.LiveKitSamplesRetentionDays = 35
	if v := os.Getenv("LIVEKIT_SAMPLES_RETENTION_DAYS"); v != "" {
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 2 || n > 365 {
			return fmt.Errorf("LIVEKIT_SAMPLES_RETENTION_DAYS inválido (2 a 365): %q", v)
		}
		c.LiveKitSamplesRetentionDays = n
	}
	if v := os.Getenv("LIVEKIT_MONTHLY_TRAFFIC_GB"); v != "" {
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil || f <= 0 || f > 1e7 {
			return fmt.Errorf("LIVEKIT_MONTHLY_TRAFFIC_GB inválido (maior que 0): %q", v)
		}
		c.LiveKit.MonthlyTrafficGB = f
	}
	c.AdminDiskPath = strings.TrimSpace(os.Getenv("ADMIN_DISK_PATH"))
	if c.AdminDiskPath == "" {
		c.AdminDiskPath = "/"
	}
	for _, kv := range os.Environ() {
		key, val, _ := strings.Cut(kv, "=")
		name, ok := strings.CutPrefix(key, "RATELIMIT_")
		if !ok {
			continue
		}
		name, ok = strings.CutSuffix(name, "_PER_MIN")
		if !ok || name == "" || strings.TrimSpace(val) == "" {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(val))
		if err != nil || n < 1 || n > 100000 {
			return fmt.Errorf("%s inválido (1 a 100000 por minuto): %q", key, val)
		}
		if c.RateLimitPerMin == nil {
			c.RateLimitPerMin = map[string]int{}
		}
		c.RateLimitPerMin[strings.ToLower(name)] = n
	}
	return nil
}
