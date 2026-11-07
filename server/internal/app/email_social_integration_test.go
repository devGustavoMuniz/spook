//go:build integration

package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/auth"
	"github.com/devGustavoMuniz/spook/server/internal/mailflow"
	"github.com/devGustavoMuniz/spook/server/internal/platform/config"
	"github.com/devGustavoMuniz/spook/server/internal/platform/mailer"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/social"
)

// ---------- infraestrutura dos testes de e-mail e login social ----------

type mailEnv struct {
	*testEnv
	mail *mailer.Memory
}

// newMailEnv liga os fluxos por e-mail com o dublê de envio (nada sai pela rede).
func newMailEnv(t *testing.T, tweak func(*Deps)) *mailEnv {
	t.Helper()
	mem := &mailer.Memory{}
	e := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.AuthLimiter = ratelimit.New(100000, 100000)
		d.PasswordLimiter = ratelimit.New(100000, 100000)
		d.EmailLimiter = ratelimit.New(100000, 100000)
		d.DeleteLimiter = ratelimit.New(100000, 100000)
		d.ForgotLimiter = ratelimit.New(100000, 100000)
		d.ResendLimiter = ratelimit.New(100000, 100000)
		d.RecipientLimiter = ratelimit.New(100000, 100000)
		d.ForgotDelay = -1
		d.Mailer = mem
		d.Cfg.PublicURL = "http://app.test"
		d.Cfg.Mail = config.Mail{Driver: "smtp"}
		if tweak != nil {
			tweak(d)
		}
	})
	return &mailEnv{testEnv: e, mail: mem}
}

var tokenRe = regexp.MustCompile(`token=([A-Za-z0-9_-]+)`)

// waitMail espera (o envio passa por job do River) o n-ésimo e-mail para `to` e devolve a mensagem.
func (m *mailEnv) waitMail(t *testing.T, to string, n int) mailer.Message {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if msgs := m.mail.To(to); len(msgs) >= n {
			return msgs[n-1]
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("e-mail %d para %s não chegou (recebidos: %d)", n, to, len(m.mail.To(to)))
	return mailer.Message{}
}

// waitMailWith espera um e-mail para `to` cujo texto contenha `sub` (os jobs rodam em paralelo: a ordem de
// chegada não é a ordem de criação).
func (m *mailEnv) waitMailWith(t *testing.T, to, sub string) mailer.Message {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		for _, msg := range m.mail.To(to) {
			if strings.Contains(msg.Text, sub) {
				return msg
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("nenhum e-mail para %s contendo %q", to, sub)
	return mailer.Message{}
}

func (m *mailEnv) noMail(t *testing.T, to string, wait time.Duration) {
	t.Helper()
	time.Sleep(wait)
	if n := len(m.mail.To(to)); n != 0 {
		t.Fatalf("não deveria haver e-mail para %s, mas há %d", to, n)
	}
}

func tokenOf(t *testing.T, msg mailer.Message) string {
	t.Helper()
	mm := tokenRe.FindStringSubmatch(msg.Text)
	if mm == nil {
		t.Fatalf("e-mail sem link com token: %s", msg.Text)
	}
	return mm[1]
}

func (e *testEnv) emailOf(t *testing.T, a *actor) string {
	t.Helper()
	return str(obj(t, a.call(t, "GET", "/api/users/me", nil, 200)), "email")
}

func (e *testEnv) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func problemCode(t *testing.T, body []byte) string { return str(obj(t, body), "code") }

// ---------- verificação de e-mail ----------

func TestEmailVerificationFlow(t *testing.T) {
	e := newMailEnv(t, nil)
	a := e.newActor(t, "verif")
	email := e.emailOf(t, a)

	if obj(t, a.call(t, "GET", "/api/users/me", nil, 200))["email_verified"] != false {
		t.Fatal("conta nova começa não verificada")
	}
	msg := e.waitMail(t, email, 1)
	if !strings.Contains(msg.Text, "http://app.test/verify-email?token=") || !strings.Contains(msg.HTML, "Confirmar e-mail") {
		t.Fatalf("e-mail de verificação sem link/botão: %s", msg.Text)
	}
	tok := tokenOf(t, msg)

	// o banco guarda só o hash; a fila de jobs não guarda o token em claro
	var plain int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM email_tokens WHERE token_hash = convert_to($1,'UTF8')`, tok).Scan(&plain)
	if plain != 0 {
		t.Fatal("o token não pode estar gravado em claro")
	}
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM river_job WHERE args::text LIKE '%' || $1 || '%'`, tok).Scan(&plain)
	if plain != 0 {
		t.Fatal("o token não pode aparecer nos args do job")
	}

	anon := e.newActorRaw()
	body := anon.call(t, "POST", "/api/auth/email/verify", J{"token": strings.Repeat("a", 43)}, 410)
	if problemCode(t, body) != "token_invalid" {
		t.Fatalf("token desconhecido: %s", body)
	}
	out := obj(t, anon.call(t, "POST", "/api/auth/email/verify", J{"token": tok}, 200)) // sem sessão: o link pode abrir em outro navegador
	if str(out, "status") != "verified" || str(out, "email") != email {
		t.Fatalf("verify: %v", out)
	}
	if obj(t, a.call(t, "GET", "/api/users/me", nil, 200))["email_verified"] != true {
		t.Fatal("deveria estar verificada")
	}
	// uso único
	if c := problemCode(t, anon.call(t, "POST", "/api/auth/email/verify", J{"token": tok}, 410)); c != "token_expired" {
		t.Fatalf("segundo uso: %s", c)
	}
	// já verificado
	if c := problemCode(t, a.call(t, "POST", "/api/auth/email/resend", nil, 409)); c != "already_verified" {
		t.Fatalf("reenvio: %s", c)
	}
}

func TestEmailVerificationResendExpiryAndSupersede(t *testing.T) {
	e := newMailEnv(t, func(d *Deps) { d.ResendLimiter = ratelimit.New(0.001, 2) })
	a := e.newActor(t, "reenvio")
	email := e.emailOf(t, a)
	first := tokenOf(t, e.waitMail(t, email, 1))

	a.call(t, "POST", "/api/auth/email/resend", nil, 204)
	second := tokenOf(t, e.waitMail(t, email, 2))
	if first == second {
		t.Fatal("cada pedido gera um token novo")
	}
	anon := e.newActorRaw()
	anon.call(t, "POST", "/api/auth/email/verify", J{"token": first}, 410) // o pedido novo substitui o antigo

	// limite de reenvio por usuário: 2 de rajada (1 gasto acima), depois 429 com Retry-After
	a.call(t, "POST", "/api/auth/email/resend", nil, 204)
	third := tokenOf(t, e.waitMail(t, email, 3))
	resp, body := a.do(t, "POST", "/api/auth/email/resend", nil) //nolint:bodyclose // do já fecha o corpo
	status(t, resp, body, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}

	// expirado
	e.exec(t, `UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE kind='verify' AND used_at IS NULL AND email = $1`, email)
	if c := problemCode(t, anon.call(t, "POST", "/api/auth/email/verify", J{"token": third}, 410)); c != "token_expired" {
		t.Fatalf("expirado: %s", c)
	}
	// formato inválido do token é rejeitado já no contrato
	anon.call(t, "POST", "/api/auth/email/verify", J{"token": "curto"}, 422)
}

func TestEmailSendRetriesWithBackoff(t *testing.T) {
	e := newMailEnv(t, nil)
	e.mail.FailNext = 1 // o 1º envio (verificação do cadastro) falha; o River tenta de novo
	a := e.newActor(t, "retry")
	email := e.emailOf(t, a)
	_ = e.waitMail(t, email, 1)
}

// ---------- troca de e-mail com verificação ----------

func TestEmailChangeNeedsConfirmationAtNewAddress(t *testing.T) {
	e := newMailEnv(t, nil)
	a := e.newActor(t, "troca")
	b := e.newActor(t, "outro")
	old := e.emailOf(t, a)
	taken := e.emailOf(t, b)
	fresh, _ := uniq("novo")
	a.confirm(t, pw, 200)

	a.call(t, "PUT", "/api/users/me/email", J{"email": taken}, 409)
	me := obj(t, a.call(t, "PUT", "/api/users/me/email", J{"email": fresh}, 202))
	if str(me, "email") != old || str(me, "pending_email") != fresh {
		t.Fatalf("a conta não pode mudar antes da confirmação: %v", me)
	}
	// o link vai ao endereço NOVO; o antigo recebe um aviso (sem link)
	msg := e.waitMail(t, fresh, 1)
	tok := tokenOf(t, msg)
	notice := e.waitMailWith(t, old, "Alguém pediu para trocar o e-mail da sua conta para "+fresh)
	if tokenRe.MatchString(notice.Text) || !strings.Contains(notice.Text, fresh) {
		t.Fatalf("aviso ao endereço antigo: %s", notice.Text)
	}
	if e.emailOf(t, a) != old {
		t.Fatal("e-mail mudou antes de confirmar")
	}

	// um segundo pedido substitui o primeiro
	other, _ := uniq("novo2")
	a.call(t, "PUT", "/api/users/me/email", J{"email": other}, 202)
	e.newActorRaw().call(t, "POST", "/api/auth/email/verify", J{"token": tok}, 410)
	tok2 := tokenOf(t, e.waitMail(t, other, 1))

	out := obj(t, e.newActorRaw().call(t, "POST", "/api/auth/email/verify", J{"token": tok2}, 200))
	if str(out, "status") != "changed" || str(out, "email") != other {
		t.Fatalf("troca: %v", out)
	}
	me = obj(t, a.call(t, "GET", "/api/users/me", nil, 200))
	if str(me, "email") != other || me["email_verified"] != true || str(me, "pending_email") != "" {
		t.Fatalf("depois da confirmação: %v", me)
	}
	_ = e.waitMailWith(t, old, "agora é "+other) // aviso de troca concluída ao endereço antigo
	e.newActorRaw().call(t, "POST", "/api/auth/login", J{"email": other, "password": pw}, 200)
	e.newActorRaw().call(t, "POST", "/api/auth/login", J{"email": old, "password": pw}, 401)
}

func TestEmailChangeIsDirectWhenMailIsDegraded(t *testing.T) {
	e := accountEnv(t) // sem Cfg.Mail: modo degradado
	a := e.newActor(t, "direta")
	a.confirm(t, pw, 200)
	fresh, _ := uniq("direto")
	me := obj(t, a.call(t, "PUT", "/api/users/me/email", J{"email": fresh}, 200))
	if str(me, "email") != fresh || me["email_verified"] != false {
		t.Fatalf("troca direta: %v", me)
	}
}

// ---------- modo degradado ----------

func TestDegradedModeKeepsEverythingWorking(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "degradado") // cadastro NÃO exige verificação
	a.call(t, "POST", "/api/guilds", J{"name": "Sem verificação"}, 201)
	if c := problemCode(t, a.call(t, "POST", "/api/auth/email/resend", nil, 503)); c != "email_disabled" {
		t.Fatalf("resend: %s", c)
	}
	anon := e.newActorRaw()
	anon.call(t, "POST", "/api/auth/password/forgot", J{"email": e.emailOf(t, a)}, 202) // resposta igual, nada enviado
	p := obj(t, anon.call(t, "GET", "/api/auth/providers", nil, 200))
	if p["email_enabled"] != false || len(anyList(p, "providers")) != 0 {
		t.Fatalf("providers: %v", p)
	}
}

func anyList(m J, k string) []any { v, _ := m[k].([]any); return v }

func TestRequireEmailVerificationGatesCreateAndInvite(t *testing.T) {
	e := newMailEnv(t, func(d *Deps) { d.Cfg.Mail.RequireVerification = true })
	a := e.newActor(t, "exige")
	email := e.emailOf(t, a)
	resp, body := a.do(t, "POST", "/api/guilds", J{"name": "Bloqueado"})
	status(t, resp, body, 403)
	if problemCode(t, body) != "email_verification_required" {
		t.Fatalf("code: %s", body)
	}
	// contas verificadas criam; convidar também é barrado para quem não verificou
	ok := e.newActor(t, "verificada")
	e.exec(t, `UPDATE users SET email_verified_at = now() WHERE id = $1`, ok.id)
	g := ok.createGuild(t, "Liberado")
	a.join(t, ok, g.id)
	resp, body = a.do(t, "POST", "/api/guilds/"+g.id+"/invites", J{})
	status(t, resp, body, 403)
	// verifica e libera
	e.newActorRaw().call(t, "POST", "/api/auth/email/verify", J{"token": tokenOf(t, e.waitMail(t, email, 1))}, 200)
	a.call(t, "POST", "/api/guilds", J{"name": "Agora pode"}, 201)

	// mesmo com a exigência ligada, o modo degradado (sem e-mail) não bloqueia ninguém
	d := newEnvWith(t, func(dd *Deps) { bigLimits(dd); dd.Cfg.Mail.RequireVerification = true })
	d.newActor(t, "livre").call(t, "POST", "/api/guilds", J{"name": "Livre"}, 201)
}

// ---------- recuperação de senha ----------

func TestForgotAndResetPassword(t *testing.T) {
	e := newMailEnv(t, nil)
	a := e.newActor(t, "esqueci")
	email := e.emailOf(t, a)
	second := e.loginAs(t, a, email, pw) // outra sessão: também deve cair
	ws := second.connect(t)
	ws.identify()

	anon := e.newActorRaw()
	r1, b1 := anon.do(t, "POST", "/api/auth/password/forgot", J{"email": email})
	status(t, r1, b1, 202)
	ghost, _ := uniq("fantasma")
	r2, b2 := anon.do(t, "POST", "/api/auth/password/forgot", J{"email": ghost})
	status(t, r2, b2, 202)
	if !bytes.Equal(b1, b2) || r1.Header.Get("Content-Type") != r2.Header.Get("Content-Type") {
		t.Fatalf("resposta deve ser idêntica exista ou não a conta: %q vs %q", b1, b2)
	}
	msg := e.waitMailWith(t, email, "/reset-password?token=")
	e.noMail(t, ghost, 300*time.Millisecond)
	tok := tokenOf(t, msg)

	// senha fraca não gasta o token
	anon.call(t, "POST", "/api/auth/password/reset", J{"token": tok, "new_password": "curta"}, 422)
	anon.call(t, "POST", "/api/auth/password/reset", J{"token": tok, "new_password": "nova-senha-789"}, 204)
	// todas as sessões caíram, inclusive o gateway
	a.call(t, "GET", "/api/users/me", nil, 401)
	second.call(t, "GET", "/api/users/me", nil, 401)
	ws.expectClose(4010, 5*time.Second)
	anon.call(t, "POST", "/api/auth/login", J{"email": email, "password": pw}, 401)
	anon.call(t, "POST", "/api/auth/login", J{"email": email, "password": "nova-senha-789"}, 200)
	// uso único + redefinir também verifica o e-mail
	if c := problemCode(t, anon.call(t, "POST", "/api/auth/password/reset", J{"token": tok, "new_password": "outra-senha-000"}, 410)); c != "token_expired" {
		t.Fatalf("reuso: %s", c)
	}
	if obj(t, anon.call(t, "GET", "/api/users/me", nil, 200))["email_verified"] != true {
		t.Fatal("redefinir pelo link do e-mail prova a posse do endereço")
	}
	// um token de verificação não serve para redefinir senha
	other := fmt.Sprintf("verify-token-%020d", time.Now().UnixNano())
	e.exec(t, `INSERT INTO email_tokens (id, user_id, kind, email, token_hash, expires_at) SELECT (extract(epoch from clock_timestamp())*1000000)::bigint, id, 'verify', email, sha256(convert_to($2,'UTF8')), now()+interval '1 hour' FROM users WHERE email=$1`, email, other)
	anon.call(t, "POST", "/api/auth/password/reset", J{"token": other, "new_password": "outra-senha-000"}, 410)
}

func TestResetPasswordTokenExpiresAfter30Minutes(t *testing.T) {
	e := newMailEnv(t, nil)
	a := e.newActor(t, "expira")
	email := e.emailOf(t, a)
	anon := e.newActorRaw()
	anon.call(t, "POST", "/api/auth/password/forgot", J{"email": email}, 202)
	tok := tokenOf(t, e.waitMailWith(t, email, "/reset-password?token="))
	var ttl float64
	_ = e.pool.QueryRow(context.Background(), `SELECT extract(epoch FROM (expires_at - created_at)) FROM email_tokens WHERE kind='password_reset' AND email=$1 ORDER BY created_at DESC LIMIT 1`, email).Scan(&ttl)
	if ttl < 29*60 || ttl > 31*60 {
		t.Fatalf("TTL do reset = %.0fs, esperado ~1800s", ttl)
	}
	e.exec(t, `UPDATE email_tokens SET expires_at = now() - interval '1 second' WHERE kind='password_reset' AND email=$1`, email)
	if c := problemCode(t, anon.call(t, "POST", "/api/auth/password/reset", J{"token": tok, "new_password": "nova-senha-789"}, 410)); c != "token_expired" {
		t.Fatalf("expirado: %s", c)
	}
}

func TestForgotRateLimits(t *testing.T) {
	e := newMailEnv(t, func(d *Deps) {
		d.ForgotLimiter = ratelimit.New(0.001, 4)
		d.RecipientLimiter = ratelimit.New(0.001, 2) // a verificação do cadastro já gasta 1
	})
	a := e.newActor(t, "limite_mail")
	email := e.emailOf(t, a)
	anon := e.newActorRaw()
	anon.call(t, "POST", "/api/auth/password/forgot", J{"email": email}, 202) // gasta o 2º do destinatário
	_ = e.waitMail(t, email, 2)
	anon.call(t, "POST", "/api/auth/password/forgot", J{"email": email}, 202) // por e-mail: silencioso, nada enviado
	e.noMail(t, "inexistente@x.test", 0)
	time.Sleep(400 * time.Millisecond)
	if n := len(e.mail.To(email)); n != 2 {
		t.Fatalf("acima do limite por destinatário nada deve ser enviado (n=%d)", n)
	}
	anon.call(t, "POST", "/api/auth/password/forgot", J{"email": "outro-" + email}, 202)
	anon.call(t, "POST", "/api/auth/password/forgot", J{"email": "outro2-" + email}, 202)
	resp, body := anon.do(t, "POST", "/api/auth/password/forgot", J{"email": "outro3-" + email}) // por IP: 429
	status(t, resp, body, 429)
}

func TestForgotHasMinimumDuration(t *testing.T) {
	e := newMailEnv(t, func(d *Deps) { d.ForgotDelay = 400 * time.Millisecond })
	anon := e.newActorRaw()
	for _, addr := range []string{"nao-existe@x.test", "outro-nao-existe@x.test"} {
		start := time.Now()
		anon.call(t, "POST", "/api/auth/password/forgot", J{"email": addr}, 202)
		if d := time.Since(start); d < 380*time.Millisecond {
			t.Fatalf("resposta rápida demais (%v): o tempo não pode revelar se a conta existe", d)
		}
	}
}

func TestAdminResetPasswordCLI(t *testing.T) {
	e := accountEnv(t) // funciona sem SMTP
	a := e.newActor(t, "clireset")
	email := e.emailOf(t, a)
	var out bytes.Buffer
	if err := mailflow.RunResetPassword(context.Background(), e.pool, "http://app.test/", 7, []string{a.name}, &out); err != nil {
		t.Fatal(err)
	}
	m := tokenRe.FindStringSubmatch(out.String())
	if m == nil || !strings.Contains(out.String(), "http://app.test/reset-password?token=") {
		t.Fatalf("saída sem link: %s", out.String())
	}
	if err := mailflow.RunResetPassword(context.Background(), e.pool, "http://app.test", 7, []string{"naoexiste_zzz"}, &out); err == nil {
		t.Fatal("usuário inexistente deve falhar")
	}
	if err := mailflow.RunResetPassword(context.Background(), e.pool, "", 7, []string{a.name}, &out); err == nil {
		t.Fatal("sem PUBLIC_URL deve falhar")
	}
	anon := e.newActorRaw()
	anon.call(t, "POST", "/api/auth/password/reset", J{"token": m[1], "new_password": "via-admin-123"}, 204)
	anon.call(t, "POST", "/api/auth/login", J{"email": email, "password": "via-admin-123"}, 200)
	anon.call(t, "POST", "/api/auth/password/reset", J{"token": m[1], "new_password": "via-admin-456"}, 410)
}

func TestSecurityHeadersAndNoStoreOnAuth(t *testing.T) {
	e := accountEnv(t)
	resp, _ := e.do(t, "GET", "/api/auth/providers", nil, nil)
	h := resp.Header
	if h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Referrer-Policy") != "no-referrer" || h.Get("X-Frame-Options") != "DENY" || h.Get("Cache-Control") != "no-store" {
		t.Fatalf("cabeçalhos: %v", h)
	}
}

// ---------- caixa de saída de desenvolvimento (driver log) ----------

func TestDevMailOutboxOnlyInDevelopment(t *testing.T) {
	dev := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.AuthLimiter = ratelimit.New(100000, 100000)
		d.Cfg.PublicURL = "http://app.test"
		d.Cfg.Mail = config.Mail{Driver: "log", LogActive: true}
	})
	a := dev.newActor(t, "devbox")
	email := dev.emailOf(t, a)
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, body := dev.do(t, "GET", "/api/dev/mail/last?to="+url.QueryEscape(email), nil, nil)
		if resp.StatusCode == 200 {
			if !strings.Contains(string(body), "verify-email?token=") {
				t.Fatalf("corpo: %s", body)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("e-mail não chegou à caixa de saída: %d %s", resp.StatusCode, body)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// produção: a rota NÃO existe, mesmo com o driver log
	prod := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.Cfg.Env = "production"
		d.Cfg.PublicURL = "http://app.test"
		d.Cfg.Mail = config.Mail{Driver: "log", LogActive: true}
	})
	resp, _ := prod.do(t, "GET", "/api/dev/mail/last?to=a@b.c", nil, nil)
	if resp.StatusCode != 404 {
		t.Fatalf("a caixa de saída de dev não pode existir em produção: %d", resp.StatusCode)
	}
}

// ---------- login social ----------

type fakeProvider struct {
	name string
	mu   sync.Mutex
	// codes mapeia o `code` do callback para o perfil devolvido.
	codes     map[string]social.Profile
	fail      bool
	challenge string
	reauth    bool
}

func newFake(name string) *fakeProvider {
	return &fakeProvider{name: name, codes: map[string]social.Profile{}}
}

func (f *fakeProvider) Name() string { return f.name }
func (f *fakeProvider) AuthURL(p social.AuthParams) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.challenge, f.reauth = p.Challenge, p.Reauth
	return "https://fake-" + f.name + ".test/authorize?state=" + url.QueryEscape(p.State) +
		"&code_challenge=" + p.Challenge + "&redirect_uri=" + url.QueryEscape(p.RedirectURI)
}
func (f *fakeProvider) Exchange(_ context.Context, code, verifier, _ string) (social.Profile, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sum := sha256.Sum256([]byte(verifier))
	if base64.RawURLEncoding.EncodeToString(sum[:]) != f.challenge {
		return social.Profile{}, errors.New("PKCE: verificador não bate com o desafio")
	}
	p, ok := f.codes[code]
	if f.fail || !ok {
		return social.Profile{}, social.ErrProvider
	}
	return p, nil
}

func socialEnv(t *testing.T, g, d *fakeProvider) *mailEnv {
	return newMailEnv(t, func(dd *Deps) {
		dd.SocialProviders = map[string]social.Provider{social.Google: g, social.Discord: d}
	})
}

func (e *testEnv) noFollow(a *actor) *http.Client {
	return &http.Client{Jar: a.client.Jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// hop faz um GET sem seguir redirecionamentos e devolve a resposta (corpo já fechado).
func (e *testEnv) hop(t *testing.T, a *actor, path string) *http.Response {
	t.Helper()
	resp, err := e.noFollow(a).Get(e.srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp
}

// socialFlow percorre início e retorno; devolve o Location final ("" se o início já recusou).
func (e *testEnv) socialFlow(t *testing.T, a *actor, provider, startQuery, code string) string {
	t.Helper()
	resp := e.hop(t, a, "/api/auth/social/"+provider+"/start"+startQuery)
	if resp.StatusCode != 303 {
		t.Fatalf("start = %d", resp.StatusCode)
	}
	loc := resp.Header.Get("Location")
	if !strings.HasPrefix(loc, "https://fake-") {
		return loc // o início recusou (ex.: precisa confirmar a senha)
	}
	u, _ := url.Parse(loc)
	cb := "/api/auth/social/" + provider + "/callback?code=" + url.QueryEscape(code) + "&state=" + url.QueryEscape(u.Query().Get("state"))
	resp = e.hop(t, a, cb)
	if resp.StatusCode != 303 {
		t.Fatalf("callback = %d", resp.StatusCode)
	}
	return resp.Header.Get("Location")
}

func (e *testEnv) rawActor() *actor {
	jar, _ := cookiejar.New(nil)
	return &actor{e: e, client: &http.Client{Jar: jar}}
}

func TestSocialStartRedirectsWithPKCEAndSignedStateCookie(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	anon := e.rawActor()
	resp := e.hop(t, anon, "/api/auth/social/google/start?redirect=/invite/abc")
	loc, _ := url.Parse(resp.Header.Get("Location"))
	if resp.StatusCode != 303 || loc.Host != "fake-google.test" || loc.Query().Get("state") == "" || loc.Query().Get("code_challenge") == "" {
		t.Fatalf("redirecionamento: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if loc.Query().Get("redirect_uri") != "http://app.test/api/auth/social/google/callback" {
		t.Fatalf("redirect_uri: %s", loc.Query().Get("redirect_uri"))
	}
	var c *http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Name == social.FlowCookie {
			c = ck
		}
	}
	if c == nil || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.MaxAge <= 0 || c.MaxAge > 600 || c.Path != "/api/auth/social" {
		t.Fatalf("cookie do fluxo: %+v", c)
	}
	if strings.Contains(c.Value, loc.Query().Get("code_challenge")) {
		t.Fatal("o desafio não precisa estar no cookie; só o verificador assinado")
	}
	// provedor desligado
	only := newMailEnv(t, func(dd *Deps) { dd.SocialProviders = map[string]social.Provider{social.Google: g} })
	if l := only.hop(t, only.rawActor(), "/api/auth/social/discord/start").Header.Get("Location"); l != "/login?social_error=provider_off" {
		t.Fatalf("provedor desligado: %s", l)
	}
	p := obj(t, anon.call(t, "GET", "/api/auth/providers", nil, 200))
	if got := anyList(p, "providers"); len(got) != 2 || got[0] != "google" || got[1] != "discord" || p["email_enabled"] != true {
		t.Fatalf("providers: %v", p)
	}
	p = obj(t, only.rawActor().call(t, "GET", "/api/auth/providers", nil, 200))
	if got := anyList(p, "providers"); len(got) != 1 || got[0] != "google" {
		t.Fatalf("providers (só google): %v", p)
	}
}

func TestSocialNewAccountChoosesUsernameThenLogsInAgain(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	mail, uname := uniq("gnew")
	g.codes["c1"] = social.Profile{ID: "g-" + uname, Email: mail, EmailVerified: true, Name: "Maria Silva"}

	a := e.rawActor()
	loc := e.socialFlow(t, a, "google", "?redirect=/invite/abc", "c1")
	if loc != "/auth/choose-username?redirect=%2Finvite%2Fabc" {
		t.Fatalf("destino: %s", loc)
	}
	// ainda sem sessão
	a.call(t, "GET", "/api/users/me", nil, 401)
	pend := obj(t, a.call(t, "GET", "/api/auth/social/pending", nil, 200))
	if str(pend, "email") != mail || str(pend, "provider") != "google" || str(pend, "suggested_username") != "maria_silva" {
		t.Fatalf("pending: %v", pend)
	}
	// outro navegador não vê o pendente
	e.rawActor().call(t, "GET", "/api/auth/social/pending", nil, 410)

	a.call(t, "POST", "/api/auth/social/complete", J{"username": "admin"}, 422) // reservado
	a.call(t, "POST", "/api/auth/social/complete", J{"username": "x"}, 422)     // fora do padrão (contrato)
	taken := e.newActor(t, "ocupado")
	a.call(t, "POST", "/api/auth/social/complete", J{"username": taken.name}, 409)
	resp, body := a.do(t, "POST", "/api/auth/social/complete", J{"username": uname})
	status(t, resp, body, 201)
	var sess *http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Name == "spook_session" {
			sess = ck
		}
	}
	if sess == nil || !sess.HttpOnly {
		t.Fatalf("sem cookie de sessão: %v", resp.Cookies())
	}
	me := obj(t, a.call(t, "GET", "/api/users/me", nil, 200))
	if str(me, "username") != uname || str(me, "email") != mail || me["email_verified"] != true || me["has_password"] != false || str(me, "display_name") != "Maria Silva" {
		t.Fatalf("me: %v", me)
	}
	// cadastro pendente é de uso único
	a.call(t, "GET", "/api/auth/social/pending", nil, 410)

	// sem senha: login por e-mail/senha não entra
	e.rawActor().call(t, "POST", "/api/auth/login", J{"email": mail, "password": "qualquer-coisa"}, 401)

	// novo login pelo provedor: direto, com o redirect seguro
	b := e.rawActor()
	if l := e.socialFlow(t, b, "google", "?redirect=/invite/abc", "c1"); l != "/invite/abc" {
		t.Fatalf("login existente: %s", l)
	}
	b.call(t, "GET", "/api/users/me", nil, 200)
	// redirect malicioso é ignorado
	c := e.rawActor()
	if l := e.socialFlow(t, c, "google", "?redirect=//evil.example", "c1"); l != "/" {
		t.Fatalf("redirect aberto: %s", l)
	}
	if l := e.socialFlow(t, e.rawActor(), "google", "?redirect=https://evil.example", "c1"); l != "/" {
		t.Fatalf("redirect absoluto: %s", l)
	}
	methods := obj(t, b.call(t, "GET", "/api/users/me/login-methods", nil, 200))
	accs := list(methods, "accounts")
	if methods["has_password"] != false || len(accs) != 1 || str(accs[0], "provider") != "google" {
		t.Fatalf("login-methods: %v", methods)
	}
	// o token do provedor nunca é gravado: não há coluna para ele, e o e-mail é o único dado guardado
	var cols int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.columns WHERE table_name='social_accounts' AND column_name ILIKE '%token%'`).Scan(&cols)
	if cols != 0 {
		t.Fatal("social_accounts não pode ter colunas de token")
	}
}

func TestSocialStateAndProviderErrors(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	mail, uname := uniq("gerr")
	g.codes["ok"] = social.Profile{ID: "g-" + uname, Email: mail, EmailVerified: true, Name: "Err"}

	// sem cookie do fluxo
	a := e.rawActor()
	if l := e.hop(t, a, "/api/auth/social/google/callback?code=ok&state=qualquer").Header.Get("Location"); l != "/login?social_error=state" {
		t.Fatalf("sem cookie: %s", l)
	}
	// estado trocado
	resp := e.hop(t, a, "/api/auth/social/google/start")
	if l := e.hop(t, a, "/api/auth/social/google/callback?code=ok&state=adulterado").Header.Get("Location"); l != "/login?social_error=state" {
		t.Fatalf("estado errado: %s (%d)", l, resp.StatusCode)
	}
	// cookie de outro provedor não vale para este
	b := e.rawActor()
	e.hop(t, b, "/api/auth/social/discord/start")
	if l := e.hop(t, b, "/api/auth/social/google/callback?code=ok&state=x").Header.Get("Location"); l != "/login?social_error=state" {
		t.Fatalf("outro provedor: %s", l)
	}
	// cookie adulterado
	c := e.rawActor()
	r := e.hop(t, c, "/api/auth/social/google/start")
	ru, _ := url.Parse(e.srv.URL + "/api/auth/social/google/callback")
	tampered := false
	for _, ck := range c.client.Jar.Cookies(ru) {
		if ck.Name == social.FlowCookie {
			c.client.Jar.SetCookies(ru, []*http.Cookie{{Name: ck.Name, Value: "x" + ck.Value, Path: "/api/auth/social"}})
			tampered = true
		}
	}
	if !tampered {
		t.Fatal("cookie do fluxo não encontrado no jar")
	}
	state := mustState(t, r.Header.Get("Location"))
	if l := e.hop(t, c, "/api/auth/social/google/callback?code=ok&state="+state).Header.Get("Location"); l != "/login?social_error=state" {
		t.Fatalf("cookie adulterado: %s", l)
	}
	// o cookie do fluxo é de uso único (repetir o callback falha)
	d2 := e.rawActor()
	r2 := e.hop(t, d2, "/api/auth/social/google/start")
	st := mustState(t, r2.Header.Get("Location"))
	if l := e.hop(t, d2, "/api/auth/social/google/callback?code=ok&state="+st).Header.Get("Location"); l != "/auth/choose-username" {
		t.Fatalf("1ª vez: %s", l)
	}
	if l := e.hop(t, d2, "/api/auth/social/google/callback?code=ok&state="+st).Header.Get("Location"); l != "/login?social_error=state" {
		t.Fatalf("repetição: %s", l)
	}
	// recusa no provedor e falha do provedor
	f := e.rawActor()
	r3 := e.hop(t, f, "/api/auth/social/google/start")
	if l := e.hop(t, f, "/api/auth/social/google/callback?error=access_denied&state="+mustState(t, r3.Header.Get("Location"))).Header.Get("Location"); l != "/login?social_error=denied" {
		t.Fatalf("recusa: %s", l)
	}
	if l := e.socialFlow(t, e.rawActor(), "google", "", "codigo-desconhecido"); l != "/login?social_error=provider_error" {
		t.Fatalf("falha do provedor: %s", l)
	}
	// sem e-mail / e-mail não verificado
	g.codes["noemail"] = social.Profile{ID: "g2-" + uname, Name: "Sem email"}
	g.codes["unver"] = social.Profile{ID: "g3-" + uname, Email: "u-" + mail, EmailVerified: false}
	if l := e.socialFlow(t, e.rawActor(), "google", "", "noemail"); l != "/login?social_error=no_email" {
		t.Fatalf("sem e-mail: %s", l)
	}
	if l := e.socialFlow(t, e.rawActor(), "google", "", "unver"); l != "/login?social_error=email_unverified" {
		t.Fatalf("não verificado: %s", l)
	}
}

func mustState(t *testing.T, loc string) string {
	t.Helper()
	u, err := url.Parse(loc)
	if err != nil || u.Query().Get("state") == "" {
		t.Fatalf("Location sem state: %q", loc)
	}
	return u.Query().Get("state")
}

func TestSocialLinkUnlinkAndLastMethod(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	a := e.newActor(t, "vinculo")
	b := e.newActor(t, "vinculo2")
	g.codes["a"] = social.Profile{ID: "g-vinc-" + a.name, Email: "p-" + a.name + "@gmail.test", EmailVerified: true}
	d.codes["a"] = social.Profile{ID: "d-vinc-" + a.name, Email: "p-" + a.name + "@discord.test", EmailVerified: true}

	// vincular exige a senha confirmada há pouco
	if l := e.socialFlow(t, a, "google", "?intent=link&redirect=/settings/profile", "a"); l != "/settings/profile?social_error=need_confirm" {
		t.Fatalf("sem confirmação: %s", l)
	}
	// sem sessão não vincula
	if l := e.socialFlow(t, e.rawActor(), "google", "?intent=link", "a"); l != "/?social_error=need_session" {
		t.Fatalf("sem sessão: %s", l)
	}
	a.confirm(t, pw, 200)
	if l := e.socialFlow(t, a, "google", "?intent=link&redirect=/settings/profile", "a"); l != "/settings/profile?linked=google" {
		t.Fatalf("vincular: %s", l)
	}
	if l := e.socialFlow(t, a, "discord", "?intent=link&redirect=/settings/profile", "a"); l != "/settings/profile?linked=discord" {
		t.Fatalf("vincular discord: %s", l)
	}
	m := obj(t, a.call(t, "GET", "/api/users/me/login-methods", nil, 200))
	if m["has_password"] != true || len(list(m, "accounts")) != 2 {
		t.Fatalf("methods: %v", m)
	}
	// a mesma conta do provedor em OUTRO usuário
	b.confirm(t, pw, 200)
	if l := e.socialFlow(t, b, "google", "?intent=link&redirect=/settings/profile", "a"); l != "/settings/profile?social_error=already_linked" {
		t.Fatalf("já vinculada a outro: %s", l)
	}
	// a mesma conta nova (outro provedor id) no mesmo provedor do mesmo usuário
	g.codes["a2"] = social.Profile{ID: "g-outra-" + a.name, Email: "z@gmail.test", EmailVerified: true}
	if l := e.socialFlow(t, a, "google", "?intent=link&redirect=/settings/profile", "a2"); l != "/settings/profile?social_error=provider_linked" {
		t.Fatalf("provedor repetido: %s", l)
	}
	// login pelo provedor vinculado entra na conta do vínculo (e-mail do provedor é outro)
	c := e.rawActor()
	if l := e.socialFlow(t, c, "google", "", "a"); l != "/" {
		t.Fatalf("login vinculado: %s", l)
	}
	if str(obj(t, c.call(t, "GET", "/api/users/me", nil, 200)), "id") != a.id {
		t.Fatal("entrou na conta errada")
	}

	// desvincular exige confirmação; a de 10 min já existe
	other := e.loginAs(t, a, e.emailOf(t, a), pw)
	resp, body := other.do(t, "DELETE", "/api/auth/social/google", nil)
	status(t, resp, body, 403)
	if problemCode(t, body) != "password_confirmation_required" {
		t.Fatalf("code: %s", body)
	}
	a.call(t, "DELETE", "/api/auth/social/google", nil, 204)
	a.call(t, "DELETE", "/api/auth/social/google", nil, 404)
	a.call(t, "DELETE", "/api/auth/social/discord", nil, 204) // tem senha: pode ficar sem nenhum provedor
	if len(list(obj(t, a.call(t, "GET", "/api/users/me/login-methods", nil, 200)), "accounts")) != 0 {
		t.Fatal("deveria estar sem vínculos")
	}
}

func TestSocialOnlyAccountCannotUnlinkLastMethodButCanSetPassword(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	mail, uname := uniq("solo")
	g.codes["g"] = social.Profile{ID: "g-" + uname, Email: mail, EmailVerified: true, Name: "Solo"}
	d.codes["d"] = social.Profile{ID: "d-" + uname, Email: "d-" + mail, EmailVerified: true, Name: "Solo"}
	a := e.rawActor()
	e.socialFlow(t, a, "google", "", "g")
	a.call(t, "POST", "/api/auth/social/complete", J{"username": uname}, 201)

	// sem senha, confirmar por senha não existe; precisa reautenticar pelo provedor
	a.confirm(t, "qualquer", 422)
	resp, body := a.do(t, "DELETE", "/api/auth/social/google", nil)
	status(t, resp, body, 403)
	resp, body = a.do(t, "POST", "/api/users/me/password/initial", J{"new_password": "primeira-senha-1"})
	status(t, resp, body, 403)
	// vincular também exige reautenticação
	if l := e.socialFlow(t, a, "discord", "?intent=link&redirect=/settings/profile", "d"); l != "/settings/profile?social_error=need_confirm" {
		t.Fatalf("link sem reauth: %s", l)
	}
	// reautenticar com a conta ERRADA do provedor não vale
	g.codes["outra"] = social.Profile{ID: "g-estranha", Email: "estranha@gmail.test", EmailVerified: true}
	if l := e.socialFlow(t, a, "google", "?intent=reauth&redirect=/settings/profile", "outra"); l != "/settings/profile?social_error=wrong_account" {
		t.Fatalf("reauth errada: %s", l)
	}
	if l := e.socialFlow(t, a, "google", "?intent=reauth&redirect=/settings/profile", "g"); l != "/settings/profile?reauth=ok" {
		t.Fatalf("reauth: %s", l)
	}
	if !g.reauth {
		t.Fatal("reauth deve pedir ao provedor para reconfirmar a conta")
	}
	// último método: não desvincula
	resp, body = a.do(t, "DELETE", "/api/auth/social/google", nil)
	status(t, resp, body, 409)
	if problemCode(t, body) != "last_login_method" {
		t.Fatalf("code: %s", body)
	}
	// vincula o segundo provedor e então o primeiro pode sair
	if l := e.socialFlow(t, a, "discord", "?intent=link&redirect=/settings/profile", "d"); l != "/settings/profile?linked=discord" {
		t.Fatalf("link: %s", l)
	}
	a.call(t, "DELETE", "/api/auth/social/google", nil, 204)
	resp, body = a.do(t, "DELETE", "/api/auth/social/discord", nil)
	status(t, resp, body, 409) // agora é o último de novo

	// define a primeira senha (reautenticado) e só então pode desvincular tudo
	a.call(t, "POST", "/api/users/me/password/initial", J{"new_password": "curta"}, 422)
	a.call(t, "POST", "/api/users/me/password/initial", J{"new_password": "primeira-senha-1"}, 204)
	a.call(t, "POST", "/api/users/me/password/initial", J{"new_password": "primeira-senha-2"}, 409)
	a.call(t, "DELETE", "/api/auth/social/discord", nil, 204)
	e.rawActor().call(t, "POST", "/api/auth/login", J{"email": mail, "password": "primeira-senha-1"}, 200)
}

func TestSocialDeletedAccountsLoseLinks(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	a := e.newActor(t, "apaga")
	a.confirm(t, pw, 200)
	g.codes["x"] = social.Profile{ID: "g-apaga-" + a.name, Email: "x-" + a.name + "@g.test", EmailVerified: true}
	e.socialFlow(t, a, "google", "?intent=link", "x")
	a.call(t, "DELETE", "/api/users/me", J{"password": pw}, 204)
	var n int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM social_accounts WHERE provider_user_id=$1`, "g-apaga-"+a.name).Scan(&n)
	if n != 0 {
		t.Fatal("a exclusão da conta apaga os vínculos sociais")
	}
}

// ---------- login do desktop pelo navegador ----------

func pkce() (verifier, challenge string) {
	verifier = strings.Repeat("v", 20) + strings.Repeat("W", 30)
	return verifier, auth.PKCEChallenge(verifier)
}

func TestDesktopBrowserHandoff(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "deskbr")
	verifier, challenge := pkce()

	e.rawActor().call(t, "POST", "/api/auth/desktop/authorize", J{"code_challenge": challenge}, 401)
	a.call(t, "POST", "/api/auth/desktop/authorize", J{"code_challenge": "curto"}, 422)
	auth1 := obj(t, a.call(t, "POST", "/api/auth/desktop/authorize", J{"code_challenge": challenge}, 200))
	code := str(auth1, "code")
	if !strings.HasPrefix(str(auth1, "redirect_url"), "spook://auth?code="+code) {
		t.Fatalf("deep link: %v", auth1)
	}
	var plain int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM desktop_login_codes WHERE code_hash = convert_to($1,'UTF8')`, code).Scan(&plain)
	if plain != 0 {
		t.Fatal("o código não pode estar em claro no banco")
	}

	app := e.rawActor() // o app não tem cookie: só o código e o verificador
	// verificador errado queima o código
	bad := strings.Repeat("x", 50)
	app.call(t, "POST", "/api/auth/desktop/exchange", J{"code": code, "code_verifier": bad}, 422)
	app.call(t, "POST", "/api/auth/desktop/exchange", J{"code": code, "code_verifier": verifier}, 422)

	// fluxo feliz
	code2 := str(obj(t, a.call(t, "POST", "/api/auth/desktop/authorize", J{"code_challenge": challenge}, 200)), "code")
	out := obj(t, app.call(t, "POST", "/api/auth/desktop/exchange", J{"code": code2, "code_verifier": verifier}, 200))
	tok := str(out, "token")
	if tok == "" || str(obj2(out, "user"), "id") != a.id {
		t.Fatalf("exchange: %v", out)
	}
	resp, body := e.do(t, "GET", "/api/users/me", nil, map[string]string{"Authorization": "Bearer " + tok})
	status(t, resp, body, 200)
	app.call(t, "POST", "/api/auth/desktop/exchange", J{"code": code2, "code_verifier": verifier}, 422) // uso único

	// expira em 60 s
	code3 := str(obj(t, a.call(t, "POST", "/api/auth/desktop/authorize", J{"code_challenge": challenge}, 200)), "code")
	e.exec(t, `UPDATE desktop_login_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL AND user_id = $1`, a.id)
	app.call(t, "POST", "/api/auth/desktop/exchange", J{"code": code3, "code_verifier": verifier}, 422)
	var ttl float64
	_ = e.pool.QueryRow(context.Background(), `SELECT max(extract(epoch FROM (expires_at - created_at))) FROM desktop_login_codes WHERE user_id=$1 AND used_at IS NOT NULL`, a.id).Scan(&ttl)
	if ttl < 55 || ttl > 65 {
		t.Fatalf("TTL do código = %.0fs, esperado ~60s", ttl)
	}
}

func TestSessionAfterPasswordSetKeepsLoginWorking(t *testing.T) {
	// regressão: o hash marcador "!" nunca vale como senha, nem para verificar nem para trocar
	e := accountEnv(t)
	a := e.newActor(t, "marcador")
	email := e.emailOf(t, a)
	e.exec(t, `UPDATE users SET password_hash = '!' WHERE id = $1`, a.id)
	e.rawActor().call(t, "POST", "/api/auth/login", J{"email": email, "password": "!"}, 401)
	e.rawActor().call(t, "POST", "/api/auth/login", J{"email": email, "password": pw}, 401)
	a.call(t, "POST", "/api/users/me/password", J{"current_password": "!", "new_password": "nova-senha-456"}, 422)
}
