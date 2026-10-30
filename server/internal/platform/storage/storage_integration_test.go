//go:build integration

package storage

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"testing"
	"time"
)

func env(t *testing.T, k string) string {
	t.Helper()
	v := os.Getenv(k)
	if v == "" {
		t.Fatalf("variável %s não definida (rode via `pnpm test:integration`)", k)
	}
	return v
}

func newStore(t *testing.T) (*Store, Config) {
	t.Helper()
	cfg := Config{
		Endpoint:        env(t, "S3_ENDPOINT"),
		Region:          env(t, "S3_REGION"),
		Bucket:          env(t, "S3_BUCKET"),
		AccessKeyID:     env(t, "S3_ACCESS_KEY_ID"),
		SecretAccessKey: env(t, "S3_SECRET_ACCESS_KEY"),
	}
	s, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s, cfg
}

func do(t *testing.T, method, url, contentType string, body []byte) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestPresignedRoundTrip(t *testing.T) {
	ctx := context.Background()
	s, _ := newStore(t)
	key := "integration/" + time.Now().Format("20060102T150405.000000000") + ".txt"
	payload := []byte("olá, spook! \x00\x01\x02")

	putURL, err := s.PresignPut(ctx, key, "text/plain", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if resp := do(t, http.MethodPut, putURL, "text/plain", payload); resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT = %d: %s", resp.StatusCode, b)
	}

	getURL, err := s.PresignGet(ctx, key, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	resp := do(t, http.MethodGet, getURL, "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET = %d", resp.StatusCode)
	}
	got, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(got, payload) {
		t.Fatalf("conteúdo diferente: %q", got)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/plain" {
		t.Fatalf("Content-Type = %q", ct)
	}
}

func TestPresignedPutRejectsOtherContentType(t *testing.T) {
	s, _ := newStore(t)
	putURL, err := s.PresignPut(context.Background(), "integration/ct.bin", "image/png", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if resp := do(t, http.MethodPut, putURL, "application/x-evil", []byte("x")); resp.StatusCode == http.StatusOK {
		t.Fatal("PUT com Content-Type diferente do assinado deveria falhar")
	}
}

func TestPresignedURLExpires(t *testing.T) {
	s, _ := newStore(t)
	getURL, err := s.PresignGet(context.Background(), "integration/qualquer", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(2500 * time.Millisecond)
	resp := do(t, http.MethodGet, getURL, "", nil)
	body, _ := io.ReadAll(resp.Body)
	// O Garage responde 400 (AWS responde 403); o que importa é a URL ser recusada por expiração.
	if resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("URL expirada deveria ser recusada (400/403), deu %d", resp.StatusCode)
	}
	if !bytes.Contains(body, []byte("too old")) {
		t.Fatalf("recusa não menciona data expirada: %s", body)
	}
}

func TestBucketCORS(t *testing.T) {
	s, cfg := newStore(t)
	origin := env(t, "S3_CORS_ORIGINS")
	putURL, err := s.PresignPut(context.Background(), "integration/cors.bin", "image/png", time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest(http.MethodOptions, putURL, nil)
	req.Header.Set("Origin", origin)
	req.Header.Set("Access-Control-Request-Method", "PUT")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("preflight = %d (bucket %s)", resp.StatusCode, cfg.Bucket)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != origin {
		t.Fatalf("Allow-Origin = %q, esperado %q", got, origin)
	}

	// Origem não autorizada: o preflight precisa falhar (o navegador exige 2xx para liberar o PUT).
	// O Garage responde 403 e, nesse erro, ainda inclui `Allow-Origin: *`; é inofensivo com preflight recusado.
	req.Header.Set("Origin", "https://evil.example")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusForbidden {
		t.Fatalf("preflight de origem não autorizada = %d, esperado 403", resp2.StatusCode)
	}
}
