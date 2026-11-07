//go:build integration

package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/social"
)

// ---------- sessão persistente ("Manter conectado") e lista de sessões ----------

func sessionCookie(resp *http.Response) *http.Cookie {
	for _, c := range resp.Cookies() {
		if c.Name == "spook_session" {
			return c
		}
	}
	return nil
}

func (e *testEnv) loginNew(t *testing.T, email string, extra J) (*actor, *http.Response) {
	t.Helper()
	a := e.rawActor()
	body := J{"email": email, "password": pw}
	for k, v := range extra {
		body[k] = v
	}
	resp, b := a.do(t, "POST", "/api/auth/login", body)
	status(t, resp, b, 200)
	return a, resp
}

func (e *testEnv) sessionRow(t *testing.T, userID string) (remember bool, expiresIn, lastSeenAgo time.Duration) {
	t.Helper()
	var exp, seen float64
	err := e.pool.QueryRow(context.Background(), `SELECT remember, extract(epoch FROM (expires_at - now())), extract(epoch FROM (now() - last_seen_at)) FROM sessions WHERE user_id=$1::bigint ORDER BY created_at DESC LIMIT 1`, userID).Scan(&remember, &exp, &seen)
	if err != nil {
		t.Fatal(err)
	}
	return remember, time.Duration(exp * float64(time.Second)), time.Duration(seen * float64(time.Second))
}

func TestSessionCookieAndTTLFollowRememberFlag(t *testing.T) {
	e := accountEnv(t)
	email, username := uniq("rem")
	reg := e.rawActor()
	resp, b := reg.do(t, "POST", "/api/auth/register", J{"email": email, "username": username, "password": pw})
	status(t, resp, b, 201)
	// sem o campo `remember`: padrão true (compatível com o desktop e os testes antigos)
	c := sessionCookie(resp)
	if c == nil || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.MaxAge != 90*24*3600 {
		t.Fatalf("cadastro padrão: cookie persistente de 90 dias, veio %+v", c)
	}
	me := obj(t, reg.call(t, "GET", "/api/users/me", nil, 200))
	uid := str(me, "id")
	if rem, in, _ := e.sessionRow(t, uid); !rem || in < 89*24*time.Hour || in > 90*24*time.Hour {
		t.Fatalf("sessão padrão: remember=%v expira em %v", rem, in)
	}

	// login com remember explícito true
	_, resp = e.loginNew(t, email, J{"remember": true})
	if c := sessionCookie(resp); c == nil || c.MaxAge != 90*24*3600 {
		t.Fatalf("remember=true: %+v", c)
	}

	// remember=false: cookie de sessão (sem Max-Age nem Expires) e validade curta no servidor
	_, resp = e.loginNew(t, email, J{"remember": false})
	c = sessionCookie(resp)
	if c == nil || c.MaxAge != 0 || !c.Expires.IsZero() || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode {
		t.Fatalf("remember=false deve ser cookie de sessão: %+v (%v)", c, resp.Header["Set-Cookie"])
	}
	if rem, in, _ := e.sessionRow(t, uid); rem || in > 24*time.Hour || in < 23*time.Hour {
		t.Fatalf("sessão curta: remember=%v expira em %v", rem, in)
	}

	// cadastro com remember=false também vira cookie de sessão
	email2, user2 := uniq("rem2")
	resp, b = e.rawActor().do(t, "POST", "/api/auth/register", J{"email": email2, "username": user2, "password": pw, "remember": false})
	status(t, resp, b, 201)
	if c := sessionCookie(resp); c == nil || c.MaxAge != 0 {
		t.Fatalf("cadastro remember=false: %+v", c)
	}

	// desktop (Bearer): o token vale pelo mesmo critério no servidor
	resp, b = e.do(t, "POST", "/api/auth/login", J{"email": email, "password": pw}, map[string]string{"X-Spook-Client": "desktop"})
	status(t, resp, b, 200)
	tok := str(obj(t, b), "token")
	resp, b = e.do(t, "GET", "/api/users/me", nil, map[string]string{"Authorization": "Bearer " + tok})
	status(t, resp, b, 200)
	if rem, in, _ := e.sessionRow(t, uid); !rem || in < 89*24*time.Hour {
		t.Fatalf("desktop: sessão longa por padrão: %v %v", rem, in)
	}
}

func TestSlidingRenewalLimitedAndExpiry(t *testing.T) {
	e := accountEnv(t)
	email, username := uniq("slide")
	a := e.rawActor()
	resp, b := a.do(t, "POST", "/api/auth/register", J{"email": email, "username": username, "password": pw})
	status(t, resp, b, 201)
	uid := str(obj(t, a.call(t, "GET", "/api/users/me", nil, 200)), "id")

	// uso recente (< 1 h): nada é regravado nem o cookie reenviado
	resp, b = a.do(t, "GET", "/api/users/me", nil)
	status(t, resp, b, 200)
	if c := sessionCookie(resp); c != nil {
		t.Fatalf("sem renovação, sem Set-Cookie: %+v", c)
	}
	var before time.Time
	_ = e.pool.QueryRow(context.Background(), `SELECT last_seen_at FROM sessions WHERE user_id=$1::bigint`, uid).Scan(&before)
	_, _ = a.do(t, "GET", "/api/users/me", nil)
	var after time.Time
	_ = e.pool.QueryRow(context.Background(), `SELECT last_seen_at FROM sessions WHERE user_id=$1::bigint`, uid).Scan(&after)
	if !before.Equal(after) {
		t.Fatalf("last_seen_at não pode mudar dentro de 1 h: %v -> %v", before, after)
	}

	// 2 h sem uso e vencimento em 10 dias: o uso renova para ~90 dias e reenvia o cookie com o Max-Age novo
	e.exec(t, `UPDATE sessions SET last_seen_at = now() - interval '2 hours', expires_at = now() + interval '10 days' WHERE user_id=$1::bigint`, uid)
	resp, b = a.do(t, "GET", "/api/users/me", nil)
	status(t, resp, b, 200)
	c := sessionCookie(resp)
	if c == nil || c.MaxAge < 89*24*3600 || c.MaxAge > 90*24*3600 || !c.HttpOnly {
		t.Fatalf("renovação deve reenviar o cookie persistente: %+v", c)
	}
	if _, in, ago := e.sessionRow(t, uid); in < 89*24*time.Hour || ago > time.Minute {
		t.Fatalf("renovou? expira em %v, último uso há %v", in, ago)
	}
	// logo depois, o limite de 1 h segura a escrita
	resp, _ = a.do(t, "GET", "/api/users/me", nil)
	if sessionCookie(resp) != nil {
		t.Fatal("não deve renovar de novo dentro de 1 h")
	}

	// teto absoluto: sessão com 360 dias de criada renovada só até 365
	e.exec(t, `UPDATE sessions SET created_at = now() - interval '360 days', last_seen_at = now() - interval '2 hours', expires_at = now() + interval '1 day' WHERE user_id=$1::bigint`, uid)
	_, _ = a.do(t, "GET", "/api/users/me", nil)
	if _, in, _ := e.sessionRow(t, uid); in > 6*24*time.Hour {
		t.Fatalf("o teto de 365 dias da criação limita a renovação: %v", in)
	}

	// expirada: 401 (e o gateway também recusa pelo mesmo caminho)
	e.exec(t, `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id=$1::bigint`, uid)
	a.call(t, "GET", "/api/users/me", nil, 401)

	// sessão curta: ociosa por mais de 24 h expira; usada antes, desliza e não reenvia cookie
	b2, _ := e.loginNew(t, email, J{"remember": false})
	e.exec(t, `UPDATE sessions SET last_seen_at = now() - interval '2 hours', expires_at = now() + interval '1 hour' WHERE user_id=$1::bigint AND NOT remember`, uid)
	resp, body := b2.do(t, "GET", "/api/users/me", nil)
	status(t, resp, body, 200)
	if sessionCookie(resp) != nil {
		t.Fatal("cookie de sessão não é reenviado na renovação")
	}
	if rem, in, _ := e.sessionRow(t, uid); rem || in < 23*time.Hour {
		t.Fatalf("sessão curta desliza para +24 h: %v %v", rem, in)
	}
	e.exec(t, `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id=$1::bigint AND NOT remember`, uid)
	b2.call(t, "GET", "/api/users/me", nil, 401)

	// o janitor existente remove as expiradas (DeleteExpired)
	var n int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE user_id=$1::bigint AND expires_at < now()`, uid).Scan(&n)
	if n == 0 {
		t.Fatal("deveria haver sessões expiradas aguardando a limpeza")
	}
}

func TestSessionListAndRevoke(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "lista")
	email := e.emailOf(t, a)
	ua := map[string]string{"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
	resp, b := e.do(t, "POST", "/api/auth/login", J{"email": email, "password": pw, "remember": false}, ua)
	status(t, resp, b, 200)
	other := e.rawActor()
	resp, b = other.do(t, "POST", "/api/auth/login", J{"email": email, "password": pw, "remember": false})
	status(t, resp, b, 200)
	third, _ := e.loginNew(t, email, nil)

	out := obj(t, a.call(t, "GET", "/api/users/me/sessions", nil, 200))
	sessions := list(out, "sessions")
	if len(sessions) != 4 {
		t.Fatalf("esperava 4 sessões (cadastro + 3 logins), veio %d: %v", len(sessions), out)
	}
	cur := 0
	for _, s := range sessions {
		if s["current"] == true {
			cur++
		}
		if str(s, "id") == "" || s["created_at"] == nil || s["last_seen_at"] == nil || s["expires_at"] == nil {
			t.Fatalf("campos da sessão: %v", s)
		}
		for k := range s {
			if k == "ip" || k == "user_agent" || k == "token_hash" {
				t.Fatalf("a lista não expõe %s", k)
			}
		}
	}
	if cur != 1 {
		t.Fatalf("exatamente uma sessão atual: %d", cur)
	}
	sawChrome := false
	for _, s := range sessions {
		sawChrome = sawChrome || (str(s, "browser") == "Chrome" && str(s, "os") == "macOS" && s["remember"] == false)
	}
	if !sawChrome {
		t.Fatalf("o User-Agent deveria ser resumido (Chrome/macOS): %v", sessions)
	}

	// escolhe uma sessão que não é a atual
	var victim string
	for _, s := range sessions {
		if s["current"] != true {
			victim = str(s, "id")
		}
	}
	// encerrar exige a senha confirmada há pouco
	resp, b = a.do(t, "DELETE", "/api/users/me/sessions/"+victim, nil)
	status(t, resp, b, 403)
	if problemCode(t, b) != "password_confirmation_required" {
		t.Fatalf("code: %s", b)
	}
	resp, b = a.do(t, "POST", "/api/users/me/sessions/revoke-others", nil)
	status(t, resp, b, 403)

	a.confirm(t, pw, 200)
	var curID string
	for _, s := range sessions {
		if s["current"] == true {
			curID = str(s, "id")
		}
	}
	a.call(t, "DELETE", "/api/users/me/sessions/"+curID, nil, 422) // a atual: use "Sair"
	a.call(t, "DELETE", "/api/users/me/sessions/abc", nil, 404)
	a.call(t, "DELETE", "/api/users/me/sessions/123456", nil, 404)
	a.call(t, "DELETE", "/api/users/me/sessions/"+victim, nil, 204)
	a.call(t, "DELETE", "/api/users/me/sessions/"+victim, nil, 404)

	// a sessão de outro usuário não aparece nem pode ser encerrada
	stranger := e.newActor(t, "estranho")
	resp, b = stranger.do(t, "POST", "/api/auth/confirm-password", J{"password": pw})
	status(t, resp, b, 200)
	stranger.call(t, "DELETE", "/api/users/me/sessions/"+curID, nil, 404)
	a.call(t, "GET", "/api/users/me", nil, 200)

	if got := len(list(obj(t, a.call(t, "GET", "/api/users/me/sessions", nil, 200)), "sessions")); got != 3 {
		t.Fatalf("depois de encerrar uma: %d", got)
	}
	res := obj(t, a.call(t, "POST", "/api/users/me/sessions/revoke-others", nil, 200))
	if res["revoked"] != float64(2) {
		t.Fatalf("revoked: %v", res)
	}
	a.call(t, "GET", "/api/users/me", nil, 200)
	other.call(t, "GET", "/api/users/me", nil, 401)
	third.call(t, "GET", "/api/users/me", nil, 401)
	if got := len(list(obj(t, a.call(t, "GET", "/api/users/me/sessions", nil, 200)), "sessions")); got != 1 {
		t.Fatalf("só a atual: %d", got)
	}
	// sem sessão: 401
	e.rawActor().call(t, "GET", "/api/users/me/sessions", nil, 401)
}

func TestRevokedSessionDropsGatewayConnection(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "gwrev")
	email := e.emailOf(t, a)
	b, _ := e.loginNew(t, email, nil)
	ws := b.connect(t)
	ws.identify()

	var id string
	for _, s := range list(obj(t, a.call(t, "GET", "/api/users/me/sessions", nil, 200)), "sessions") {
		if s["current"] != true {
			id = str(s, "id")
		}
	}
	a.confirm(t, pw, 200)
	a.call(t, "DELETE", "/api/users/me/sessions/"+id, nil, 204)
	ws.expectClose(4010, 5*time.Second) // o gateway dessa sessão cai
}

// ---------- login social em conta existente ----------

func TestSocialLinksAndLogsInExistingVerifiedEmail(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	owner := e.newActor(t, "dono")
	email := e.emailOf(t, owner)
	e.exec(t, `UPDATE users SET email_verified_at = now() WHERE email = $1`, email) // já tinha o e-mail verificado

	// o provedor devolve o mesmo e-mail em outra caixa
	g.codes["c"] = social.Profile{ID: "g-" + owner.name, Email: strings.ToUpper(email), EmailVerified: true, Name: "Dono"}
	a := e.rawActor()
	if l := e.socialFlow(t, a, "google", "?redirect=/invite/abc", "c"); l != "/invite/abc" {
		t.Fatalf("deveria logar direto: %s", l)
	}
	me := obj(t, a.call(t, "GET", "/api/users/me", nil, 200))
	if str(me, "email") != email || str(me, "id") != owner.id || me["email_verified"] != true || me["has_password"] != true {
		t.Fatalf("me: %v", me)
	}
	methods := obj(t, a.call(t, "GET", "/api/users/me/login-methods", nil, 200))
	if accs := list(methods, "accounts"); len(accs) != 1 || str(accs[0], "provider") != "google" {
		t.Fatalf("vínculo: %v", methods)
	}
	// sessão longa (a mais recente é a do login social)
	if rem, in, _ := e.sessionRow(t, owner.id); !rem || in < 89*24*time.Hour {
		t.Fatalf("login social usa sessão longa: %v %v", rem, in)
	}
	// e-mail já verificado: NENHUMA outra sessão cai
	owner.call(t, "GET", "/api/users/me", nil, 200)
	// a senha continua valendo
	e.loginNew(t, email, nil)

	// segunda vez: entra direto pelo vínculo, sem novo vínculo
	b := e.rawActor()
	if l := e.socialFlow(t, b, "google", "", "c"); l != "/" {
		t.Fatalf("segunda vez: %s", l)
	}
	b.call(t, "GET", "/api/users/me", nil, 200)
	var n int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM social_accounts WHERE provider_user_id='g-'||$1`, owner.name).Scan(&n)
	if n != 1 {
		t.Fatalf("um único vínculo, veio %d", n)
	}

	// o mesmo vale para o Discord (verified=true) com outra conta do provedor
	d.codes["d"] = social.Profile{ID: "d-" + owner.name, Email: email, EmailVerified: true, Name: "Dono"}
	c := e.rawActor()
	if l := e.socialFlow(t, c, "discord", "", "d"); l != "/" {
		t.Fatalf("discord: %s", l)
	}
	c.call(t, "GET", "/api/users/me", nil, 200)
}

func TestSocialLinkVerifiesUnverifiedEmailAndDropsOtherSessions(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	// "pre-hijacking": alguém registrou o e-mail da vítima com senha antes (e-mail não verificado)
	attacker := e.newActor(t, "pre")
	email := e.emailOf(t, attacker)
	e.exec(t, `UPDATE users SET email_verified_at = NULL, pending_email = 'atacante@evil.test' WHERE email = $1`, email)
	// token de verificação aberto (emitido antes)
	e.exec(t, `INSERT INTO email_tokens (id, user_id, kind, email, token_hash, expires_at) SELECT (extract(epoch from clock_timestamp())*1000000)::bigint, id, 'email_change', 'atacante@evil.test', sha256(convert_to('tok-atacante-'||id,'UTF8')), now()+interval '1 hour' FROM users WHERE email=$1`, email)
	atk2, _ := e.loginNew(t, email, nil)
	atk2.call(t, "GET", "/api/users/me", nil, 200)

	g.codes["v"] = social.Profile{ID: "g-" + attacker.name, Email: email, EmailVerified: true, Name: "Vítima"}
	victim := e.rawActor()
	if l := e.socialFlow(t, victim, "google", "", "v"); l != "/" {
		t.Fatalf("deveria logar: %s", l)
	}
	me := obj(t, victim.call(t, "GET", "/api/users/me", nil, 200))
	if me["email_verified"] != true {
		t.Fatalf("e-mail deveria ter sido verificado: %v", me)
	}
	// todas as sessões antigas caíram
	attacker.call(t, "GET", "/api/users/me", nil, 401)
	atk2.call(t, "GET", "/api/users/me", nil, 401)
	var sessions int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE user_id=$1::bigint`, attacker.id).Scan(&sessions)
	if sessions != 1 {
		t.Fatalf("só a sessão social nova deveria existir: %d", sessions)
	}
	// a troca de e-mail pendente do atacante foi descartada e o token invalidado
	var pending *string
	var open int
	_ = e.pool.QueryRow(context.Background(), `SELECT pending_email FROM users WHERE email=$1`, email).Scan(&pending)
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM email_tokens WHERE user_id=$1::bigint AND used_at IS NULL`, attacker.id).Scan(&open)
	if pending != nil || open != 0 {
		t.Fatalf("pending_email=%v tokens abertos=%d", pending, open)
	}
}

func TestSocialRefusesUnverifiedOrMissingProviderEmail(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	victim := e.newActor(t, "recusa")
	email := e.emailOf(t, victim)

	g.codes["nv"] = social.Profile{ID: "g-nv-" + victim.name, Email: email, EmailVerified: false, Name: "X"}
	a := e.rawActor()
	if l := e.socialFlow(t, a, "google", "", "nv"); l != "/login?social_error=email_unverified" {
		t.Fatalf("e-mail não verificado pelo provedor: %s", l)
	}
	a.call(t, "GET", "/api/users/me", nil, 401)
	d.codes["ne"] = social.Profile{ID: "d-ne-" + victim.name, Email: "", EmailVerified: false, Name: "X"}
	if l := e.socialFlow(t, e.rawActor(), "discord", "", "ne"); l != "/login?social_error=no_email" {
		t.Fatalf("sem e-mail: %s", l)
	}
	var n int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM social_accounts WHERE provider_user_id IN ('g-nv-'||$1,'d-ne-'||$1)`, victim.name).Scan(&n)
	if n != 0 {
		t.Fatal("nada deve ser vinculado")
	}
	// a conta-alvo não perdeu nada
	victim.call(t, "GET", "/api/users/me", nil, 200)
	var verified bool
	_ = e.pool.QueryRow(context.Background(), `SELECT email_verified_at IS NOT NULL FROM users WHERE email=$1`, email).Scan(&verified)
	if verified {
		t.Fatal("recusa não pode verificar o e-mail")
	}
}

func TestSocialRefusesWhenAccountAlreadyHasAnotherAccountOfTheProvider(t *testing.T) {
	g, d := newFake("google"), newFake("discord")
	e := socialEnv(t, g, d)
	u := e.newActor(t, "dois")
	email := e.emailOf(t, u)
	u.confirm(t, pw, 200)
	g.codes["l"] = social.Profile{ID: "g-um-" + u.name, Email: "outro-" + email, EmailVerified: true, Name: "Um"}
	if l := e.socialFlow(t, u, "google", "?intent=link&redirect=/settings/profile", "l"); l != "/settings/profile?linked=google" {
		t.Fatalf("link: %s", l)
	}
	// outra conta Google, com o mesmo e-mail do Spook: a conta já tem um Google vinculado
	g.codes["m"] = social.Profile{ID: "g-dois-" + u.name, Email: email, EmailVerified: true, Name: "Dois"}
	if l := e.socialFlow(t, e.rawActor(), "google", "", "m"); l != "/login?social_error=provider_linked" {
		t.Fatalf("segunda conta Google: %s", l)
	}
}

func TestSocialDesktopHandoffSessionIsLong(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "deskrem")
	// a sessão por senha é curta de propósito; o handoff do desktop gera outra, longa
	e.exec(t, `UPDATE sessions SET remember = false WHERE user_id=$1::bigint`, a.id)
	verifier, challenge := pkce()
	code := str(obj(t, a.call(t, "POST", "/api/auth/desktop/authorize", J{"code_challenge": challenge}, 200)), "code")
	e.rawActor().call(t, "POST", "/api/auth/desktop/exchange", J{"code": code, "code_verifier": verifier}, 200)
	var n int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE user_id=$1::bigint AND remember`, a.id).Scan(&n)
	if n != 1 {
		t.Fatalf("handoff do desktop deve criar sessão longa: %d", n)
	}
}
