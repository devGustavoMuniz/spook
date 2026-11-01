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
