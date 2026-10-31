// Package config carrega a configuração do processo a partir de variáveis de ambiente.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type S3 struct {
	Endpoint        string // endpoint público: as URLs pré-assinadas são entregues ao navegador
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
}

func (s S3) Enabled() bool { return s.Endpoint != "" }

// LiveKit reúne a configuração da voz (Fase 5). Sem URL, chave e segredo a voz fica desligada
// (os endpoints respondem 503).
type LiveKit struct {
	URL         string // URL pública para o cliente (wss://… em produção, ws://localhost:7880 em dev)
	APIKey      string
	APISecret   string
	InternalURL string // API server-to-server (padrão http://livekit:7880)
}

func (l LiveKit) Enabled() bool { return l.URL != "" && l.APIKey != "" && l.APISecret != "" }

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
	// AllowedOrigins são as origens extras aceitas no handshake do gateway, além do próprio host
	// (SPOOK_ALLOWED_ORIGINS, separadas por vírgula).
	AllowedOrigins []string
	// PresenceOfflineGrace é a tolerância antes de declarar offline quem perdeu a última sessão
	// (SPOOK_PRESENCE_OFFLINE_GRACE, duration do Go; zero = padrão de 15 s). Existe para o E2E usar
	// um valor curto; em produção deixe sem definir.
	PresenceOfflineGrace time.Duration
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
			Endpoint:        os.Getenv("S3_ENDPOINT"),
			Region:          getenv("S3_REGION", "garage"),
			Bucket:          getenv("S3_BUCKET", "spook"),
			AccessKeyID:     os.Getenv("S3_ACCESS_KEY_ID"),
			SecretAccessKey: os.Getenv("S3_SECRET_ACCESS_KEY"),
		},
		LiveKit: LiveKit{
			URL:         os.Getenv("LIVEKIT_URL"),
			APIKey:      os.Getenv("LIVEKIT_API_KEY"),
			APISecret:   os.Getenv("LIVEKIT_API_SECRET"),
			InternalURL: getenv("LIVEKIT_INTERNAL_URL", "http://livekit:7880"),
		},
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
	if c.S3.Enabled() && (c.S3.AccessKeyID == "" || c.S3.SecretAccessKey == "") {
		return Config{}, errors.New("S3_ENDPOINT definido sem S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY")
	}
	return c, nil
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
