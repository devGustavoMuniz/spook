package config

import (
	"testing"
	"time"
)

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "")
	if _, err := Load(); err == nil {
		t.Fatal("esperava erro sem SPOOK_DATABASE_URL")
	}
}

func TestLoadDefaults(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	t.Setenv("SPOOK_ADDR", "")
	t.Setenv("SPOOK_ENV", "")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":8090" || !c.IsDev() {
		t.Fatalf("defaults inesperados: %+v", c)
	}
}

func TestLoadS3RequiresCredentials(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	t.Setenv("S3_ENDPOINT", "http://s3")
	t.Setenv("S3_ACCESS_KEY_ID", "")
	if _, err := Load(); err == nil {
		t.Fatal("esperava erro: S3 sem credenciais")
	}
}

func TestLoadInvalidNodeID(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	t.Setenv("SPOOK_NODE_ID", "abc")
	if _, err := Load(); err == nil {
		t.Fatal("esperava erro para SPOOK_NODE_ID inválido")
	}
}

func TestLoadAllowedOrigins(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.AllowedOrigins) != 2 || c.AllowedOrigins[0] != "tauri://localhost" || c.AllowedOrigins[1] != "http://tauri.localhost" {
		t.Fatalf("padrão = %v", c.AllowedOrigins)
	}
	t.Setenv("SPOOK_ALLOWED_ORIGINS", " https://a.example , ,tauri://localhost ")
	c, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.AllowedOrigins) != 2 || c.AllowedOrigins[0] != "https://a.example" {
		t.Fatalf("lista = %v", c.AllowedOrigins)
	}
	t.Setenv("SPOOK_ALLOWED_ORIGINS", "")
	if c, _ = Load(); len(c.AllowedOrigins) != 0 {
		t.Fatalf("vazio explícito desliga as origens extras: %v", c.AllowedOrigins)
	}
}

func TestLoadPresenceOfflineGrace(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	c, err := Load()
	if err != nil || c.PresenceOfflineGrace != 0 {
		t.Fatalf("padrão = %v, %v", c.PresenceOfflineGrace, err)
	}
	t.Setenv("SPOOK_PRESENCE_OFFLINE_GRACE", "2s")
	if c, err = Load(); err != nil || c.PresenceOfflineGrace != 2*time.Second {
		t.Fatalf("2s = %v, %v", c.PresenceOfflineGrace, err)
	}
	t.Setenv("SPOOK_PRESENCE_OFFLINE_GRACE", "abc")
	if _, err = Load(); err == nil {
		t.Fatal("esperava erro para duração inválida")
	}
}

func TestLiveKitConfig(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	for _, k := range []string{"LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_INTERNAL_URL"} {
		t.Setenv(k, "")
	}
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.LiveKit.Enabled() || c.LiveKit.InternalURL != "http://livekit:7880" {
		t.Fatalf("sem LIVEKIT_*: voz desligada e URL interna padrão, veio %+v", c.LiveKit)
	}
	t.Setenv("LIVEKIT_URL", "ws://localhost:7880")
	t.Setenv("LIVEKIT_API_KEY", "devkey")
	if c, _ = Load(); c.LiveKit.Enabled() {
		t.Fatal("sem o segredo a voz continua desligada")
	}
	t.Setenv("LIVEKIT_API_SECRET", "segredo")
	t.Setenv("LIVEKIT_INTERNAL_URL", "http://lk:7880")
	if c, _ = Load(); !c.LiveKit.Enabled() || c.LiveKit.InternalURL != "http://lk:7880" || c.LiveKit.URL != "ws://localhost:7880" {
		t.Fatalf("config = %+v", c.LiveKit)
	}
}

func TestLoadVAPIDAllOrNothing(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	for _, k := range []string{"VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"} {
		t.Setenv(k, "")
	}
	c, err := Load()
	if err != nil || c.VAPID.Enabled() || c.VAPID.Partial() {
		t.Fatalf("sem VAPID: push desligado e sem aviso (%+v, %v)", c.VAPID, err)
	}
	t.Setenv("VAPID_PUBLIC_KEY", " pub ")
	c, _ = Load()
	if c.VAPID.Enabled() || !c.VAPID.Partial() || c.VAPID.PublicKey != "pub" {
		t.Fatalf("só uma variável: desligado e parcial (%+v)", c.VAPID)
	}
	t.Setenv("VAPID_PRIVATE_KEY", "priv")
	t.Setenv("VAPID_SUBJECT", "mailto:a@b.c")
	c, _ = Load()
	if !c.VAPID.Enabled() || c.VAPID.Partial() {
		t.Fatalf("as três: ligado (%+v)", c.VAPID)
	}
}

func TestLoadS3InternalEndpoint(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	t.Setenv("S3_ENDPOINT", "https://publico.test")
	t.Setenv("S3_ACCESS_KEY_ID", "a")
	t.Setenv("S3_SECRET_ACCESS_KEY", "s")
	t.Setenv("S3_INTERNAL_ENDPOINT", "http://garage:3900")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.S3.Endpoint != "https://publico.test" || c.S3.InternalEndpoint != "http://garage:3900" {
		t.Fatalf("S3 = %+v", c.S3)
	}
}

func TestLoadAdminUsernamesAndMetricsURL(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	t.Setenv("ADMIN_USERNAMES", " Gustavo , ,admin2 ")
	t.Setenv("LIVEKIT_METRICS_URL", "")
	t.Setenv("LIVEKIT_INTERNAL_URL", "http://livekit:7880")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.AdminUsernames) != 2 || c.AdminUsernames[0] != "gustavo" || c.AdminUsernames[1] != "admin2" {
		t.Fatalf("AdminUsernames = %v", c.AdminUsernames)
	}
	if c.LiveKit.MetricsURL != "http://livekit:6789/metrics" {
		t.Fatalf("MetricsURL = %q", c.LiveKit.MetricsURL)
	}
	t.Setenv("LIVEKIT_METRICS_URL", "http://outro:1/m")
	if c, _ = Load(); c.LiveKit.MetricsURL != "http://outro:1/m" {
		t.Fatalf("MetricsURL explícita ignorada: %q", c.LiveKit.MetricsURL)
	}
}

func TestMailConfig(t *testing.T) {
	base := func(t *testing.T) {
		t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
		for _, k := range []string{"SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_USER", "SMTP_PASSWORD", "MAILER_DRIVER", "PUBLIC_URL",
			"MAIL_FLOWS_ON_LOG", "REQUIRE_EMAIL_VERIFICATION", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"} {
			t.Setenv(k, "")
		}
	}
	t.Run("sem SMTP: driver log, degradado", func(t *testing.T) {
		base(t)
		t.Setenv("SPOOK_ENV", "production")
		c, err := Load()
		if err != nil || c.Mail.Driver != "log" || c.Mail.Enabled() || c.Mail.RequireVerification {
			t.Fatalf("%+v %v", c.Mail, err)
		}
	})
	t.Run("MAILER_DRIVER=smtp sem host cai para log (degradado)", func(t *testing.T) {
		base(t)
		t.Setenv("MAILER_DRIVER", "smtp")
		c, err := Load()
		if err != nil || c.Mail.Driver != "log" {
			t.Fatalf("%+v %v", c.Mail, err)
		}
	})
	t.Run("SMTP completo", func(t *testing.T) {
		base(t)
		t.Setenv("SPOOK_ENV", "production")
		t.Setenv("SMTP_HOST", "smtp.exemplo.com")
		t.Setenv("SMTP_FROM", "Spook <no-reply@exemplo.com>")
		t.Setenv("PUBLIC_URL", "https://spook.exemplo.com/")
		t.Setenv("REQUIRE_EMAIL_VERIFICATION", "true")
		c, err := Load()
		if err != nil || c.Mail.Driver != "smtp" || c.Mail.SMTP.Port != 587 || !c.Mail.Enabled() || c.PublicURL != "https://spook.exemplo.com" || !c.Mail.RequireVerification {
			t.Fatalf("%+v %v", c, err)
		}
	})
	t.Run("SMTP sem remetente", func(t *testing.T) {
		base(t)
		t.Setenv("SMTP_HOST", "smtp.exemplo.com")
		if _, err := Load(); err == nil {
			t.Fatal("deveria exigir SMTP_FROM")
		}
	})
	t.Run("produção com SMTP ou social exige PUBLIC_URL", func(t *testing.T) {
		base(t)
		t.Setenv("SPOOK_ENV", "production")
		t.Setenv("GOOGLE_CLIENT_ID", "id")
		t.Setenv("GOOGLE_CLIENT_SECRET", "segredo")
		if _, err := Load(); err == nil {
			t.Fatal("deveria exigir PUBLIC_URL")
		}
	})
	t.Run("provedor social só liga com id e segredo", func(t *testing.T) {
		base(t)
		t.Setenv("DISCORD_CLIENT_ID", "id")
		c, err := Load()
		if err != nil || c.Discord.Enabled() || c.Google.Enabled() {
			t.Fatalf("%+v %v", c, err)
		}
		if c.PublicURL != "http://localhost:8090" {
			t.Fatalf("PUBLIC_URL padrão em dev: %s", c.PublicURL)
		}
	})
	t.Run("valores inválidos", func(t *testing.T) {
		base(t)
		t.Setenv("MAILER_DRIVER", "pombo")
		if _, err := Load(); err == nil {
			t.Fatal("driver inválido")
		}
		base(t)
		t.Setenv("SMTP_PORT", "abc")
		if _, err := Load(); err == nil {
			t.Fatal("porta inválida")
		}
	})
}

func TestLoadLimits(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Limits.GuildsPerUser != 100 || c.Limits.AttachmentBytes != 25<<20 || c.EveryonePushMax != 200 {
		t.Fatalf("padrões: %+v %d", c.Limits, c.EveryonePushMax)
	}
	t.Setenv("LIMIT_GUILDS_PER_USER", "5")
	t.Setenv("LIMIT_ATTACHMENT_MB", "10")
	t.Setenv("LIMIT_ROLES_PER_GUILD", "20")
	t.Setenv("EVERYONE_PUSH_MAX", "0")
	c, err = Load()
	if err != nil || c.Limits.GuildsPerUser != 5 || c.Limits.AttachmentBytes != 10<<20 || c.Limits.RolesPerGuild != 20 || c.EveryonePushMax != 0 {
		t.Fatalf("configurados: %+v %d %v", c.Limits, c.EveryonePushMax, err)
	}
	for env, v := range map[string]string{"LIMIT_GUILDS_PER_USER": "0", "LIMIT_CHANNELS_PER_GUILD": "abc", "LIMIT_ATTACHMENT_MB": "101", "LIMIT_ROLES_PER_GUILD": "1", "EVERYONE_PUSH_MAX": "-1"} {
		t.Run(env, func(t *testing.T) {
			t.Setenv(env, v)
			if _, err := Load(); err == nil {
				t.Fatalf("%s=%s deveria recusar o boot", env, v)
			}
		})
	}
}

func TestLoadAdminHistoryAndRateLimitOverrides(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.LiveKitSamplesRetentionDays != 35 || c.AdminDiskPath != "/" || c.LiveKit.MonthlyTrafficGB != 0 || len(c.RateLimitPerMin) != 0 {
		t.Fatalf("padrões = %+v", c)
	}
	t.Setenv("LIVEKIT_SAMPLES_RETENTION_DAYS", "10")
	t.Setenv("LIVEKIT_MONTHLY_TRAFFIC_GB", "250.5")
	t.Setenv("ADMIN_DISK_PATH", "/data")
	t.Setenv("RATELIMIT_SERVERS_CREATE_PER_MIN", "3")
	t.Setenv("RATELIMIT_VOICE_TOKEN_PER_MIN", "7")
	c, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.LiveKitSamplesRetentionDays != 10 || c.AdminDiskPath != "/data" || c.LiveKit.MonthlyTrafficBytes() != 250_500_000_000 ||
		c.RateLimitPerMin["servers_create"] != 3 || c.RateLimitPerMin["voice_token"] != 7 {
		t.Fatalf("lidos = %+v", c)
	}
	for k, v := range map[string]string{
		"LIVEKIT_SAMPLES_RETENTION_DAYS": "1", "LIVEKIT_MONTHLY_TRAFFIC_GB": "-3", "RATELIMIT_X_PER_MIN": "0",
	} {
		t.Setenv(k, v)
		if _, err := Load(); err == nil {
			t.Fatalf("%s=%s deveria ser recusado", k, v)
		}
		t.Setenv(k, "")
	}
}

func TestLoadGitHubReleasesRepo(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	t.Setenv("GITHUB_RELEASES_REPO", "")
	t.Setenv("GITHUB_TOKEN", " tok ")
	c, err := Load()
	if err != nil || c.GitHubReleasesRepo != "devGustavoMuniz/spook" || c.GitHubToken != "tok" {
		t.Fatalf("padrão: %v %+v", err, c.GitHubReleasesRepo)
	}
	t.Setenv("GITHUB_RELEASES_REPO", "outro/repo-x")
	if c, err = Load(); err != nil || c.GitHubReleasesRepo != "outro/repo-x" {
		t.Fatalf("custom: %v", err)
	}
	for _, bad := range []string{"semBarra", "a/b/c", "a b/c", "/repo", "dono/"} {
		t.Setenv("GITHUB_RELEASES_REPO", bad)
		if _, err := Load(); err == nil {
			t.Errorf("%q deveria ser recusado", bad)
		}
	}
}

func TestLoadBilling(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	t.Setenv("MERCADOPAGO_ACCESS_TOKEN", "")
	t.Setenv("MERCADOPAGO_WEBHOOK_SECRET", "")
	t.Setenv("NITRO_PRICE_CENTS", "")
	t.Setenv("NITRO_PLUS_PRICE_CENTS", "")
	c, err := Load()
	if err != nil || c.Billing.Enabled() || c.Billing.NitroCents != 1490 || c.Billing.NitroPlusCents != 2990 {
		t.Fatalf("padrão desligado: %+v, %v", c.Billing, err)
	}
	t.Setenv("MERCADOPAGO_ACCESS_TOKEN", "TEST-token")
	if _, err := Load(); err == nil {
		t.Fatal("token sem chave do webhook deveria falhar")
	}
	t.Setenv("MERCADOPAGO_WEBHOOK_SECRET", "chave")
	t.Setenv("NITRO_PRICE_CENTS", "990")
	c, err = Load()
	if err != nil || !c.Billing.Enabled() || c.Billing.NitroCents != 990 {
		t.Fatalf("ligado: %+v, %v", c.Billing, err)
	}
	t.Setenv("NITRO_PLUS_PRICE_CENTS", "abc")
	if _, err := Load(); err == nil {
		t.Fatal("preço inválido deveria falhar")
	}
}

func TestLoadTrial(t *testing.T) {
	t.Setenv("SPOOK_DATABASE_URL", "postgres://x")
	t.Setenv("NITRO_TRIAL_DAYS", "")
	t.Setenv("NITRO_TRIAL_TIER", "")
	c, err := Load()
	if err != nil || c.NitroTrialDays != 14 || c.NitroTrialTier != "nitro_plus" {
		t.Fatalf("padrão 14 dias de nitro_plus: %d %q %v", c.NitroTrialDays, c.NitroTrialTier, err)
	}
	t.Setenv("NITRO_TRIAL_DAYS", "0")
	t.Setenv("NITRO_TRIAL_TIER", "NITRO")
	c, err = Load()
	if err != nil || c.NitroTrialDays != 0 || c.NitroTrialTier != "nitro" {
		t.Fatalf("0 desliga e o plano é normalizado: %d %q %v", c.NitroTrialDays, c.NitroTrialTier, err)
	}
	for _, bad := range [][2]string{{"abc", ""}, {"-1", ""}, {"3651", ""}, {"7", "free"}, {"7", "premium"}} {
		t.Setenv("NITRO_TRIAL_DAYS", bad[0])
		t.Setenv("NITRO_TRIAL_TIER", bad[1])
		if _, err := Load(); err == nil {
			t.Fatalf("%v deveria recusar o boot", bad)
		}
	}
}
