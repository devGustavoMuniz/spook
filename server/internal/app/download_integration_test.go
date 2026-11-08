//go:build integration

package app

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	dlfeature "github.com/devGustavoMuniz/spook/server/internal/download"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

type stubDownloadSource struct {
	body  string
	err   error
	calls atomic.Int32
}

func (s *stubDownloadSource) Latest(context.Context, string) ([]byte, string, bool, error) {
	s.calls.Add(1)
	return []byte(s.body), `"v1"`, false, s.err
}

const downloadBody = `{"tag_name":"desktop-v0.3.0","published_at":"2026-11-07T10:00:00Z","html_url":"https://github.com/o/r/releases/tag/desktop-v0.3.0",
"assets":[{"name":"Spook-0.3.0-windows-x64.exe","size":10,"browser_download_url":"https://x/a.exe"},
{"name":"Spook-0.3.0-windows-x64.exe.sha256","size":1,"browser_download_url":"https://x/a.exe.sha256"},
{"name":"latest.json","size":1,"browser_download_url":"https://x/latest.json"}]}`

// A rota é pública (sem cookie nem Bearer) e usa só o dublê: nenhum teste fala com a rede real do GitHub.
func TestDownloadLatestIsPublic(t *testing.T) {
	src := &stubDownloadSource{body: downloadBody}
	e := newEnvWith(t, func(d *Deps) { d.DownloadSource = src })
	resp, b := e.do(t, "GET", "/api/downloads/latest", nil, nil)
	status(t, resp, b, 200)
	if cc := resp.Header.Get("Cache-Control"); cc != "public, max-age=60" || resp.Header.Get("ETag") == "" {
		t.Fatalf("cabeçalhos: %v", resp.Header)
	}
	for _, want := range []string{`"version":"0.3.0"`, `"os":"windows"`, `"kind":"exe"`, `"checksum_url":"https://x/a.exe.sha256"`, `"sha256":null`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("faltou %s em %s", want, b)
		}
	}
	resp, b = e.do(t, "GET", "/api/downloads/latest", nil, map[string]string{"If-None-Match": resp.Header.Get("ETag")})
	status(t, resp, b, 304)
	if src.calls.Load() != 1 {
		t.Fatalf("o cache deveria evitar novas buscas: %d", src.calls.Load())
	}
}

func TestDownloadLatestNotFoundAndUnavailable(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) { d.DownloadSource = &stubDownloadSource{err: dlfeature.ErrNoRelease} })
	resp, b := e.do(t, "GET", "/api/downloads/latest", nil, nil)
	status(t, resp, b, 404)
	if !strings.Contains(resp.Header.Get("Content-Type"), "problem+json") {
		t.Fatalf("formato de erro: %v %s", resp.Header, b)
	}

	e = newEnvWith(t, func(d *Deps) {
		d.DownloadSource = &stubDownloadSource{err: errors.New("github: tls handshake de 10.0.0.1")}
	})
	resp, b = e.do(t, "GET", "/api/downloads/latest", nil, nil)
	status(t, resp, b, 503)
	if strings.Contains(string(b), "10.0.0.1") || strings.Contains(string(b), "tls") {
		t.Fatalf("503 vazou detalhes: %s", b)
	}
}

// A rota passa pelo limitador por IP de /api/*.
func TestDownloadLatestIsRateLimited(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		d.DownloadSource = &stubDownloadSource{body: downloadBody}
		d.APILimiter = ratelimit.New(0.001, 2)
	})
	for range 2 {
		resp, b := e.do(t, "GET", "/api/downloads/latest", nil, nil)
		status(t, resp, b, 200)
	}
	resp, b := e.do(t, "GET", "/api/downloads/latest", nil, nil)
	status(t, resp, b, 429)
}
