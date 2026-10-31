package config

import "testing"

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
