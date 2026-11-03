//go:build integration

package app

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/gif"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

func accountEnv(t *testing.T) *testEnv {
	return newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.AuthLimiter = ratelimit.New(100000, 100000)
		d.PasswordLimiter = ratelimit.New(100000, 100000)
		d.EmailLimiter = ratelimit.New(100000, 100000)
		d.DeleteLimiter = ratelimit.New(100000, 100000)
	})
}

const pw = "senha-forte-123"

func (a *actor) confirm(t *testing.T, password string, want int) []byte {
	t.Helper()
	return a.call(t, "POST", "/api/auth/confirm-password", J{"password": password}, want)
}

// loginAs abre uma segunda sessão (outro cookie jar) para o mesmo usuário.
func (e *testEnv) loginAs(t *testing.T, a *actor, email, password string) *actor {
	t.Helper()
	b := e.newActorRaw()
	b.call(t, "POST", "/api/auth/login", J{"email": email, "password": password}, 200)
	b.id, b.name = a.id, a.name
	return b
}

func (e *testEnv) newActorRaw() *actor {
	jar, _ := cookiejar.New(nil)
	return &actor{e: e, client: &http.Client{Jar: jar}}
}

// animatedGIF gera um GIF de 3 quadros: o processamento não pode achatá-lo.
func animatedGIF() []byte {
	pal := color.Palette{color.Black, color.White, color.RGBA{R: 255, A: 255}}
	g := &gif.GIF{LoopCount: 0}
	for i := 0; i < 3; i++ {
		img := image.NewPaletted(image.Rect(0, 0, 16, 16), pal)
		for x := 0; x < 16; x++ {
			img.SetColorIndex(x, i, uint8(1+i%2))
		}
		g.Image = append(g.Image, img)
		g.Delay = append(g.Delay, 10)
	}
	var b bytes.Buffer
	_ = gif.EncodeAll(&b, g)
	return b.Bytes()
}

func TestChangePasswordEndsOtherSessionsAndKeepsCurrent(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "troca")
	email := str(obj(t, a.call(t, "GET", "/api/users/me", nil, 200)), "email")
	other := e.loginAs(t, a, email, pw)
	// o outro dispositivo tem uma conexão aberta no gateway
	ws := other.connect(t)
	ws.identify()

	// regras: atual errada, nova curta, nova igual
	a.call(t, "POST", "/api/users/me/password", J{"current_password": "errada-123", "new_password": "nova-senha-456"}, 422)
	a.call(t, "POST", "/api/users/me/password", J{"current_password": pw, "new_password": "curta"}, 422)
	a.call(t, "POST", "/api/users/me/password", J{"current_password": pw, "new_password": pw}, 422)

	a.call(t, "POST", "/api/users/me/password", J{"current_password": pw, "new_password": "nova-senha-456"}, 204)

	a.call(t, "GET", "/api/users/me", nil, 200)     // a sessão atual continua
	other.call(t, "GET", "/api/users/me", nil, 401) // a outra caiu
	ws.expectClose(4010, 5*time.Second)             // e o gateway dela também

	e.loginAs(t, a, email, "nova-senha-456")
	e.newActorRaw().call(t, "POST", "/api/auth/login", J{"email": email, "password": pw}, 401)
}

func TestChangePasswordRequiresAuthAndRateLimit(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.AuthLimiter = ratelimit.New(100000, 100000)
		d.PasswordLimiter = ratelimit.New(0.001, 3)
	})
	anon := e.newActorRaw()
	anon.call(t, "POST", "/api/users/me/password", J{"current_password": pw, "new_password": "nova-senha-456"}, 401)
	anon.call(t, "POST", "/api/auth/confirm-password", J{"password": pw}, 401)

	a := e.newActor(t, "limite")
	for i := 0; i < 3; i++ {
		a.call(t, "POST", "/api/users/me/password", J{"current_password": "errada-123", "new_password": "nova-senha-456"}, 422)
	}
	resp, body := a.do(t, "POST", "/api/users/me/password", J{"current_password": "errada-123", "new_password": "nova-senha-456"}) //nolint:bodyclose // do já fecha o corpo
	status(t, resp, body, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}
}

func TestConfirmPasswordGatesEmailChange(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "mail")
	b := e.newActor(t, "mail2")
	taken := str(obj(t, b.call(t, "GET", "/api/users/me", nil, 200)), "email")
	newMail, _ := uniq("novo")

	// sem confirmação: 403 com código estável
	resp, body := a.do(t, "PUT", "/api/users/me/email", J{"email": newMail})
	status(t, resp, body, 403)
	if m := obj(t, body); str(m, "code") != "password_confirmation_required" {
		t.Fatalf("code inesperado: %s", body)
	}
	a.confirm(t, "errada-123", 422)
	resp, body = a.do(t, "PUT", "/api/users/me/email", J{"email": newMail})
	status(t, resp, body, 403)

	out := obj(t, a.confirm(t, pw, 200))
	if str(out, "confirmed_until") == "" {
		t.Fatalf("confirmed_until ausente: %v", out)
	}
	a.call(t, "PUT", "/api/users/me/email", J{"email": "sem-arroba"}, 422)
	a.call(t, "PUT", "/api/users/me/email", J{"email": strings.ToUpper(taken)}, 409) // citext: unicidade sem caixa
	me := obj(t, a.call(t, "PUT", "/api/users/me/email", J{"email": newMail}, 200))
	if str(me, "email") != newMail {
		t.Fatalf("e-mail não mudou: %v", me)
	}
	// login pelo e-mail novo
	e.newActorRaw().call(t, "POST", "/api/auth/login", J{"email": newMail, "password": pw}, 200)

	// a confirmação é por sessão: outra sessão do mesmo usuário continua exigindo
	other := e.loginAs(t, a, newMail, pw)
	resp, body = other.do(t, "PUT", "/api/users/me/email", J{"email": "outro-" + newMail})
	status(t, resp, body, 403)

	// expira em 10 min
	if _, err := e.pool.Exec(context.Background(), `UPDATE sessions SET password_confirmed_at = now() - interval '11 minutes' WHERE user_id = $1`, mustInt(t, a.id)); err != nil {
		t.Fatal(err)
	}
	resp, body = a.do(t, "PUT", "/api/users/me/email", J{"email": "outro-" + newMail})
	status(t, resp, body, 403)
}

func TestReservedUsernamesAreRefused(t *testing.T) {
	e := accountEnv(t)
	for _, n := range []string{"admin", "Admin", "root", "spook", "suporte", "everyone", "here", "null", "removido_9"} {
		name := strings.ToLower(n)
		resp, body := e.newActorRaw().do(t, "POST", "/api/auth/register", J{"email": "r-" + name + "@teste.spook", "username": name, "password": pw})
		status(t, resp, body, 422)
		if !strings.Contains(string(body), "reservado") {
			t.Fatalf("mensagem deveria explicar a reserva: %s", body)
		}
	}
}

func TestProfileBioPronounsBannerAndAnimatedAvatar(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "perfil")

	me := obj(t, a.call(t, "PATCH", "/api/users/me", J{"bio": "  Estudando Go  ", "pronouns": "ele/dele", "banner_color": 0xFF8800}, 200))
	if str(me, "bio") != "Estudando Go" || str(me, "pronouns") != "ele/dele" || num(me, "banner_color") != 0xFF8800 || str(me, "banner_url") != "" {
		t.Fatalf("perfil: %v", me)
	}
	a.call(t, "PATCH", "/api/users/me", J{"bio": strings.Repeat("a", 191)}, 422)
	a.call(t, "PATCH", "/api/users/me", J{"pronouns": strings.Repeat("a", 41)}, 422)
	a.call(t, "PATCH", "/api/users/me", J{"banner_color": 1 << 25}, 422)
	a.call(t, "PATCH", "/api/users/me", J{"banner_key": "banners/1/x.png", "banner_color": 1}, 422)
	a.call(t, "PATCH", "/api/users/me", J{"banner_key": "banners/999999/x.png"}, 422) // chave de outro usuário

	// banner por upload (GIF animado: preservado byte a byte)
	gif := animatedGIF()
	for _, kind := range []string{"banner", "avatar"} {
		up := obj(t, a.call(t, "POST", "/api/users/me/"+kind, J{"content_type": "image/gif", "size": len(gif)}, 200))
		req, _ := http.NewRequest(http.MethodPut, str(up, "upload_url"), bytes.NewReader(gif))
		req.Header.Set("Content-Type", "image/gif")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			t.Skipf("PUT direto ao storage recusado (%d): CORS/rede do ambiente; o CI cobre", resp.StatusCode)
		}
		patch := J{kind + "_key": str(up, "key")}
		me = obj(t, a.call(t, "PATCH", "/api/users/me", patch, 200))
		got, ct := download(t, str(me, kind+"_url"))
		if !bytes.Equal(got, gif) || ct != "image/gif" {
			t.Fatalf("%s animado deveria sair idêntico ao enviado (%s, %d vs %d bytes)", kind, ct, len(got), len(gif))
		}
	}
	if num(me, "banner_color") != 0 {
		t.Fatalf("imagem deveria limpar a cor: %v", me)
	}
	a.call(t, "POST", "/api/users/me/banner", J{"content_type": "image/svg+xml", "size": 10}, 422)
	a.call(t, "POST", "/api/users/me/banner", J{"content_type": "image/png", "size": 5<<20 + 1}, 422)

	me = obj(t, a.call(t, "PATCH", "/api/users/me", J{"remove_banner": true, "bio": "", "pronouns": ""}, 200))
	if str(me, "banner_url") != "" || me["banner_color"] != nil || str(me, "bio") != "" {
		t.Fatalf("remoção: %v", me)
	}
}

func TestMemberPayloadCarriesProfile(t *testing.T) {
	e := accountEnv(t)
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Perfis")
	owner.call(t, "PATCH", "/api/users/me", J{"bio": "dono do pedaço", "pronouns": "ela/dela", "banner_color": 255}, 200)
	members := list(obj(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/members", nil, 200)), "members")
	var found bool
	for _, m := range members {
		if str(m, "user_id") == owner.id {
			found = true
			if str(m, "bio") != "dono do pedaço" || str(m, "pronouns") != "ela/dela" || num(m, "banner_color") != 255 {
				t.Fatalf("membro sem perfil: %v", m)
			}
		}
	}
	if !found {
		t.Fatal("dono não listado")
	}
}

func TestDeleteAccountRefusesOwnerAndRequiresPassword(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "dono")
	g := a.createGuild(t, "Meu Servidor")
	anon := e.newActorRaw()
	anon.call(t, "DELETE", "/api/users/me", J{"password": pw}, 401)

	a.call(t, "DELETE", "/api/users/me", J{"password": "errada-123"}, 422)
	resp, body := a.do(t, "DELETE", "/api/users/me", J{"password": pw})
	status(t, resp, body, 409)
	m := obj(t, body)
	gs := list(m, "guilds")
	if str(m, "code") != "owns_guilds" || len(gs) != 1 || str(gs[0], "id") != g.id || str(gs[0], "name") != "Meu Servidor" {
		t.Fatalf("409 deveria listar os servidores: %s", body)
	}
	a.call(t, "GET", "/api/users/me", nil, 200) // nada foi apagado

	// excluindo o servidor, a conta pode ser excluída
	a.confirm(t, pw, 200)
	a.call(t, "DELETE", "/api/guilds/"+g.id, nil, 204)
	a.call(t, "DELETE", "/api/users/me", J{"password": pw}, 204)
}

func TestDeleteAccountCascadeKeepsMessagesAnonymized(t *testing.T) {
	e := accountEnv(t)
	owner := e.newActor(t, "dono")
	leaver := e.newActor(t, "saindo")
	friend := e.newActor(t, "amigo")
	g := owner.createGuild(t, "Comunidade")
	leaver.join(t, owner, g.id)
	friend.join(t, owner, g.id)

	msg := obj(t, leaver.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "volto já"}, 201))
	invite := leaver.invite(t, g.id)
	_ = invite

	// DM 1:1 e DM em grupo (o excluído é o dono do grupo)
	dm := leaver.openDM(t, friend.id, 201)
	leaver.say(t, str(dm, "id"), "oi amigo", 201)
	group := leaver.newGroup(t, 201, friend.id, owner.id)

	// avatar + banner no S3
	png := pngBytes(t, 8, 8, 255)
	var keys []string
	for _, kind := range []string{"avatar", "banner"} {
		up := obj(t, leaver.call(t, "POST", "/api/users/me/"+kind, J{"content_type": "image/png", "size": len(png)}, 200))
		req, _ := http.NewRequest(http.MethodPut, str(up, "upload_url"), bytes.NewReader(png))
		req.Header.Set("Content-Type", "image/png")
		if resp, err := http.DefaultClient.Do(req); err == nil {
			_ = resp.Body.Close()
		}
		leaver.call(t, "PATCH", "/api/users/me", J{kind + "_key": str(up, "key")}, 200)
		keys = append(keys, str(up, "key"))
	}
	ctx := context.Background()
	if _, err := e.pool.Exec(ctx, `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, 'x', 'y')`,
		time.Now().UnixNano(), mustInt(t, leaver.id), "https://push.example/"+leaver.id); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `INSERT INTO notification_settings (user_id, scope, target_id, muted) VALUES ($1, 'guild', $2, true)`,
		mustInt(t, leaver.id), mustInt(t, g.id)); err != nil {
		t.Fatal(err)
	}

	ownerWS := owner.connect(t)
	ownerWS.identify()
	leaverWS := leaver.connect(t)
	leaverWS.identify()
	friendWS := friend.connect(t)
	friendWS.identify()

	leaver.call(t, "DELETE", "/api/users/me", J{"password": pw}, 204)

	// sessão encerrada e gateway derrubado
	leaver.call(t, "GET", "/api/users/me", nil, 401)
	leaverWS.expectClose(4010, 5*time.Second)
	// quem ficou vê o membro sair
	ownerWS.event("GUILD_MEMBER_REMOVE")

	id := mustInt(t, leaver.id)
	var username string
	var display, avatar, banner, bio *string
	var deleted *time.Time
	if err := e.pool.QueryRow(context.Background(), `SELECT username, display_name, avatar_key, banner_key, bio, deleted_at FROM users WHERE id=$1`, id).
		Scan(&username, &display, &avatar, &banner, &bio, &deleted); err != nil {
		t.Fatal(err)
	}
	if username != "removido_"+leaver.id || display != nil || avatar != nil || banner != nil || bio != nil || deleted == nil {
		t.Fatalf("usuário não foi anonimizado: %s %v %v %v %v %v", username, display, avatar, banner, bio, deleted)
	}
	count := func(q string) int {
		var n int
		if err := e.pool.QueryRow(context.Background(), q, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for _, q := range []string{
		`SELECT count(*) FROM sessions WHERE user_id=$1`,
		`SELECT count(*) FROM guild_members WHERE user_id=$1`,
		`SELECT count(*) FROM push_subscriptions WHERE user_id=$1`,
		`SELECT count(*) FROM notification_settings WHERE user_id=$1`,
		`SELECT count(*) FROM read_states WHERE user_id=$1`,
		`SELECT count(*) FROM channel_recipients r JOIN channels c ON c.id=r.channel_id WHERE r.user_id=$1 AND c.type=4`,
	} {
		if n := count(q); n != 0 {
			t.Fatalf("deveria ter apagado: %s (%d)", q, n)
		}
	}
	// a mensagem fica, agora com autor anonimizado
	hist := obj(t, owner.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 200))
	var seen bool
	for _, m := range list(hist, "messages") {
		if str(m, "id") == str(msg, "id") {
			seen = true
			au, _ := m["author"].(map[string]any)
			if au["username"] != "removido_"+leaver.id {
				t.Fatalf("autor deveria virar removido_<id>: %v", au)
			}
		}
	}
	if !seen {
		t.Fatal("a mensagem deveria permanecer")
	}
	// DM 1:1 continua para o amigo; grupo muda de dono e perde o participante
	dms := arr(t, friend.call(t, "GET", "/api/users/@me/channels", nil, 200))
	var gotDM, gotGroup bool
	for _, d := range dms {
		switch str(d, "id") {
		case str(dm, "id"):
			gotDM = true
		case str(group, "id"):
			gotGroup = true
			if len(list(d, "recipients")) != 2 {
				t.Fatalf("grupo deveria ficar sem o excluído: %v", d)
			}
			if str(d, "owner_id") == leaver.id {
				t.Fatal("o dono do grupo deveria passar para outro participante")
			}
		}
	}
	if !gotDM || !gotGroup {
		t.Fatalf("DMs do amigo: dm=%v grupo=%v", gotDM, gotGroup)
	}
	friendWS.event("CHANNEL_UPDATE")

	// os arquivos saem do S3 por job River
	if !strings.HasPrefix(keys[0], "avatars/") {
		t.Fatal("chave de avatar inesperada")
	}
	waitUntil2(t, "arquivos removidos do S3", 20*time.Second, func() bool {
		url, err := testStorage(t).PresignGet(context.Background(), keys[0], time.Minute)
		if err != nil {
			return false
		}
		resp, err := http.Get(url)
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		return resp.StatusCode == http.StatusNotFound
	})

	// o e-mail e o username antigos ficam livres e a conta não loga mais
	resp, body := e.newActorRaw().do(t, "POST", "/api/auth/login", J{"email": "removido_" + leaver.id + "@removed.invalid", "password": pw})
	status(t, resp, body, 401)
}
