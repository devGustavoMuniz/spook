// Package config carrega a configuração do processo a partir de variáveis de ambiente.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
)

type S3 struct {
	Endpoint        string // endpoint público: as URLs pré-assinadas são entregues ao navegador
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
}

func (s S3) Enabled() bool { return s.Endpoint != "" }

type Config struct {
	Addr         string
	Env          string
	DatabaseURL  string
	OTLPEndpoint string
	NodeID       int64  // nó do Snowflake (0..1023)
	WebDir       string // build do front servido pelo backend; vazio desliga
	RealIPHeader string // ex.: CF-Connecting-IP atrás do Cloudflare Tunnel
	S3           S3
}

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
