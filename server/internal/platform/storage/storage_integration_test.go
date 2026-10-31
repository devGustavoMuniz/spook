//go:build integration

package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
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

	putURL, err := s.PresignPut(ctx, key, "text/plain", int64(len(payload)), time.Minute)
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
	putURL, err := s.PresignPut(context.Background(), "integration/ct.bin", "image/png", 1, time.Minute)
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
	// S3_CORS_ORIGINS é uma lista separada por vírgula; o preflight usa uma origem só (a primeira).
	origin := strings.TrimSpace(strings.Split(env(t, "S3_CORS_ORIGINS"), ",")[0])
	putURL, err := s.PresignPut(context.Background(), "integration/cors.bin", "image/png", 1, time.Minute)
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

func TestStatGetRangePutDelete(t *testing.T) {
	ctx := context.Background()
	s, _ := newStore(t)
	key := "integration/ops-" + time.Now().Format("20060102T150405.000000000") + ".bin"
	data := []byte("0123456789abcdefghij")

	if _, err := s.Stat(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Stat de objeto inexistente: %v", err)
	}
	if _, err := s.Get(ctx, key, 100); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get de objeto inexistente: %v", err)
	}
	if _, err := s.GetRange(ctx, key, 0, 4); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetRange de objeto inexistente: %v", err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatalf("Delete do que não existe não é erro: %v", err)
	}

	if err := s.Put(ctx, key, "application/zip", data); err != nil {
		t.Fatal(err)
	}
	info, err := s.Stat(ctx, key)
	if err != nil || info.Size != int64(len(data)) || info.ContentType != "application/zip" {
		t.Fatalf("Stat = %+v, %v", info, err)
	}
	head, err := s.GetRange(ctx, key, 0, 4)
	if err != nil || string(head) != "0123" {
		t.Fatalf("GetRange(0,4) = %q, %v", head, err)
	}
	mid, err := s.GetRange(ctx, key, 10, 5)
	if err != nil || string(mid) != "abcde" {
		t.Fatalf("GetRange(10,5) = %q, %v", mid, err)
	}
	all, err := s.GetRange(ctx, key, 0, 512) // intervalo maior que o objeto: devolve o que existe
	if err != nil || !bytes.Equal(all, data) {
		t.Fatalf("GetRange(0,512) = %q, %v", all, err)
	}
	got, err := s.Get(ctx, key, int64(len(data)))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if _, err := s.Get(ctx, key, int64(len(data))-1); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Get acima do limite: %v", err)
	}

	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Stat(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("depois de apagar: %v", err)
	}
}

func TestEmptyObjectGetRange(t *testing.T) {
	ctx := context.Background()
	s, _ := newStore(t)
	key := "integration/empty-" + time.Now().Format("20060102T150405.000000000")
	if err := s.Put(ctx, key, "text/plain", nil); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Delete(ctx, key) }()
	b, err := s.GetRange(ctx, key, 0, 512)
	if err != nil || len(b) != 0 {
		t.Fatalf("GetRange de objeto vazio = %q, %v", b, err)
	}
}

func TestPresignedPutRejectsOtherSize(t *testing.T) {
	s, _ := newStore(t)
	putURL, err := s.PresignPut(context.Background(), "integration/size.bin", "image/png", 3, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if resp := do(t, http.MethodPut, putURL, "image/png", []byte("mais de três bytes")); resp.StatusCode == http.StatusOK {
		t.Fatal("PUT com tamanho diferente do assinado deveria falhar")
	}
}
