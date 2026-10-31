package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/devGustavoMuniz/spook/server/internal/auth"
	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/servertiming"
)

// ---- dublês ----

type fakeDir struct {
	mu       sync.Mutex
	perms    map[[2]int64]perm.Perm // (guild, user) -> permissões; ausente = não é membro
	channels map[int64][]int64      // guild -> canais
}

func newFakeDir() *fakeDir {
	return &fakeDir{perms: map[[2]int64]perm.Perm{}, channels: map[int64][]int64{}}
}

func (d *fakeDir) setPerm(g, u int64, p perm.Perm) {
	d.mu.Lock()
	d.perms[[2]int64{g, u}] = p
	d.mu.Unlock()
}

func (d *fakeDir) kick(g, u int64) {
	d.mu.Lock()
	delete(d.perms, [2]int64{g, u})
	d.mu.Unlock()
}

func (d *fakeDir) List(_ context.Context, u int64) ([]guild.Detail, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []guild.Detail{}
	for k, p := range d.perms {
		if k[1] != u {
			continue
		}
		det := guild.Detail{Guild: guild.Guild{ID: k[0], Name: "g" + strconv.FormatInt(k[0], 10), OwnerID: 1}, Member: perm.NewMember(u, false, p, 0)}
		if det.Member.Has(perm.ViewChannel) {
			for _, c := range d.channels[k[0]] {
				det.Channels = append(det.Channels, channel.Channel{ID: c, GuildID: &k[0]})
			}
		}
		out = append(out, det)
	}
	return out, nil
}

func (d *fakeDir) Member(_ context.Context, g, u int64) (perm.Member, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, ok := d.perms[[2]int64{g, u}]
	if !ok {
		return perm.Member{}, perm.ErrNotMember
	}
	return perm.NewMember(u, false, p, 0), nil
}

func (d *fakeDir) ChannelIDs(_ context.Context, g int64) ([]int64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]int64(nil), d.channels[g]...), nil
}

type fakeAuth map[string]int64

func (a fakeAuth) Authenticate(_ context.Context, tok string) (int64, error) {
	if id, ok := a[tok]; ok {
		return id, nil
	}
	return 0, auth.ErrUnauthorized
}

type rig struct {
	t   *testing.T
	hub *Hub
	bus *events.Bus
	dir *fakeDir
	srv *httptest.Server
}

// newRig sobe o gateway atrás dos mesmos middlewares da aplicação (servertiming + otelhttp),
// o que também prova que o upgrade passa por eles.
func newRig(t *testing.T, cfg Config, opts ...Option) *rig {
	t.Helper()
	dir := newFakeDir()
	bus := events.NewBus(4096)
	ctx, cancel := context.WithCancel(context.Background())
	hub := NewHub(ctx, cfg, dir, bus, opts...)
	h := NewHandler(hub, fakeAuth{"tok-1": 1, "tok-2": 2, "tok-3": 3}, nil)
	r := chi.NewRouter()
	r.Use(servertiming.Middleware)
	r.Method(http.MethodGet, "/api/gateway", h)
	srv := httptest.NewServer(otelhttp.NewHandler(r, "http.server"))
	rg := &rig{t: t, hub: hub, bus: bus, dir: dir, srv: srv}
	t.Cleanup(func() {
		cancel()
		sctx, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = hub.Shutdown(sctx)
		srv.Close()
	})
	return rg
}

func fastCfg() Config {
	return Config{
		HeartbeatInterval: 200 * time.Millisecond, IdentifyTimeout: 300 * time.Millisecond,
		ResumeWindow: 400 * time.Millisecond, WriteTimeout: 2 * time.Second,
	}
}

// client lê numa goroutine própria: o coder/websocket fecha a conexão quando o contexto de um
// Read expira, então os testes esperam por um canal em vez de ler com prazo.
type client struct {
	t      *testing.T
	ws     *websocket.Conn
	frames chan Frame
	mu     sync.Mutex
	err    error
}

func newClient(t *testing.T, ws *websocket.Conn, pump bool) *client {
	ws.SetReadLimit(1 << 20)
	c := &client{t: t, ws: ws, frames: make(chan Frame, 4096)}
	t.Cleanup(func() { _ = ws.CloseNow() })
	if pump {
		go c.pump()
	}
	return c
}

func (c *client) pump() {
	defer close(c.frames)
	for {
		_, b, err := c.ws.Read(context.Background())
		if err != nil {
			c.mu.Lock()
			c.err = err
			c.mu.Unlock()
			return
		}
		var f Frame
		if err := json.Unmarshal(b, &f); err != nil {
			return
		}
		c.frames <- f
	}
}

// dialErr devolve também o status HTTP da resposta de handshake (0 se não houve resposta).
func (r *rig) dialErr(hdr http.Header, query string) (*websocket.Conn, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	u := "ws" + strings.TrimPrefix(r.srv.URL, "http") + "/api/gateway" + query
	ws, resp, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: hdr})
	code := 0
	if resp != nil {
		code = resp.StatusCode
		if err != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	return ws, code, err
}

func (r *rig) dial(tok string) *client {
	r.t.Helper()
	ws, _, err := r.dialErr(http.Header{"Authorization": {"Bearer " + tok}}, "")
	if err != nil {
		r.t.Fatalf("dial: %v", err)
	}
	return newClient(r.t, ws, true)
}

func (c *client) read(timeout time.Duration) (Frame, error) {
	select {
	case f, ok := <-c.frames:
		if !ok {
			c.mu.Lock()
			defer c.mu.Unlock()
			return Frame{}, c.err
		}
		return f, nil
	case <-time.After(timeout):
		return Frame{}, context.DeadlineExceeded
	}
}

func (c *client) mustRead() Frame {
	c.t.Helper()
	f, err := c.read(3 * time.Second)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return f
}

func (c *client) send(op Op, d any) {
	c.t.Helper()
	b, _ := json.Marshal(d)
	out, _ := json.Marshal(Frame{Op: op, D: b})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, out); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

// identify faz HELLO → IDENTIFY → READY e devolve o session_id.
func (c *client) identify() (sessionID string, ready Frame) {
	c.t.Helper()
	if h := c.mustRead(); h.Op != OpHello {
		c.t.Fatalf("esperava HELLO, veio %+v", h)
	}
	c.send(OpIdentify, Identify{Client: "test"})
	ready = c.mustRead()
	if ready.Op != OpDispatch || ready.T == nil || *ready.T != EventReady || *ready.S != 1 {
		c.t.Fatalf("esperava READY s=1, veio %+v", ready)
	}
	var r struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(ready.D, &r)
	return r.SessionID, ready
}

func (c *client) expectClose(want websocket.StatusCode, timeout time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, err := c.read(time.Until(deadline))
		if err == nil {
			continue
		}
		if errors.Is(err, context.DeadlineExceeded) {
			break
		}
		if got := websocket.CloseStatus(err); got != want {
			c.t.Fatalf("fechou com %d (%v), esperado %d", got, err, want)
		}
		return
	}
	c.t.Fatalf("a conexão não fechou com %d", want)
}

// expectEvent lê até achar o evento t (ignora acks); falha se nada vier no prazo.
func (c *client) expectEvent(t string) Frame {
	c.t.Helper()
	for {
		f, err := c.read(3 * time.Second)
		if err != nil {
			c.t.Fatalf("esperando %s: %v", t, err)
		}
		if f.Op == OpDispatch && f.T != nil && *f.T == t {
			return f
		}
	}
}

// expectNone confirma que nenhum dispatch chega durante d.
func (c *client) expectNone(d time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			return
		}
		if f.Op == OpDispatch && f.T != nil {
			c.t.Fatalf("não deveria receber %s", *f.T)
		}
	}
}

func (r *rig) msg(guildID, channelID int64, id string) {
	r.bus.Publish(events.Event{
		Type: events.MessageCreate, GuildID: guildID, ChannelID: channelID,
		Topics: []string{channelTopic(channelID)}, Data: map[string]string{"id": id},
	})
}

func seqOf(f Frame) int64 { return *f.S }

// ---- testes ----

func TestHandshakeAuth(t *testing.T) {
	r := newRig(t, fastCfg())
	_, code, err := r.dialErr(nil, "")
	if err == nil || code == 0 || code != http.StatusUnauthorized {
		t.Fatalf("sem credencial deveria dar 401: err=%v status=%d", err, code)
	}
	_, code, err = r.dialErr(http.Header{"Authorization": {"Bearer errado"}}, "")
	if err == nil || code != http.StatusUnauthorized {
		t.Fatalf("token inválido deveria dar 401, deu %d", code)
	}

	// Bearer
	r.dial("tok-1").identify()

	// Cookie
	ws, _, err := r.dialErr(http.Header{"Cookie": {auth.CookieName + "=tok-2"}}, "")
	if err != nil {
		t.Fatalf("cookie: %v", err)
	}
	newClient(t, ws, true).identify()

	// Ticket: uso único
	tk, _ := r.hub.tk.issue(3)
	ws, _, err = r.dialErr(nil, "?ticket="+tk)
	if err != nil {
		t.Fatalf("ticket: %v", err)
	}
	newClient(t, ws, true).identify()
	_, code, err = r.dialErr(nil, "?ticket="+tk)
	if err == nil || code != http.StatusUnauthorized {
		t.Fatalf("ticket reutilizado deveria dar 401, deu %d", code)
	}
}

func TestHandshakeOrigin(t *testing.T) {
	cfg := fastCfg()
	cfg.AllowedOrigins = []string{"tauri://localhost", "http://tauri.localhost"}
	r := newRig(t, cfg)
	for origin, want := range map[string]bool{
		"tauri://localhost":      true,
		"http://tauri.localhost": true,
		"https://evil.example":   false,
		"null":                   false,
	} {
		ws, code, err := r.dialErr(http.Header{"Authorization": {"Bearer tok-1"}, "Origin": {origin}}, "")
		if err == nil {
			_ = ws.CloseNow()
		}
		if want && err != nil {
			t.Errorf("origem %s deveria passar: %v", origin, err)
		}
		if !want && (err == nil || code != http.StatusForbidden) {
			t.Errorf("origem %s deveria dar 403 (deu %d)", origin, code)
		}
	}
	// o próprio host do serviço
	host := strings.TrimPrefix(r.srv.URL, "http://")
	if ws, _, err := r.dialErr(http.Header{"Authorization": {"Bearer tok-1"}, "Origin": {"http://" + host}}, ""); err != nil {
		t.Errorf("origem do próprio host deveria passar: %v", err)
	} else {
		_ = ws.CloseNow()
	}
	// dev aceita localhost em qualquer porta
	cfg.Dev = true
	r2 := newRig(t, cfg)
	if ws, _, err := r2.dialErr(http.Header{"Authorization": {"Bearer tok-1"}, "Origin": {"http://localhost:5173"}}, ""); err != nil {
		t.Errorf("dev deveria aceitar localhost:5173: %v", err)
	} else {
		_ = ws.CloseNow()
	}
}

func TestIdentifyReadyAndMessageFanout(t *testing.T) {
	r := newRig(t, fastCfg())
	r.dir.channels[10] = []int64{100, 101}
	r.dir.setPerm(10, 1, perm.DefaultEveryone)
	r.dir.setPerm(10, 2, perm.DefaultEveryone)

	a, b := r.dial("tok-1"), r.dial("tok-2")
	_, ready := a.identify()
	b.identify()

	var rd struct {
		User   ReadyUser `json:"user"`
		Guilds []struct {
			ID       string `json:"id"`
			Channels []struct {
				ID string `json:"id"`
			} `json:"channels"`
		} `json:"guilds"`
	}
	if err := json.Unmarshal(ready.D, &rd); err != nil || rd.User.ID != "1" || len(rd.Guilds) != 1 ||
		rd.Guilds[0].ID != "10" || len(rd.Guilds[0].Channels) != 2 {
		t.Fatalf("READY = %s (%v)", ready.D, err)
	}

	r.msg(10, 100, "m1")
	r.msg(10, 101, "m2")
	fa, fb := a.expectEvent("MESSAGE_CREATE"), b.expectEvent("MESSAGE_CREATE")
	if seqOf(fa) != 2 || seqOf(fb) != 2 {
		t.Fatalf("s = %d / %d, esperado 2", seqOf(fa), seqOf(fb))
	}
	if seqOf(a.expectEvent("MESSAGE_CREATE")) != 3 {
		t.Fatal("s deve crescer de 1 em 1")
	}
}

func TestHeartbeatAck(t *testing.T) {
	r := newRig(t, fastCfg())
	c := r.dial("tok-1")
	c.identify()
	for i := 0; i < 3; i++ {
		c.send(OpHeartbeat, nil)
		if f := c.mustRead(); f.Op != OpAck {
			t.Fatalf("esperava ACK, veio %+v", f)
		}
		time.Sleep(150 * time.Millisecond) // total > 1,5× o intervalo: só sobrevive por causa dos heartbeats
	}
}

func TestMissingHeartbeatCloses4009(t *testing.T) {
	r := newRig(t, fastCfg())
	c := r.dial("tok-1")
	c.identify()
	c.expectClose(CloseHeartbeatTimeout, 2*time.Second)
}

func TestIdentifyTimeoutCloses4006(t *testing.T) {
	r := newRig(t, fastCfg())
	c := r.dial("tok-1")
	if f := c.mustRead(); f.Op != OpHello {
		t.Fatal("esperava HELLO")
	}
	c.expectClose(CloseIdentifyTimeout, 2*time.Second)
}

func TestOpBeforeIdentifyCloses4003(t *testing.T) {
	r := newRig(t, fastCfg())
	c := r.dial("tok-1")
	c.mustRead()
	c.send(Op(77), nil)
	c.expectClose(CloseNotIdentified, 2*time.Second)
}

func TestOpsRateLimit(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	cfg.OpsPerMinute = 5
	r := newRig(t, cfg)
	c := r.dial("tok-1")
	c.identify()
	for i := 0; i < 20; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := c.ws.Write(ctx, websocket.MessageText, []byte(`{"op":1,"d":null}`))
		cancel()
		if err != nil {
			break
		}
	}
	c.expectClose(CloseRateLimited, 3*time.Second)
}

func TestResumeReplaysMissedEventsInOrder(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	cfg.ResumeWindow = 5 * time.Second
	r := newRig(t, cfg)
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 1, perm.DefaultEveryone)

	a := r.dial("tok-1")
	sid, _ := a.identify()
	r.msg(10, 100, "m1")
	if f := a.expectEvent("MESSAGE_CREATE"); seqOf(f) != 2 {
		t.Fatal("s esperado 2")
	}
	_ = a.ws.CloseNow() // queda abrupta
	waitFor(t, func() bool { return r.hubDetached() == 1 })

	r.msg(10, 100, "m2")
	r.msg(10, 100, "m3")

	b := r.dial("tok-1")
	if h := b.mustRead(); h.Op != OpHello {
		t.Fatal("esperava HELLO")
	}
	b.send(OpResume, Resume{SessionID: sid, Seq: 2})
	f3, f4 := b.mustRead(), b.mustRead()
	if seqOf(f3) != 3 || seqOf(f4) != 4 || !strings.Contains(string(f3.D), "m2") || !strings.Contains(string(f4.D), "m3") {
		t.Fatalf("replay fora de ordem: %s / %s", f3.D, f4.D)
	}
	res := b.mustRead()
	if res.T == nil || *res.T != EventResumed || res.S != nil {
		t.Fatalf("esperava RESUMED depois do replay, veio %+v", res)
	}
	// eventos novos continuam chegando, sem duplicar o que já veio
	r.msg(10, 100, "m4")
	if f := b.expectEvent("MESSAGE_CREATE"); seqOf(f) != 5 || !strings.Contains(string(f.D), "m4") {
		t.Fatalf("depois do resume: %+v", f)
	}
}

func TestResumeWithNothingMissed(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	cfg.ResumeWindow = 5 * time.Second
	r := newRig(t, cfg)
	a := r.dial("tok-1")
	sid, _ := a.identify()
	_ = a.ws.CloseNow()
	waitFor(t, func() bool { return r.hubDetached() == 1 })
	b := r.dial("tok-1")
	b.mustRead()
	b.send(OpResume, Resume{SessionID: sid, Seq: 1})
	if f := b.mustRead(); f.T == nil || *f.T != EventResumed {
		t.Fatalf("esperava RESUMED, veio %+v", f)
	}
}

func TestResumeInvalidSession(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	cfg.ResumeWindow = 300 * time.Millisecond
	cfg.BufferSize = 4
	cfg.SendQueue = 4
	r := newRig(t, cfg)
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 1, perm.DefaultEveryone)
	r.dir.setPerm(10, 2, perm.DefaultEveryone)

	// sessão desconhecida
	c := r.dial("tok-1")
	c.mustRead()
	c.send(OpResume, Resume{SessionID: "nao-existe", Seq: 5})
	if f := c.mustRead(); f.Op != OpInvalidSession {
		t.Fatalf("esperava op 9, veio %+v", f)
	}
	// e o cliente faz IDENTIFY de novo na mesma conexão
	c.send(OpIdentify, Identify{})
	if f := c.mustRead(); f.T == nil || *f.T != EventReady {
		t.Fatalf("esperava READY depois do op 9, veio %+v", f)
	}

	// sessão de outro usuário não pode ser retomada
	other := r.dial("tok-2")
	sid2, _ := other.identify()
	_ = other.ws.CloseNow()
	hijack := r.dial("tok-1")
	hijack.mustRead()
	hijack.send(OpResume, Resume{SessionID: sid2, Seq: 1})
	if f := hijack.mustRead(); f.Op != OpInvalidSession {
		t.Fatalf("resume de sessão alheia deveria dar op 9, veio %+v", f)
	}

	// buffer não cobre: 10 eventos com buffer de 4
	a := r.dial("tok-1")
	sid, _ := a.identify()
	_ = a.ws.CloseNow()
	waitFor(t, func() bool { return r.hubDetached() >= 1 })
	for i := 0; i < 10; i++ {
		r.msg(10, 100, strconv.Itoa(i))
	}
	waitFor(t, func() bool { return r.bufferLen(sid) == 4 })
	b := r.dial("tok-1")
	b.mustRead()
	b.send(OpResume, Resume{SessionID: sid, Seq: 1})
	if f := b.mustRead(); f.Op != OpInvalidSession {
		t.Fatalf("buffer insuficiente deveria dar op 9, veio %+v", f)
	}

	// sessão expirada (janela de 300 ms)
	d := r.dial("tok-1")
	sid3, _ := d.identify()
	_ = d.ws.CloseNow()
	waitFor(t, func() bool { return r.hub.lookup(sid3) == nil })
	e := r.dial("tok-1")
	e.mustRead()
	e.send(OpResume, Resume{SessionID: sid3, Seq: 1})
	if f := e.mustRead(); f.Op != OpInvalidSession {
		t.Fatalf("sessão expirada deveria dar op 9, veio %+v", f)
	}
}

func TestSessionTakenOverByResume(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	r := newRig(t, cfg)
	a := r.dial("tok-1")
	sid, _ := a.identify()
	b := r.dial("tok-1")
	b.mustRead()
	b.send(OpResume, Resume{SessionID: sid, Seq: 1})
	a.expectClose(CloseSessionTakenOver, 2*time.Second)
	if f := b.mustRead(); f.T == nil || *f.T != EventResumed {
		t.Fatalf("esperava RESUMED, veio %+v", f)
	}
}

func TestNoViewChannelNoEvents(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	r := newRig(t, cfg)
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 1, perm.DefaultEveryone)
	r.dir.setPerm(10, 2, perm.DefaultEveryone&^perm.ViewChannel) // membro sem VIEW_CHANNEL

	seeing, blind := r.dial("tok-1"), r.dial("tok-2")
	seeing.identify()
	_, ready := blind.identify()
	var rd struct {
		Guilds []struct {
			Channels []any `json:"channels"`
		} `json:"guilds"`
	}
	_ = json.Unmarshal(ready.D, &rd)
	if len(rd.Guilds) != 1 || len(rd.Guilds[0].Channels) != 0 {
		t.Fatalf("sem VIEW_CHANNEL o READY não pode trazer canais: %s", ready.D)
	}

	r.msg(10, 100, "segredo")
	r.bus.Publish(events.Event{Type: events.ChannelCreate, GuildID: 10, ChannelID: 101, Topics: []string{guildTopic(10)}, Data: map[string]string{"id": "101"}})
	seeing.expectEvent("MESSAGE_CREATE")
	seeing.expectEvent("CHANNEL_CREATE")
	blind.expectNone(300 * time.Millisecond)

	// evento de servidor (sem canal) chega a todos
	r.bus.Publish(events.Event{Type: events.GuildUpdate, GuildID: 10, Topics: []string{guildTopic(10)}, Data: map[string]string{"id": "10"}})
	seeing.expectEvent("GUILD_UPDATE")
	blind.expectEvent("GUILD_UPDATE")
}

func TestLosingViewChannelMidSession(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	r := newRig(t, cfg)
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 1, perm.DefaultEveryone)
	r.dir.setPerm(10, 2, perm.DefaultEveryone)
	admin, member := r.dial("tok-1"), r.dial("tok-2")
	admin.identify()
	member.identify()

	r.msg(10, 100, "antes")
	member.expectEvent("MESSAGE_CREATE")
	admin.expectEvent("MESSAGE_CREATE")

	// o cargo é removido: o usuário 2 perde VIEW_CHANNEL
	r.dir.setPerm(10, 2, perm.DefaultEveryone&^perm.ViewChannel)
	r.bus.Publish(events.Event{Type: events.GuildMemberUpdate, GuildID: 10, Topics: []string{guildTopic(10)}, Data: map[string]string{"guild_id": "10", "user_id": "2"}})
	member.expectEvent("GUILD_MEMBER_UPDATE")
	admin.expectEvent("GUILD_MEMBER_UPDATE")

	r.msg(10, 100, "depois")
	admin.expectEvent("MESSAGE_CREATE")
	member.expectNone(300 * time.Millisecond)

	// recupera (via mudança do cargo @everyone): volta a receber
	r.dir.setPerm(10, 2, perm.DefaultEveryone)
	r.bus.Publish(events.Event{Type: events.RoleUpdate, GuildID: 10, Topics: []string{guildTopic(10)}, Data: map[string]string{"id": "10"}})
	member.expectEvent("ROLE_UPDATE")
	r.msg(10, 100, "de novo")
	member.expectEvent("MESSAGE_CREATE")
}

func TestKickAndGuildLifecycle(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	r := newRig(t, cfg)
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 2, perm.DefaultEveryone)
	m := r.dial("tok-2")
	m.identify()

	// expulso: recebe o GUILD_DELETE pelo tópico do usuário e sai dos tópicos do servidor
	r.dir.kick(10, 2)
	r.bus.Publish(events.Event{Type: events.GuildDelete, GuildID: 10, Topics: []string{userTopic(2)}, Data: map[string]string{"id": "10"}})
	m.expectEvent("GUILD_DELETE")
	r.msg(10, 100, "x")
	r.bus.Publish(events.Event{Type: events.GuildUpdate, GuildID: 10, Topics: []string{guildTopic(10)}, Data: map[string]string{"id": "10"}})
	m.expectNone(300 * time.Millisecond)

	// entra num servidor novo: GUILD_CREATE (tópico do usuário) assina o servidor e os canais
	r.bus.Publish(events.Event{Type: events.GuildCreate, GuildID: 20, Topics: []string{userTopic(2)}, Data: map[string]any{
		"id": "20", "permissions": int64(perm.DefaultEveryone), "is_owner": false,
		"channels": []map[string]string{{"id": "200"}},
	}})
	m.expectEvent("GUILD_CREATE")
	r.msg(20, 200, "oi")
	m.expectEvent("MESSAGE_CREATE")

	// canal novo é assinado; canal excluído deixa de ser
	r.bus.Publish(events.Event{Type: events.ChannelCreate, GuildID: 20, ChannelID: 201, Topics: []string{guildTopic(20)}, Data: map[string]string{"id": "201"}})
	m.expectEvent("CHANNEL_CREATE")
	r.msg(20, 201, "no novo")
	m.expectEvent("MESSAGE_CREATE")
	r.bus.Publish(events.Event{Type: events.ChannelDelete, GuildID: 20, ChannelID: 201, Topics: []string{guildTopic(20)}, Data: map[string]string{"id": "201"}})
	m.expectEvent("CHANNEL_DELETE")
	r.msg(20, 201, "fantasma")
	m.expectNone(200 * time.Millisecond)

	// servidor excluído: evento chega pelo tópico do servidor e a sessão o abandona
	r.bus.Publish(events.Event{Type: events.GuildDelete, GuildID: 20, Topics: []string{guildTopic(20)}, Data: map[string]string{"id": "20"}})
	m.expectEvent("GUILD_DELETE")
	r.msg(20, 200, "depois de excluir")
	m.expectNone(200 * time.Millisecond)
}

func TestOtherConnectionsUnaffectedByDrop(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	r := newRig(t, cfg)
	r.dir.channels[10] = []int64{100}
	for u := int64(1); u <= 3; u++ {
		r.dir.setPerm(10, u, perm.DefaultEveryone)
	}
	a, b, c := r.dial("tok-1"), r.dial("tok-2"), r.dial("tok-3")
	a.identify()
	b.identify()
	c.identify()
	_ = a.ws.CloseNow()
	waitFor(t, func() bool { return r.hubDetached() == 1 })
	r.msg(10, 100, "m")
	b.expectEvent("MESSAGE_CREATE")
	c.expectEvent("MESSAGE_CREATE")
}

func TestSlowConsumerIsCutAndSessionKept(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = time.Minute
	cfg.ResumeWindow = time.Minute
	cfg.SendQueue = 64
	cfg.BufferSize = 256
	cfg.WriteTimeout = 3 * time.Second
	r := newRig(t, cfg)
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 1, perm.DefaultEveryone)
	r.dir.setPerm(10, 2, perm.DefaultEveryone)

	healthy := r.dial("tok-2")
	healthy.identify()
	slowWS, _, err := r.dialErr(http.Header{"Authorization": {"Bearer tok-1"}}, "")
	if err != nil {
		t.Fatal(err)
	}
	slow := newClient(t, slowWS, false) // lê HELLO e READY à mão e depois para de ler
	var slowSID string
	for i := 0; i < 2; i++ {
		_, b, err := slowWS.Read(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			slow.send(OpIdentify, Identify{})
			continue
		}
		var f Frame
		_ = json.Unmarshal(b, &f)
		var rd Resumed // só precisamos do session_id
		_ = json.Unmarshal(f.D, &rd)
		slowSID = rd.SessionID
	}

	// payloads grandes e o cliente lento sem ler: os buffers do TCP enchem e o escritor trava
	big := strings.Repeat("x", 32<<10)
	var got atomicCount
	done := make(chan struct{})
	go func() { // o cliente saudável consome tudo
		defer close(done)
		for got.n() < 800 {
			f, err := healthy.read(10 * time.Second)
			if err != nil {
				t.Logf("healthy read: %v", err)
				return
			}
			if f.Op == OpDispatch && *f.T == "MESSAGE_CREATE" {
				got.inc()
			}
		}
	}()
	for i := 0; i < 800; i++ {
		r.bus.Publish(events.Event{Type: events.MessageCreate, GuildID: 10, ChannelID: 100,
			Topics: []string{channelTopic(100)}, Data: map[string]string{"id": strconv.Itoa(i), "pad": big}})
		time.Sleep(4 * time.Millisecond)
	}
	<-done
	if got.n() != 800 {
		t.Fatalf("o consumidor saudável recebeu %d/800: o lento não pode afetá-lo", got.n())
	}
	waitFor(t, func() bool {
		s := r.hub.lookup(slowSID)
		return s != nil && s.isDetached()
	})
	if r.hub.lookup(slowSID) == nil {
		t.Fatal("a sessão do consumidor lento deve ser mantida para o resume")
	}
	if r.hub.met.slowN.Load() == 0 {
		t.Fatal("o corte deveria ter sido por consumidor lento (4008)")
	}
	// sem goroutine presa: o shutdown termina rápido
	sctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := r.hub.Shutdown(sctx); err != nil {
		t.Fatalf("shutdown travou: %v", err)
	}
}

type atomicCount struct {
	mu sync.Mutex
	v  int
}

func (a *atomicCount) inc() { a.mu.Lock(); a.v++; a.mu.Unlock() }
func (a *atomicCount) n() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.v
}

func TestGracefulShutdownCloses1001(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = time.Minute
	r := newRig(t, cfg)
	a, b := r.dial("tok-1"), r.dial("tok-2")
	a.identify()
	b.identify()
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- r.hub.Shutdown(sctx) }()
	a.expectClose(CloseGoingAway, 2*time.Second)
	b.expectClose(CloseGoingAway, 2*time.Second)
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.dialErr(http.Header{"Authorization": {"Bearer tok-1"}}, ""); err == nil {
		t.Fatal("depois do shutdown não deve aceitar conexões")
	}
}

func TestSessionLimitPerUser(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = time.Minute
	r := newRig(t, cfg)
	var last *client
	for i := 0; i < maxSessionsPerUser; i++ {
		c := r.dial("tok-1")
		c.identify()
		last = c
	}
	// todas com socket: a próxima é recusada
	extra := r.dial("tok-1")
	extra.mustRead()
	extra.send(OpIdentify, Identify{})
	extra.expectClose(CloseRateLimited, 2*time.Second)
	// liberando uma (fica sem socket), a próxima entra no lugar dela
	_ = last.ws.CloseNow()
	waitFor(t, func() bool { return r.hubDetached() == 1 })
	ok := r.dial("tok-1")
	ok.identify()
	if st := r.hub.Stats(); st.Sessions != maxSessionsPerUser {
		t.Fatalf("sessões = %d", st.Sessions)
	}
}

func TestBadFrameCloses4000(t *testing.T) {
	r := newRig(t, fastCfg())
	c := r.dial("tok-1")
	c.mustRead()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = c.ws.Write(ctx, websocket.MessageText, []byte("{não é json"))
	c.expectClose(CloseUnknown, 2*time.Second)
}

func TestErrNotMemberDropsGuildOnRefresh(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = time.Minute
	r := newRig(t, cfg)
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 2, perm.DefaultEveryone)
	m := r.dial("tok-2")
	m.identify()
	r.dir.kick(10, 2)
	r.bus.Publish(events.Event{Type: events.RoleUpdate, GuildID: 10, Topics: []string{guildTopic(10)}, Data: map[string]string{"id": "10"}})
	m.expectEvent("ROLE_UPDATE")
	r.msg(10, 100, "x")
	m.expectNone(200 * time.Millisecond)
}

// ---- utilidades ----

func (r *rig) hubDetached() int {
	r.hub.mu.RLock()
	defer r.hub.mu.RUnlock()
	n := 0
	for _, s := range r.hub.sessions {
		if s.isDetached() {
			n++
		}
	}
	return n
}

func (r *rig) bufferLen(id string) int {
	s := r.hub.lookup(id)
	if s == nil {
		return -1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.len()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condição não atingida a tempo")
}
