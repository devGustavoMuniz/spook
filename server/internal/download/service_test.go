package download

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const sampleRelease = `{
 "tag_name":"desktop-v0.2.0","published_at":"2026-11-02T12:00:00Z","html_url":"https://github.com/o/r/releases/tag/desktop-v0.2.0",
 "assets":[
  {"name":"Spook-0.2.0-windows-x64.exe","size":90,"browser_download_url":"https://x/Spook-0.2.0-windows-x64.exe","digest":"sha256:` + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + `"},
  {"name":"Spook-0.2.0-windows-x64.exe.sha256","size":1,"browser_download_url":"https://x/Spook-0.2.0-windows-x64.exe.sha256"},
  {"name":"Spook-0.2.0-windows-x64.exe.sig","size":1,"browser_download_url":"https://x/sig"},
  {"name":"Spook-0.2.0-macos-arm64.app.tar.gz","size":1,"browser_download_url":"https://x/bundle"},
  {"name":"Spook-0.2.0-linux-x64.AppImage","size":5,"browser_download_url":"https://x/a.AppImage","digest":"md5:zz"},
  {"name":"latest.json","size":1,"browser_download_url":"https://x/latest.json"}
 ]}`

func TestParseRelease(t *testing.T) {
	r, err := parseRelease([]byte(sampleRelease), "fallback")
	if err != nil || r == nil {
		t.Fatalf("parse: %v %v", r, err)
	}
	if r.Version != "0.2.0" || r.PublishedAt == nil || *r.PublishedAt != "2026-11-02T12:00:00Z" || !strings.HasSuffix(r.PageURL, "desktop-v0.2.0") {
		t.Fatalf("metadados: %+v", r)
	}
	if len(r.Installers) != 2 {
		t.Fatalf("instaladores: %+v", r.Installers)
	}
	w := r.Installers[0]
	if w.OS != "windows" || w.Arch != "x64" || w.Kind != "exe" || w.Size != 90 {
		t.Fatalf("windows: %+v", w)
	}
	if w.SHA256 == nil || *w.SHA256 != strings.Repeat("a", 64) || w.ChecksumURL == nil || !strings.HasSuffix(*w.ChecksumURL, ".exe.sha256") {
		t.Fatalf("checksum: %+v", w)
	}
	l := r.Installers[1]
	if l.Kind != "AppImage" || l.SHA256 != nil || l.ChecksumURL != nil {
		t.Fatalf("linux: %+v", l)
	}
}

func TestParseReleaseWithoutInstallers(t *testing.T) {
	r, err := parseRelease([]byte(`{"tag_name":"x","assets":[{"name":"notes.txt","browser_download_url":"u"}]}`), "f")
	if r != nil || err != nil {
		t.Fatalf("esperava (nil, nil): %v %v", r, err)
	}
	if _, err := parseRelease([]byte("<html>"), "f"); err == nil {
		t.Fatal("JSON inválido deveria falhar")
	}
}

func TestParseReleaseFallbackPage(t *testing.T) {
	r, _ := parseRelease([]byte(`{"tag_name":"v1.0","assets":[{"name":"Spook-1.0-macos-x64.dmg","browser_download_url":"u"}]}`), "https://fb")
	if r == nil || r.PageURL != "https://fb" || r.Version != "1.0" || r.PublishedAt != nil {
		t.Fatalf("%+v", r)
	}
}

type fakeSrc struct {
	mu      sync.Mutex
	calls   int
	etags   []string
	body    string
	err     error
	nm      bool
	release chan struct{} // se não nulo, bloqueia a busca até fechar
}

func (f *fakeSrc) Latest(_ context.Context, etag string) ([]byte, string, bool, error) {
	if f.release != nil {
		<-f.release
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.etags = append(f.etags, etag)
	if f.err != nil {
		return nil, "", false, f.err
	}
	if f.nm {
		return nil, etag, true, nil
	}
	return []byte(f.body), `W/"e1"`, false, nil
}

func newTestService(src Source) (*Service, *time.Time) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	s := NewService(src, "https://page")
	s.now = func() time.Time { return now }
	return s, &now
}

func TestCacheTTL(t *testing.T) {
	src := &fakeSrc{body: sampleRelease}
	s, now := newTestService(src)
	ctx := context.Background()
	for range 3 {
		if r, err := s.Latest(ctx); err != nil || r.Version != "0.2.0" {
			t.Fatalf("%v %v", r, err)
		}
	}
	if src.calls != 1 {
		t.Fatalf("dentro do TTL deveria buscar 1 vez, buscou %d", src.calls)
	}
	*now = now.Add(TTL + time.Second)
	if _, err := s.Latest(ctx); err != nil {
		t.Fatal(err)
	}
	if src.calls != 2 || src.etags[1] != `W/"e1"` {
		t.Fatalf("depois do TTL deveria revalidar com ETag: calls=%d etags=%v", src.calls, src.etags)
	}
}

func TestNotModifiedKeepsRelease(t *testing.T) {
	src := &fakeSrc{body: sampleRelease}
	s, now := newTestService(src)
	ctx := context.Background()
	if _, err := s.Latest(ctx); err != nil {
		t.Fatal(err)
	}
	src.nm = true
	*now = now.Add(TTL + time.Second)
	r, err := s.Latest(ctx)
	if err != nil || r.Version != "0.2.0" {
		t.Fatalf("%v %v", r, err)
	}
	*now = now.Add(time.Minute) // o 304 renovou o TTL
	if _, err := s.Latest(ctx); err != nil || src.calls != 2 {
		t.Fatalf("calls=%d err=%v", src.calls, err)
	}
}

func TestSingleflight(t *testing.T) {
	src := &fakeSrc{body: sampleRelease, release: make(chan struct{})}
	s, _ := newTestService(src)
	var wg sync.WaitGroup
	var ok atomic.Int32
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r, err := s.Latest(context.Background()); err == nil && r != nil {
				ok.Add(1)
			}
		}()
	}
	time.Sleep(100 * time.Millisecond) // todos entram na fila do singleflight
	close(src.release)
	wg.Wait()
	if ok.Load() != 10 {
		t.Fatalf("sucessos: %d", ok.Load())
	}
	if src.calls != 1 {
		t.Fatalf("esperava 1 busca, houve %d", src.calls)
	}
}

func TestStaleWhileError(t *testing.T) {
	src := &fakeSrc{body: sampleRelease}
	s, now := newTestService(src)
	ctx := context.Background()
	if _, err := s.Latest(ctx); err != nil {
		t.Fatal(err)
	}
	src.err = errors.New("github fora do ar")
	*now = now.Add(TTL + time.Minute)
	if r, err := s.Latest(ctx); err != nil || r.Version != "0.2.0" {
		t.Fatalf("deveria servir o último bom: %v %v", r, err)
	}
	*now = now.Add(StaleMax) // passou das 24 h desde a última busca boa
	if _, err := s.Latest(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("esperava 503 depois de 24 h: %v", err)
	}
}

func TestUnavailableWithoutCache(t *testing.T) {
	s, _ := newTestService(&fakeSrc{err: errors.New("boom com segredo")})
	_, err := s.Latest(context.Background())
	if !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "segredo") {
		t.Fatalf("%v", err)
	}
}

func TestNotFound(t *testing.T) {
	// 404 do GitHub e release sem instaladores viram a mesma resposta; ambos ficam em cache.
	for name, src := range map[string]*fakeSrc{
		"404":            {err: ErrNoRelease},
		"sem instalador": {body: `{"tag_name":"x","assets":[]}`},
	} {
		s, _ := newTestService(src)
		for range 2 {
			if _, err := s.Latest(context.Background()); !errors.Is(err, ErrNotFound) {
				t.Fatalf("%s: %v", name, err)
			}
		}
		if src.calls != 1 {
			t.Fatalf("%s: o 'sem versão' também fica em cache (buscas: %d)", name, src.calls)
		}
	}
}

func TestInvalidBodyIsFailure(t *testing.T) {
	s, _ := newTestService(&fakeSrc{body: "<html>"})
	if _, err := s.Latest(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("%v", err)
	}
}

func githubAt(t *testing.T, h http.HandlerFunc) *GitHub {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	g := NewGitHub("o/r", "")
	g.apiBase = srv.URL
	return g
}

func TestGitHubClientHeaders(t *testing.T) {
	var got *http.Request
	g := githubAt(t, func(w http.ResponseWriter, r *http.Request) {
		got = r
		w.Header().Set("ETag", `"abc"`)
		_, _ = w.Write([]byte(sampleRelease))
	})
	g.token = "tok"
	body, etag, nm, err := g.Latest(context.Background(), `"old"`)
	if err != nil || nm || etag != `"abc"` || len(body) == 0 {
		t.Fatalf("%v %v %q", err, nm, etag)
	}
	if got.URL.Path != "/repos/o/r/releases/latest" || got.Header.Get("User-Agent") != "spook-backend" ||
		got.Header.Get("Accept") != "application/vnd.github+json" || got.Header.Get("Authorization") != "Bearer tok" ||
		got.Header.Get("If-None-Match") != `"old"` {
		t.Fatalf("cabeçalhos: %v %s", got.Header, got.URL.Path)
	}
	g.token = ""
	g = githubAt(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("sem token não deve enviar Authorization")
		}
		_, _ = w.Write([]byte("{}"))
	})
	_, _, _, _ = g.Latest(context.Background(), "")
}

func TestGitHubClientStatuses(t *testing.T) {
	cases := map[int]func(error, bool) bool{
		http.StatusNotFound:            func(err error, _ bool) bool { return errors.Is(err, ErrNoRelease) },
		http.StatusNotModified:         func(err error, nm bool) bool { return err == nil && nm },
		http.StatusForbidden:           func(err error, _ bool) bool { return err != nil && !errors.Is(err, ErrNoRelease) },
		http.StatusInternalServerError: func(err error, _ bool) bool { return err != nil },
	}
	for code, check := range cases {
		g := githubAt(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) })
		_, _, nm, err := g.Latest(context.Background(), `"e"`)
		if !check(err, nm) {
			t.Errorf("status %d: err=%v nm=%v", code, err, nm)
		}
	}
}

func TestGitHubClientBodyLimit(t *testing.T) {
	g := githubAt(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", maxBodyBytes+1)))
	})
	if _, _, _, err := g.Latest(context.Background(), ""); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("%v", err)
	}
	g = githubAt(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", maxBodyBytes)))
	})
	if _, _, _, err := g.Latest(context.Background(), ""); err != nil {
		t.Fatalf("no limite exato deve passar: %v", err)
	}
}

func TestGitHubClientErrorDoesNotLeakToken(t *testing.T) {
	g := NewGitHub("o/r", "segredo-token")
	g.apiBase = "http://127.0.0.1:1"
	_, _, _, err := g.Latest(context.Background(), "")
	if err == nil || strings.Contains(err.Error(), "segredo-token") {
		t.Fatalf("%v", err)
	}
}
