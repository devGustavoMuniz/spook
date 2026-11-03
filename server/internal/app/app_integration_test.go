//go:build integration

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/devGustavoMuniz/spook/server/internal/platform/config"
	"github.com/devGustavoMuniz/spook/server/internal/platform/migrate"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/platform/storage"
)

func env(t *testing.T, k string) string {
	t.Helper()
	v := os.Getenv(k)
	if v == "" {
		t.Fatalf("variável %s não definida (rode via `pnpm --filter @spook/server test:integration`)", k)
	}
	return v
}

type testEnv struct {
	srv    *httptest.Server
	client *http.Client
	pool   *pgxpool.Pool
	app    *App
}

func newEnv(t *testing.T) *testEnv { return newEnvWith(t, nil) }

// newEnvWith monta o app real; tweak ajusta as dependências antes (limitadores, barramento de eventos).
func newEnvWith(t *testing.T, tweak func(*Deps)) *testEnv {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	pool, err := pgxpool.New(ctx, env(t, "SPOOK_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	st, err := storage.New(ctx, storage.Config{
		Endpoint: env(t, "S3_ENDPOINT"), Region: env(t, "S3_REGION"), Bucket: env(t, "S3_BUCKET"),
		AccessKeyID: env(t, "S3_ACCESS_KEY_ID"), SecretAccessKey: env(t, "S3_SECRET_ACCESS_KEY"),
	})
	if err != nil {
		t.Fatal(err)
	}
	deps := Deps{Cfg: config.Config{Env: "development"}, Pool: pool, Storage: st}
	if tweak != nil {
		tweak(&deps)
	}
	a, err := Build(ctx, deps)
	if err != nil {
		t.Fatal(err)
	}
	// Registrado depois do pool: roda antes dele (cleanups são LIFO) e espera os jobs em andamento.
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer ccancel()
		_ = a.Close(cctx)
	})
	srv := httptest.NewServer(a.Handler)
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	return &testEnv{srv: srv, client: &http.Client{Jar: jar}, pool: pool, app: a}
}

func (e *testEnv) do(t *testing.T, method, path string, body any, hdr map[string]string) (*http.Response, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func uniq(prefix string) (email, username string) {
	n := time.Now().UnixNano()
	return fmt.Sprintf("%s-%d@teste.spook", prefix, n), fmt.Sprintf("%s_%d", prefix, n%1_000_000_000)
}

func status(t *testing.T, resp *http.Response, body []byte, want int) {
	t.Helper()
	if resp.StatusCode != want {
		t.Fatalf("%s %s = %d, esperado %d: %s", resp.Request.Method, resp.Request.URL.Path, resp.StatusCode, want, body)
	}
}

func TestProtectedRoutesReturn401WithoutAuth(t *testing.T) {
	e := newEnv(t)
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/users/me"}, {"PATCH", "/api/users/me"}, {"POST", "/api/users/me/avatar"}, {"POST", "/api/auth/logout"},
	} {
		var body any
		if c.method != "GET" {
			body = map[string]any{}
		}
		resp, b := e.do(t, c.method, c.path, body, nil)
		status(t, resp, b, 401)
	}
	resp, b := e.do(t, "GET", "/api/users/me", nil, map[string]string{"Authorization": "Bearer token-invalido"})
	status(t, resp, b, 401)
}

func TestFullAccountFlow(t *testing.T) {
	e := newEnv(t)
	email, username := uniq("ana")

	// cadastro abre a sessão
	resp, b := e.do(t, "POST", "/api/auth/register", map[string]string{"email": email, "username": username, "password": "senha-forte-123"}, nil)
	status(t, resp, b, 201)
	var c *http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Name == "spook_session" {
			c = ck
		}
	}
	if c == nil || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.MaxAge <= 0 {
		t.Fatalf("cookie de sessão inesperado: %+v", c)
	}
	if bytes.Contains(b, []byte(`"token"`)) {
		t.Fatalf("a web não deve receber o token no corpo: %s", b)
	}
	// `has_password` (booleano) é permitido: o que não pode vazar é a senha, o hash ou o campo de senha.
	for _, banned := range []string{`"password"`, "password_hash", "argon2"} {
		if bytes.Contains(b, []byte(banned)) {
			t.Fatalf("resposta não pode conter dados de senha (%s): %s", banned, b)
		}
	}

	resp, b = e.do(t, "GET", "/api/users/me", nil, nil)
	status(t, resp, b, 200)
	var me struct {
		ID, Email, Username string
	}
	_ = json.Unmarshal(b, &me)
	if me.Email != email || me.Username != username || me.ID == "" {
		t.Fatalf("me inesperado: %s", b)
	}

	// duplicados e validação
	resp, b = e.do(t, "POST", "/api/auth/register", map[string]string{"email": email, "username": "outro_" + username, "password": "senha-forte-123"}, nil)
	status(t, resp, b, 409)
	resp, b = e.do(t, "POST", "/api/auth/register", map[string]string{"email": "x" + email, "username": username, "password": "senha-forte-123"}, nil)
	status(t, resp, b, 409)
	resp, b = e.do(t, "POST", "/api/auth/register", map[string]string{"email": "novo@teste.spook", "username": "Inválido!", "password": "senha-forte-123"}, nil)
	status(t, resp, b, 422)
	resp, b = e.do(t, "POST", "/api/auth/register", map[string]string{"email": "novo@teste.spook", "username": "valido", "password": "curta"}, nil)
	status(t, resp, b, 422)

	// perfil: nome de exibição
	resp, b = e.do(t, "PATCH", "/api/users/me", map[string]any{"display_name": "  Ana Souza "}, nil)
	status(t, resp, b, 200)
	if !strings.Contains(string(b), `"display_name":"Ana Souza"`) {
		t.Fatalf("display_name não foi salvo/aparado: %s", b)
	}
	resp, b = e.do(t, "PATCH", "/api/users/me", map[string]any{"display_name": strings.Repeat("a", 33)}, nil)
	status(t, resp, b, 422)

	// logout encerra a sessão
	resp, b = e.do(t, "POST", "/api/auth/logout", nil, nil)
	status(t, resp, b, 204)
	resp, b = e.do(t, "GET", "/api/users/me", nil, nil)
	status(t, resp, b, 401)
	// o cookie antigo, reenviado manualmente, também não vale mais
	resp, b = e.do(t, "GET", "/api/users/me", nil, map[string]string{"Cookie": "spook_session=" + c.Value})
	status(t, resp, b, 401)

	// login
	resp, b = e.do(t, "POST", "/api/auth/login", map[string]string{"email": email, "password": "errada-123"}, nil)
	status(t, resp, b, 401)
	resp, b = e.do(t, "POST", "/api/auth/login", map[string]string{"email": "nao-existe@teste.spook", "password": "senha-forte-123"}, nil)
	status(t, resp, b, 401)
	resp, b = e.do(t, "POST", "/api/auth/login", map[string]string{"email": strings.ToUpper(email), "password": "senha-forte-123"}, nil)
	status(t, resp, b, 200) // e-mail é case-insensitive (citext)
	resp, b = e.do(t, "GET", "/api/users/me", nil, nil)
	status(t, resp, b, 200)
}

func TestDesktopClientGetsBearerToken(t *testing.T) {
	e := newEnv(t)
	email, username := uniq("desk")
	resp, b := e.do(t, "POST", "/api/auth/register", map[string]string{"email": email, "username": username, "password": "senha-forte-123"}, nil)
	status(t, resp, b, 201)

	resp, b = e.do(t, "POST", "/api/auth/login", map[string]string{"email": email, "password": "senha-forte-123"}, map[string]string{"X-Spook-Client": "desktop"})
	status(t, resp, b, 200)
	var out struct{ Token string }
	_ = json.Unmarshal(b, &out)
	if out.Token == "" {
		t.Fatalf("desktop deveria receber o token: %s", b)
	}

	bare := &testEnv{srv: e.srv, client: &http.Client{}} // sem cookie
	resp, b = bare.do(t, "GET", "/api/users/me", nil, map[string]string{"Authorization": "Bearer " + out.Token})
	status(t, resp, b, 200)
	resp, b = bare.do(t, "POST", "/api/auth/logout", nil, map[string]string{"Authorization": "Bearer " + out.Token})
	status(t, resp, b, 204)
	resp, b = bare.do(t, "GET", "/api/users/me", nil, map[string]string{"Authorization": "Bearer " + out.Token})
	status(t, resp, b, 401)
}

func TestAvatarUploadFlow(t *testing.T) {
	e := newEnv(t)
	email, username := uniq("avatar")
	resp, b := e.do(t, "POST", "/api/auth/register", map[string]string{"email": email, "username": username, "password": "senha-forte-123"}, nil)
	status(t, resp, b, 201)

	png := []byte("\x89PNG\r\n\x1a\nfake-image-bytes")
	resp, b = e.do(t, "POST", "/api/users/me/avatar", map[string]any{"content_type": "image/png", "size": len(png)}, nil)
	status(t, resp, b, 200)
	var up struct {
		UploadURL string `json:"upload_url"`
		Key       string
	}
	_ = json.Unmarshal(b, &up)

	// o cliente (navegador) sobe direto ao storage pela URL pré-assinada
	req, _ := http.NewRequest("PUT", up.UploadURL, bytes.NewReader(png))
	req.Header.Set("Content-Type", "image/png")
	putResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putResp.Body.Close()
	if putResp.StatusCode != 200 {
		t.Fatalf("PUT no storage = %d", putResp.StatusCode)
	}

	resp, b = e.do(t, "PATCH", "/api/users/me", map[string]any{"avatar_key": up.Key}, nil)
	status(t, resp, b, 200)
	var me struct {
		AvatarURL string `json:"avatar_url"`
	}
	_ = json.Unmarshal(b, &me)
	if me.AvatarURL == "" {
		t.Fatalf("avatar_url ausente: %s", b)
	}
	got, err := http.Get(me.AvatarURL)
	if err != nil {
		t.Fatal(err)
	}
	defer got.Body.Close()
	data, _ := io.ReadAll(got.Body)
	if got.StatusCode != 200 || !bytes.Equal(data, png) {
		t.Fatalf("download do avatar falhou: %d", got.StatusCode)
	}

	// recusas
	resp, b = e.do(t, "POST", "/api/users/me/avatar", map[string]any{"content_type": "text/html", "size": 10}, nil)
	status(t, resp, b, 422)
	resp, b = e.do(t, "POST", "/api/users/me/avatar", map[string]any{"content_type": "image/png", "size": 6 << 20}, nil)
	status(t, resp, b, 422)
	resp, b = e.do(t, "PATCH", "/api/users/me", map[string]any{"avatar_key": "avatars/1/qualquer.png"}, nil)
	status(t, resp, b, 422)

	resp, b = e.do(t, "PATCH", "/api/users/me", map[string]any{"remove_avatar": true}, nil)
	status(t, resp, b, 200)
	if strings.Contains(string(b), "avatar_url") {
		t.Fatalf("avatar deveria ter sido removido: %s", b)
	}
}

func TestAuthRateLimit(t *testing.T) {
	e := newEnv(t)
	got429 := false
	for range 15 {
		resp, _ := e.do(t, "POST", "/api/auth/login", map[string]string{"email": "nao@existe.spook", "password": "x"}, nil)
		if resp.StatusCode == http.StatusTooManyRequests {
			got429 = true
			break
		}
	}
	if !got429 {
		t.Fatal("esperava 429 após rajada de logins")
	}
}

func TestHealthzAndOpenAPIServed(t *testing.T) {
	e := newEnv(t)
	for _, p := range []string{"/healthz", "/api/healthz", "/api/openapi.yaml"} {
		resp, b := e.do(t, "GET", p, nil, nil)
		status(t, resp, b, 200)
	}
}

// timingMetrics lê "nome;dur=ms, nome;dur=ms" em um mapa.
func timingMetrics(h string) map[string]float64 {
	out := map[string]float64{}
	for _, part := range strings.Split(h, ",") {
		var v float64
		name, dur, ok := strings.Cut(strings.TrimSpace(part), ";dur=")
		if ok {
			_, _ = fmt.Sscanf(dur, "%f", &v)
			out[name] = v
		}
	}
	return out
}

func TestServerTimingHeader(t *testing.T) {
	e := newEnv(t)
	email, username := uniq("timing")

	resp, b := e.do(t, "POST", "/api/auth/register", map[string]string{"email": email, "username": username, "password": "senha-forte-123"}, nil)
	status(t, resp, b, 201)
	// cadastro e login fazem hash/verificação Argon2id: a métrica `argon2` precisa aparecer e ser < `app`
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/auth/login", map[string]string{"email": email, "password": "senha-forte-123"}},
		{"POST", "/api/auth/register", map[string]string{"email": "t2-" + email, "username": "t2" + username[:10], "password": "senha-forte-123"}},
	} {
		resp, b = e.do(t, c.method, c.path, c.body, nil)
		h := resp.Header.Get("Server-Timing")
		m := timingMetrics(h) // a ordem das métricas extras depende do fluxo (db antes ou depois do argon2)
		app, db, argon := m["app"], m["db"], m["argon2"]
		if app <= 0 || db <= 0 || argon <= 0 {
			t.Fatalf("%s %s: Server-Timing = %q (esperava app, db e argon2) body=%s", c.method, c.path, h, b)
		}
		if argon <= 0 || argon > app {
			t.Fatalf("%s %s: argon2 (%.2f) deveria estar entre 0 e app (%.2f)", c.method, c.path, argon, app)
		}
	}

	resp, b = e.do(t, "GET", "/healthz", nil, nil)
	status(t, resp, b, 200)
	if h := resp.Header.Get("Server-Timing"); !strings.HasPrefix(h, "app;dur=") || strings.Contains(h, "argon2") {
		t.Fatalf("healthz Server-Timing = %q", h)
	}
	bare := &testEnv{srv: e.srv, client: &http.Client{}} // sem cookie: 401 também carrega o header
	resp, b = bare.do(t, "GET", "/api/users/me", nil, nil)
	status(t, resp, b, 401)
	if resp.Header.Get("Server-Timing") == "" {
		t.Fatal("respostas de erro também devem ter Server-Timing")
	}
}

func TestCORSForDesktopOrigin(t *testing.T) {
	const tauri = "tauri://localhost"
	e := newEnvWith(t, func(d *Deps) {
		d.Cfg.AllowedOrigins = []string{tauri}
		d.AuthLimiter = ratelimit.New(0.001, 3) // estoura logo para provar o CORS na resposta 429
	})

	// Preflight: 204 com os cabeçalhos, sem credenciais, e sem consumir o limite de /api/auth/*.
	for range 10 {
		resp, b := e.do(t, "OPTIONS", "/api/auth/login", nil, map[string]string{
			"Origin": tauri, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-spook-client",
		})
		status(t, resp, b, 204)
		if resp.Header.Get("Access-Control-Allow-Origin") != tauri || resp.Header.Get("Access-Control-Allow-Credentials") != "" ||
			!strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "X-Spook-Client") {
			t.Fatalf("preflight headers = %v", resp.Header)
		}
	}

	// 401 de rota protegida leva CORS e Server-Timing exposto.
	resp, b := e.do(t, "GET", "/api/users/me", nil, map[string]string{"Origin": tauri})
	status(t, resp, b, 401)
	if resp.Header.Get("Access-Control-Allow-Origin") != tauri || !strings.Contains(resp.Header.Get("Access-Control-Expose-Headers"), "Retry-After") {
		t.Fatalf("401 sem CORS: %v", resp.Header)
	}

	// 429 também leva CORS (o navegador precisa ler Retry-After).
	var last *http.Response
	for range 10 {
		last, _ = e.do(t, "POST", "/api/auth/login", map[string]string{"email": "nao@existe.spook", "password": "x"}, map[string]string{"Origin": tauri})
		if last.StatusCode == http.StatusTooManyRequests {
			break
		}
	}
	if last.StatusCode != http.StatusTooManyRequests || last.Header.Get("Access-Control-Allow-Origin") != tauri || last.Header.Get("Retry-After") == "" {
		t.Fatalf("429 = %d headers = %v", last.StatusCode, last.Header)
	}

	// Origem não permitida: nenhum cabeçalho CORS.
	resp, b = e.do(t, "GET", "/api/users/me", nil, map[string]string{"Origin": "https://evil.example"})
	status(t, resp, b, 401)
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("origem não permitida recebeu CORS: %v", resp.Header)
	}
}
