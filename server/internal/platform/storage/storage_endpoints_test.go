package storage

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// As operações do servidor (HEAD/GET/PUT/DELETE) vão ao endpoint INTERNO; só a assinatura de URLs usa o PÚBLICO.
func TestServerSideOpsUseInternalEndpointAndPresignUsesPublic(t *testing.T) {
	var hits []string
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Length", "12")
		w.Header().Set("Content-Type", "image/png")
	}))
	defer internal.Close()

	st, err := New(context.Background(), Config{
		Endpoint: "https://publico.exemplo.test", InternalEndpoint: internal.URL,
		Region: "garage", Bucket: "spook", AccessKeyID: "AK", SecretAccessKey: "SK",
	})
	if err != nil {
		t.Fatal(err)
	}

	info, err := st.Stat(context.Background(), "attachments/1/2/a.png")
	if err != nil {
		t.Fatalf("Stat deveria usar o endpoint interno: %v", err)
	}
	if info.Size != 12 || info.ContentType != "image/png" {
		t.Fatalf("metadados inesperados: %+v", info)
	}
	if len(hits) != 1 || hits[0] != "HEAD /spook/attachments/1/2/a.png" {
		t.Fatalf("requisições ao endpoint interno = %v", hits)
	}

	put, err := st.PresignPut(context.Background(), "k.png", "image/png", 10, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	get, err := st.PresignGet(context.Background(), "k.png", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{put, get} {
		u, err := url.Parse(raw)
		if err != nil || u.Host != "publico.exemplo.test" || !strings.HasPrefix(raw, "https://") {
			t.Fatalf("URL pré-assinada deve apontar para o endpoint público: %s", raw)
		}
	}
	if len(hits) != 1 {
		t.Fatal("assinar URLs não pode fazer requisições")
	}
}

// Sem InternalEndpoint, tudo usa o mesmo endereço (compatível com o comportamento anterior).
func TestInternalEndpointDefaultsToPublic(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.Header().Set("Content-Length", "1")
	}))
	defer srv.Close()
	st, err := New(context.Background(), Config{Endpoint: srv.URL, Region: "garage", Bucket: "b", AccessKeyID: "a", SecretAccessKey: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Stat(context.Background(), "k"); err != nil || hits != 1 {
		t.Fatalf("err=%v hits=%d", err, hits)
	}
}
