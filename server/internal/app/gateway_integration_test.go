//go:build integration

package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/devGustavoMuniz/spook/server/internal/gateway"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
)

// ---------- cliente WebSocket de teste ----------

type wsClient struct {
	t      *testing.T
	ws     *websocket.Conn
	frames chan gateway.Frame
	mu     sync.Mutex
	err    error
}

func (e *testEnv) wsURL(query string) string {
	return "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/api/gateway" + query
}

// wsDialErr devolve também o status HTTP do handshake (0 se não houve resposta).
func (e *testEnv) wsDialErr(hdr http.Header, query string) (*websocket.Conn, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, e.wsURL(query), &websocket.DialOptions{HTTPHeader: hdr})
	code := 0
	if resp != nil {
		code = resp.StatusCode
		if err != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	return ws, code, err
}

func (a *actor) cookieHeader(t *testing.T) http.Header {
	t.Helper()
	u, _ := url.Parse(a.e.srv.URL)
	var parts []string
	for _, c := range a.client.Jar.Cookies(u) {
		parts = append(parts, c.Name+"="+c.Value)
	}
	if len(parts) == 0 {
		t.Fatal("ator sem cookie de sessão")
	}
	return http.Header{"Cookie": {strings.Join(parts, "; ")}}
}

func newWS(t *testing.T, ws *websocket.Conn, pump bool) *wsClient {
	ws.SetReadLimit(1 << 20)
	c := &wsClient{t: t, ws: ws, frames: make(chan gateway.Frame, 8192)}
	t.Cleanup(func() { _ = ws.CloseNow() })
	if pump {
		go c.pump()
	}
	return c
}

func (c *wsClient) pump() {
	defer close(c.frames)
	for {
		_, b, err := c.ws.Read(context.Background())
		if err != nil {
			c.mu.Lock()
			c.err = err
			c.mu.Unlock()
			return
		}
		var f gateway.Frame
		if json.Unmarshal(b, &f) != nil {
			return
		}
		c.frames <- f
	}
}

func (a *actor) connect(t *testing.T) *wsClient {
	t.Helper()
	ws, _, err := a.e.wsDialErr(a.cookieHeader(t), "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return newWS(t, ws, true)
}

func (c *wsClient) read(d time.Duration) (gateway.Frame, error) {
	select {
	case f, ok := <-c.frames:
		if !ok {
			c.mu.Lock()
			defer c.mu.Unlock()
			return gateway.Frame{}, c.err
		}
		return f, nil
	case <-time.After(d):
		return gateway.Frame{}, context.DeadlineExceeded
	}
}

func (c *wsClient) must() gateway.Frame {
	c.t.Helper()
	f, err := c.read(5 * time.Second)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return f
}

func (c *wsClient) send(op gateway.Op, d any) {
	c.t.Helper()
	b, _ := json.Marshal(d)
	out, _ := json.Marshal(gateway.Frame{Op: op, D: b})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, out); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func isEvent(f gateway.Frame, name string) bool {
	return f.Op == gateway.OpDispatch && f.T != nil && *f.T == name
}

// identify faz HELLO → IDENTIFY → READY.
func (c *wsClient) identify() (sessionID string, ready J) {
	c.t.Helper()
	if h := c.must(); h.Op != gateway.OpHello {
		c.t.Fatalf("esperava HELLO, veio %+v", h)
	}
	c.send(gateway.OpIdentify, gateway.Identify{Client: "test"})
	f := c.must()
	if !isEvent(f, gateway.EventReady) || *f.S != 1 {
		c.t.Fatalf("esperava READY s=1, veio %+v", f)
	}
	if err := json.Unmarshal(f.D, &ready); err != nil {
		c.t.Fatal(err)
	}
	return str(ready, "session_id"), ready
}

func (c *wsClient) event(name string) gateway.Frame {
	c.t.Helper()
	for {
		f := c.must()
		if isEvent(f, name) {
			return f
		}
	}
}

// eventNot espera o evento name e falha se antes dele vier algum dos tipos proibidos.
func (c *wsClient) eventNot(name string, bad ...string) gateway.Frame {
	c.t.Helper()
	for {
		f := c.must()
		if isEvent(f, name) {
			return f
		}
		for _, b := range bad {
			if isEvent(f, b) {
				c.t.Fatalf("não deveria receber %s: %s", b, f.D)
			}
		}
	}
}

// noChannelEvents falha se chegar mensagem ou evento de canal durante d (eventos de servidor podem).
func (c *wsClient) noChannelEvents(d time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			return
		}
		if f.T != nil && (strings.HasPrefix(*f.T, "MESSAGE_") || strings.HasPrefix(*f.T, "CHANNEL_")) {
			c.t.Fatalf("não deveria receber %s: %s", *f.T, f.D)
		}
	}
}

func (c *wsClient) none(d time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			return
		}
		if f.Op == gateway.OpDispatch && f.T != nil {
			c.t.Fatalf("não deveria receber %s: %s", *f.T, f.D)
		}
	}
}

func (c *wsClient) expectClose(want websocket.StatusCode, d time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(d)
	for {
		_, err := c.read(time.Until(deadline))
		if err == nil {
			continue
		}
		if got := websocket.CloseStatus(err); got != want {
			c.t.Fatalf("fechou com %d (%v), esperado %d", got, err, want)
		}
		return
	}
}

func payload(t *testing.T, f gateway.Frame) J {
	t.Helper()
	var m J
	if err := json.Unmarshal(f.D, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func gwCfg(d *Deps) {
	bigLimits(d)
	d.GatewayLimiter = nil
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("não atingiu a tempo: %s", what)
}

// ---------- testes ----------

func TestGatewayHandshake(t *testing.T) {
	e := newEnvWith(t, gwCfg)
	u := e.newActor(t, "gw")

	if _, code, err := e.wsDialErr(nil, ""); err == nil || code != 401 {
		t.Fatalf("sem credenciais deveria dar 401: %v %d", err, code)
	}
	if _, code, err := e.wsDialErr(http.Header{"Authorization": {"Bearer lixo"}}, ""); err == nil || code != 401 {
		t.Fatalf("token inválido deveria dar 401: %d", code)
	}
	if _, code, err := e.wsDialErr(nil, "?ticket=lixo"); err == nil || code != 401 {
		t.Fatalf("ticket inválido deveria dar 401: %d", code)
	}
	resp, b := e.do(t, "POST", "/api/gateway/ticket", nil, nil)
	status(t, resp, b, 401) // o ticket exige sessão (e.client não tem cookie)

	// cookie (o upgrade passa por servertiming e otelhttp)
	u.connect(t).identify()

	// Bearer: o desktop pede o token com X-Spook-Client: desktop
	email, username := uniq("desk")
	resp, b = e.do(t, "POST", "/api/auth/register", J{"email": email, "username": username, "password": "senha-forte-123"},
		map[string]string{"X-Spook-Client": "desktop"})
	status(t, resp, b, 201)
	token := str(obj(t, b), "token")
	if token == "" {
		t.Fatalf("o desktop deveria receber o token: %s", b)
	}
	ws, _, err := e.wsDialErr(http.Header{"Authorization": {"Bearer " + token}}, "")
	if err != nil {
		t.Fatalf("bearer: %v", err)
	}
	newWS(t, ws, true).identify()

	// ticket de uso único
	tk := obj(t, u.call(t, "POST", "/api/gateway/ticket", nil, 201))
	if str(tk, "ticket") == "" || num(tk, "expires_in") != 30 {
		t.Fatalf("ticket = %v", tk)
	}
	ws, _, err = e.wsDialErr(nil, "?ticket="+str(tk, "ticket"))
	if err != nil {
		t.Fatalf("ticket: %v", err)
	}
	newWS(t, ws, true).identify()
	if _, code, err := e.wsDialErr(nil, "?ticket="+str(tk, "ticket")); err == nil || code != 401 {
		t.Fatalf("ticket reutilizado deveria dar 401: %d", code)
	}

	// origem estranha é recusada; a do Tauri passa
	h := u.cookieHeader(t)
	h.Set("Origin", "https://evil.example")
	if _, code, err := e.wsDialErr(h, ""); err == nil || code != 403 {
		t.Fatalf("origem estranha deveria dar 403: %d", code)
	}
	h.Set("Origin", "tauri://localhost")
	ws, _, err = e.wsDialErr(h, "")
	if err != nil {
		t.Fatalf("origem do Tauri: %v", err)
	}
	_ = ws.CloseNow()
}

func TestGatewayReadyAndLiveMessages(t *testing.T) {
	e := newEnvWith(t, gwCfg)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := owner.createGuild(t, "Realtime")
	member.join(t, owner, g.id)

	mc := member.connect(t)
	_, ready := mc.identify()
	gs := list(ready, "guilds")
	if str(obj2(ready, "user"), "id") != member.id || len(gs) != 1 || str(gs[0], "id") != g.id || len(list(gs[0], "channels")) != 3 {
		t.Fatalf("READY = %v", ready)
	}

	// a mensagem enviada por REST chega ao outro usuário sem recarregar
	owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "olá em tempo real"}, 201)
	m := payload(t, mc.event("MESSAGE_CREATE"))
	if str(m, "content") != "olá em tempo real" || str(m, "channel_id") != g.textID || str(obj2(m, "author"), "id") != owner.id {
		t.Fatalf("MESSAGE_CREATE = %v", m)
	}

	// edição e exclusão
	id := str(m, "id")
	owner.call(t, "PATCH", "/api/channels/"+g.textID+"/messages/"+id, J{"content": "editada"}, 200)
	if str(payload(t, mc.event("MESSAGE_UPDATE")), "content") != "editada" {
		t.Fatal("MESSAGE_UPDATE sem o conteúdo novo")
	}
	owner.call(t, "DELETE", "/api/channels/"+g.textID+"/messages/"+id, nil, 204)
	if str(payload(t, mc.event("MESSAGE_DELETE")), "id") != id {
		t.Fatal("MESSAGE_DELETE com id errado")
	}

	// servidor novo e canal novo (eventos de servidor/canal chegam sem recarregar)
	owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "novo"}, 201)
	newCh := payload(t, mc.event("CHANNEL_CREATE"))
	owner.call(t, "POST", "/api/channels/"+str(newCh, "id")+"/messages", J{"content": "no canal novo"}, 201)
	mc.event("MESSAGE_CREATE") // a sessão foi inscrita no canal novo

	// membro entra em outro servidor: GUILD_CREATE e os canais dele passam a valer
	g2 := owner.createGuild(t, "Segundo")
	member.join(t, owner, g2.id)
	mc.event("GUILD_CREATE")
	owner.call(t, "POST", "/api/channels/"+g2.textID+"/messages", J{"content": "no segundo"}, 201)
	if str(payload(t, mc.event("MESSAGE_CREATE")), "content") != "no segundo" {
		t.Fatal("mensagem do segundo servidor")
	}
}

func obj2(m J, k string) J {
	v, _ := m[k].(map[string]any)
	return v
}

func TestGatewayResume(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) { gwCfg(d); d.Gateway = gateway.Config{ResumeWindow: 10 * time.Second} })
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := owner.createGuild(t, "Resume")
	member.join(t, owner, g.id)
	post := func(txt string) {
		owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": txt}, 201)
	}

	mc := member.connect(t)
	sid, _ := mc.identify()
	post("m1")
	f := mc.event("MESSAGE_CREATE")
	last := *f.S

	_ = mc.ws.CloseNow() // queda no meio
	waitUntil(t, "sessão sem socket", func() bool { return e.app.Gateway.Stats().Conns == 0 })
	post("m2")
	post("m3")
	post("m4")

	mc2 := member.connect(t)
	if h := mc2.must(); h.Op != gateway.OpHello {
		t.Fatal("esperava HELLO")
	}
	mc2.send(gateway.OpResume, gateway.Resume{SessionID: sid, Seq: last})
	var got []string
	var seqs []int64
	for len(got) < 3 {
		f := mc2.must()
		if isEvent(f, "MESSAGE_CREATE") {
			got = append(got, str(payload(t, f), "content"))
			seqs = append(seqs, *f.S)
		}
	}
	if strings.Join(got, ",") != "m2,m3,m4" || seqs[0] != last+1 || seqs[2] != last+3 {
		t.Fatalf("replay = %v seqs=%v (último visto %d)", got, seqs, last)
	}
	if f := mc2.must(); !isEvent(f, gateway.EventResumed) {
		t.Fatalf("esperava RESUMED, veio %+v", f)
	}
	post("m5")
	if m := payload(t, mc2.event("MESSAGE_CREATE")); str(m, "content") != "m5" {
		t.Fatalf("depois do resume: %v", m)
	}
}

func TestGatewayExpiredSessionGetsInvalidSession(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		gwCfg(d)
		d.Gateway = gateway.Config{ResumeWindow: 300 * time.Millisecond}
	})
	u := e.newActor(t, "exp")
	c := u.connect(t)
	sid, _ := c.identify()
	_ = c.ws.CloseNow()
	waitUntil(t, "sessão expirar", func() bool { return e.app.Gateway.Stats().Sessions == 0 })

	c2 := u.connect(t)
	c2.must() // HELLO
	c2.send(gateway.OpResume, gateway.Resume{SessionID: sid, Seq: 1})
	if f := c2.must(); f.Op != gateway.OpInvalidSession {
		t.Fatalf("esperava op 9, veio %+v", f)
	}
	c2.send(gateway.OpIdentify, gateway.Identify{})
	if f := c2.must(); !isEvent(f, gateway.EventReady) {
		t.Fatalf("esperava READY depois do op 9, veio %+v", f)
	}
}

func TestGatewayNoViewChannelNoEvents(t *testing.T) {
	e := newEnvWith(t, gwCfg)
	owner, member, blind := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "cego")
	g := owner.createGuild(t, "Permissões")
	base := "/api/guilds/" + g.id
	// @everyone sem VIEW_CHANNEL; o cargo "Visitante" devolve VIEW_CHANNEL a quem o tem
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.SendMessages)}, 200)
	visitor := owner.role(t, g.id, J{"name": "Visitante", "position": 1, "permissions": int64(perm.ViewChannel)})
	member.join(t, owner, g.id)
	blind.join(t, owner, g.id)
	owner.giveRole(t, g.id, member.id, str(visitor, "id"))

	mc, bc := member.connect(t), blind.connect(t)
	_, mready := mc.identify()
	_, bready := bc.identify()
	if len(list(list(mready, "guilds")[0], "channels")) != 3 {
		t.Fatalf("membro com cargo deveria ver os canais: %v", mready)
	}
	if len(list(list(bready, "guilds")[0], "channels")) != 0 {
		t.Fatalf("sem VIEW_CHANNEL o READY não traz canais: %v", bready)
	}

	post := func(txt string) {
		owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": txt}, 201)
	}
	post("só para quem vê")
	mc.event("MESSAGE_CREATE")
	owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "secreto"}, 201)
	mc.event("CHANNEL_CREATE")
	// quem não vê recebe eventos do servidor (cargos, membros), nunca de canal nem de mensagem
	owner.role(t, g.id, J{"name": "aviso", "position": 1})
	bc.eventNot("ROLE_CREATE", "MESSAGE_CREATE", "CHANNEL_CREATE")
	bc.noChannelEvents(300 * time.Millisecond)

	// o cargo é removido no meio da sessão: o membro para de receber (mensagens e canais)
	owner.call(t, "DELETE", base+"/members/"+member.id+"/roles/"+str(visitor, "id"), nil, 200)
	mc.event("GUILD_MEMBER_UPDATE")
	post("depois de perder o cargo")
	owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "outro"}, 201)
	mc.none(400 * time.Millisecond)

	// e volta a receber ao ganhar o cargo de novo
	owner.giveRole(t, g.id, member.id, str(visitor, "id"))
	mc.event("GUILD_MEMBER_UPDATE")
	post("de volta")
	if str(payload(t, mc.event("MESSAGE_CREATE")), "content") != "de volta" {
		t.Fatal("deveria voltar a receber")
	}
	bc.noChannelEvents(100 * time.Millisecond)
}

func TestGatewayMissingHeartbeatDrops(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		gwCfg(d)
		d.Gateway = gateway.Config{HeartbeatInterval: 200 * time.Millisecond}
	})
	u := e.newActor(t, "hb")
	c := u.connect(t)
	c.identify()
	c.expectClose(gateway.CloseHeartbeatTimeout, 3*time.Second)

	// com heartbeats, a conexão se mantém além de 1,5× o intervalo
	c2 := u.connect(t)
	c2.identify()
	deadline := time.Now().Add(900 * time.Millisecond)
	for time.Now().Before(deadline) {
		c2.send(gateway.OpHeartbeat, nil)
		if f := c2.must(); f.Op != gateway.OpAck {
			t.Fatalf("esperava ACK, veio %+v", f)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestGatewayDropDoesNotAffectOthers(t *testing.T) {
	e := newEnvWith(t, gwCfg)
	owner, a, b := e.newActor(t, "dono"), e.newActor(t, "a"), e.newActor(t, "b")
	g := owner.createGuild(t, "Isolamento")
	a.join(t, owner, g.id)
	b.join(t, owner, g.id)
	ac, bc := a.connect(t), b.connect(t)
	ac.identify()
	bc.identify()
	_ = ac.ws.CloseNow()
	waitUntil(t, "queda de a", func() bool { return e.app.Gateway.Stats().Conns == 1 })
	owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "para b"}, 201)
	if str(payload(t, bc.event("MESSAGE_CREATE")), "content") != "para b" {
		t.Fatal("b deveria receber")
	}
}

func TestGatewaySlowConsumerIsCut(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		gwCfg(d)
		// Fila folgada o bastante para o consumidor RÁPIDO nunca estourá-la por um atraso do próprio teste (8 produtores
		// em rajada); o LENTO é cortado porque o volume (~19 MB) excede os buffers TCP do loopback (~10 MB) + a fila.
		d.Gateway = gateway.Config{SendQueue: 128, BufferSize: 64, ResumeWindow: 30 * time.Second}
	})
	owner, slow, fast := e.newActor(t, "dono"), e.newActor(t, "lento"), e.newActor(t, "rapido")
	g := owner.createGuild(t, "Lentos")
	slow.join(t, owner, g.id)
	fast.join(t, owner, g.id)

	ws, _, err := e.wsDialErr(slow.cookieHeader(t), "")
	if err != nil {
		t.Fatal(err)
	}
	sc := newWS(t, ws, false) // lê HELLO e READY e para de ler
	for i := 0; i < 2; i++ {
		if _, _, err := ws.Read(context.Background()); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			sc.send(gateway.OpIdentify, gateway.Identify{})
		}
	}
	fc := fast.connect(t)
	fc.identify()

	const total = 2400
	big := strings.Repeat("💥", 2000) // ~8 KB por mensagem (máximo de 2.000 caracteres)
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < total/8; i++ {
				owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": big}, 201)
			}
		}()
	}
	received := 0
	done := make(chan struct{})
	go func() {
		defer close(done)
		for received < total {
			f, err := fc.read(15 * time.Second)
			if err != nil {
				return
			}
			if isEvent(f, "MESSAGE_CREATE") {
				received++
			}
		}
	}()
	wg.Wait()
	<-done
	if received != total {
		t.Fatalf("o consumidor rápido recebeu %d/%d: o lento não pode afetá-lo", received, total)
	}

	// o lento, ao voltar a ler, encontra o fechamento 4008
	deadline := time.Now().Add(15 * time.Second)
	for {
		_, _, err := ws.Read(context.Background())
		if err != nil {
			if got := websocket.CloseStatus(err); got != gateway.CloseSlowConsumer {
				t.Fatalf("fechou com %d (%v), esperado 4008", got, err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("o consumidor lento não foi cortado")
		}
	}
	// a sessão dele continua (resume) e o servidor segue saudável
	waitUntil(t, "conexão lenta encerrar", func() bool { return e.app.Gateway.Stats().Conns == 1 })
	if st := e.app.Gateway.Stats(); st.Sessions != 2 {
		t.Fatalf("a sessão do consumidor lento deveria ser mantida: %+v", st)
	}
}

func TestGatewayGracefulShutdown(t *testing.T) {
	e := newEnvWith(t, gwCfg)
	a, b := e.newActor(t, "a"), e.newActor(t, "b")
	ac, bc := a.connect(t), b.connect(t)
	ac.identify()
	bc.identify()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- e.app.Gateway.Shutdown(ctx) }()
	ac.expectClose(gateway.CloseGoingAway, 5*time.Second)
	bc.expectClose(gateway.CloseGoingAway, 5*time.Second)
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	if _, code, err := e.wsDialErr(a.cookieHeader(t), ""); err == nil || code != 503 {
		t.Fatalf("depois do shutdown deveria dar 503: %v %d", err, code)
	}
}
