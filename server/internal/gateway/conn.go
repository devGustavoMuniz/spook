package gateway

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/time/rate"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

// maxFrameBytes é o maior frame aceito do cliente (IDENTIFY, RESUME e heartbeat são minúsculos).
const maxFrameBytes = 4096

// conn é uma conexão WebSocket autenticada. Uma goroutine lê (serve) e outra escreve (writeLoop).
type conn struct {
	hub    *Hub
	ws     *websocket.Conn
	userID int64
	ctx    context.Context
	cancel context.CancelFunc

	sess       *Session // só a goroutine de leitura escreve
	identified atomic.Bool
	wake       chan struct{}
	sent       atomic.Int64 // último s escrito no socket
	replaying  atomic.Bool  // reenviando eventos de um resume
	resumeFrom int64
	resumeUpTo int64

	watchdog  *time.Timer
	limiter   *rate.Limiter
	closeOnce sync.Once
}

func (h *Hub) newConn(ctx context.Context, ws *websocket.Conn, userID int64) *conn {
	ctx, cancel := context.WithCancel(ctx)
	ops := h.cfg.OpsPerMinute
	c := &conn{
		hub: h, ws: ws, userID: userID, ctx: ctx, cancel: cancel,
		wake:    make(chan struct{}, 1),
		limiter: rate.NewLimiter(rate.Limit(float64(ops)/60), ops),
	}
	ws.SetReadLimit(maxFrameBytes)
	return c
}

func (c *conn) wakeUp() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// closeAsync fecha com o código dado sem bloquear quem chama (o fechamento espera o par por até 5 s).
func (c *conn) closeAsync(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		go func() {
			_ = c.ws.Close(code, reason)
			c.cancel()
		}()
	})
}

// fail fecha de forma síncrona; só a goroutine de leitura pode usar (o fechamento espera o par).
func (c *conn) fail(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		_ = c.ws.Close(code, reason)
		c.cancel()
	})
}

// armWatchdog (re)inicia o prazo: IDENTIFY em 10 s antes de identificar; depois, o heartbeat
// dentro de 1,5× o intervalo.
func (c *conn) armWatchdog(d time.Duration) {
	if c.watchdog == nil {
		c.watchdog = time.AfterFunc(d, c.onWatchdog)
		return
	}
	c.watchdog.Reset(d)
}

func (c *conn) onWatchdog() {
	if c.identified.Load() {
		c.closeAsync(CloseHeartbeatTimeout, "sem heartbeat")
	} else {
		c.closeAsync(CloseIdentifyTimeout, "sem identify")
	}
}

func (c *conn) writeRaw(p []byte) error {
	ctx, cancel := context.WithTimeout(c.ctx, c.hub.cfg.WriteTimeout)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, p)
}

func (c *conn) writeControl(op Op, t string, d any) error {
	f := Frame{Op: op}
	if t != "" {
		f.T = &t
	}
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	f.D = b
	out, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return c.writeRaw(out)
}

// appendDispatch monta `{"op":0,"t":"X","s":N,"d":<payload>}` sem reserializar o payload.
func appendDispatch(b []byte, e event) []byte {
	b = append(b, `{"op":0,"t":`...)
	b = strconv.AppendQuote(b, e.T)
	b = append(b, `,"s":`...)
	b = strconv.AppendInt(b, e.Seq, 10)
	b = append(b, `,"d":`...)
	b = append(b, e.D...)
	return append(b, '}')
}

// serve roda a conexão até ela terminar. Bloqueia.
func (c *conn) serve(parent context.Context) {
	h := c.hub
	ctx, span := tracer.Start(parent, "gateway.connection", trace.WithAttributes(attribute.Int64("user.id", c.userID)))
	defer span.End()
	defer c.cancel()
	defer func() {
		if c.watchdog != nil {
			c.watchdog.Stop()
		}
		if c.sess != nil {
			c.sess.detach(c)
		}
		_ = c.ws.CloseNow()
	}()

	c.armWatchdog(h.cfg.IdentifyTimeout)
	hello := Hello{HeartbeatInterval: h.cfg.HeartbeatInterval.Milliseconds()}
	if err := c.writeControl(OpHello, "", hello); err != nil {
		return
	}

	for {
		_, data, err := c.ws.Read(c.ctx)
		if err != nil {
			if st := websocket.CloseStatus(err); st != -1 {
				span.SetAttributes(attribute.Int("close.code", int(st)))
			}
			return
		}
		if !c.limiter.Allow() {
			c.fail(CloseRateLimited, "muitas operações")
			return
		}
		var f Frame
		if err := json.Unmarshal(data, &f); err != nil {
			c.fail(CloseUnknown, "frame inválido")
			return
		}
		switch f.Op {
		case OpHeartbeat:
			if c.identified.Load() {
				c.armWatchdog(h.cfg.heartbeatTimeout())
			}
			if err := c.writeControl(OpAck, "", nil); err != nil {
				return
			}
		case OpIdentify:
			if c.sess != nil {
				c.fail(CloseAlreadyIdent, "já identificado")
				return
			}
			if !c.identify(ctx, f.D) {
				return
			}
		case OpResume:
			if c.sess != nil {
				c.fail(CloseAlreadyIdent, "já identificado")
				return
			}
			if !c.resume(ctx, f.D) {
				return
			}
		case OpPresence:
			if c.sess == nil {
				c.fail(CloseNotIdentified, "identifique-se primeiro")
				return
			}
			if !c.setPresence(f.D) {
				return
			}
		default:
			if c.sess == nil {
				c.fail(CloseNotIdentified, "identifique-se primeiro")
			} else {
				c.fail(CloseInvalidOp, "op inválido")
			}
			return
		}
	}
}

// identify abre uma sessão nova: READY (s=1) com os servidores do usuário e assina os tópicos.
func (c *conn) identify(ctx context.Context, d json.RawMessage) (ok bool) {
	h := c.hub
	start := time.Now()
	ctx, span := tracer.Start(ctx, "gateway.identify")
	defer span.End()
	if len(d) > 0 && string(d) != "null" {
		var id Identify
		if err := json.Unmarshal(d, &id); err != nil {
			c.fail(CloseUnknown, "identify inválido")
			return false
		}
	}

	details, err := h.dir.List(ctx, c.userID)
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		slog.Error("gateway: falha ao montar o READY", "user", c.userID, "err", err)
		c.fail(websocket.StatusInternalError, "erro interno")
		return false
	}
	var dmList []channel.Channel
	if h.dms != nil {
		if dmList, err = h.dms.List(ctx, c.userID); err != nil {
			span.SetStatus(codes.Error, err.Error())
			slog.Error("gateway: falha ao listar as DMs para o READY", "user", c.userID, "err", err)
			c.fail(websocket.StatusInternalError, "erro interno")
			return false
		}
	}
	presences := []presence.UpdatePayload{}
	if h.pres != nil {
		// A presença é complementar: se falhar, o READY sai sem o snapshot (os eventos seguem valendo).
		if p, perr := h.pres.Snapshot(ctx, c.userID); perr != nil {
			slog.Warn("gateway: snapshot de presença indisponível", "user", c.userID, "err", perr)
		} else if p != nil {
			presences = p
		}
	}
	s, okReg := h.register(c.userID)
	if !okReg {
		c.fail(CloseRateLimited, "muitas sessões")
		return false
	}

	voiceStates := []voice.StatePayload{}
	if h.voice != nil {
		visible := make([]int64, 0, len(details))
		for _, g := range details {
			if g.Member.Has(perm.ViewChannel) {
				visible = append(visible, g.Guild.ID)
			}
		}
		dmIDs := make([]int64, len(dmList))
		for i, d := range dmList {
			dmIDs[i] = d.ID
		}
		if v := h.voice.Snapshot(visible, dmIDs); v != nil {
			voiceStates = v
		}
	}

	payloads := make([]guild.DetailPayload, len(details))
	for i, g := range details {
		payloads[i] = g.Payload()
	}
	ready, err := json.Marshal(Ready{
		SessionID: s.id, User: ReadyUser{ID: strconv.FormatInt(c.userID, 10)}, Guilds: payloads,
		PrivateChannels: channel.Payloads(dmList), Presences: presences, VoiceStates: voiceStates,
	})
	if err != nil {
		h.dropSession(s)
		c.fail(websocket.StatusInternalError, "erro interno")
		return false
	}

	c.sess = s
	s.attach(c)
	c.identified.Store(true)
	c.armWatchdog(h.cfg.heartbeatTimeout())
	go c.writeLoop(s)
	s.push(EventReady, ready, time.Now()) // s=1: sempre o primeiro dispatch

	// Só agora assina: nenhum evento pode ser numerado antes do READY.
	s.subscribeUser()
	for _, g := range details {
		ids := make([]int64, len(g.Channels))
		for i, ch := range g.Channels {
			ids[i] = ch.ID
		}
		s.setGuild(g.Guild.ID, g.Member.Has(perm.ViewChannel), ids)
	}
	for _, d := range dmList {
		s.dmAdded(d.ID)
	}
	h.met.identifyTime.Record(ctx, time.Since(start).Seconds())
	return true
}

// setPresence trata o op 12: valida o status e avisa a presença (idle por sessão). Sem presença
// ligada, o op é aceito e ignorado.
func (c *conn) setPresence(d json.RawMessage) bool {
	var p SetPresence
	if err := json.Unmarshal(d, &p); err != nil || (p.Status != presence.StatusOnline && p.Status != presence.StatusIdle) {
		c.fail(CloseUnknown, "status de presença inválido")
		return false
	}
	if c.hub.pres != nil {
		c.hub.pres.SetIdle(c.userID, c.sess.id, p.Status == presence.StatusIdle)
	}
	return true
}

// resume tenta retomar a sessão; se não der, manda op 9 e espera um IDENTIFY na mesma conexão.
func (c *conn) resume(ctx context.Context, d json.RawMessage) (ok bool) {
	h := c.hub
	ctx, span := tracer.Start(ctx, "gateway.resume")
	defer span.End()
	var r Resume
	if err := json.Unmarshal(d, &r); err != nil {
		c.fail(CloseUnknown, "resume inválido")
		return false
	}
	s := h.lookup(r.SessionID)
	var old *conn
	var upTo int64
	resumed := false
	if s != nil && s.userID == c.userID {
		c.resumeFrom = r.Seq
		c.sent.Store(r.Seq)
		old, upTo, resumed = s.tryResume(c, r.Seq)
	}
	if !resumed {
		h.met.invalid.Add(ctx, 1)
		span.SetAttributes(attribute.Bool("resumed", false))
		if err := c.writeControl(OpInvalidSession, "", false); err != nil {
			return false
		}
		c.armWatchdog(h.cfg.IdentifyTimeout) // o cliente precisa mandar IDENTIFY
		return true
	}
	if old != nil {
		old.closeAsync(CloseSessionTakenOver, "sessão retomada em outra conexão")
	}
	h.met.resumes.Add(ctx, 1)
	span.SetAttributes(attribute.Bool("resumed", true), attribute.Int64("replayed", upTo-r.Seq))
	c.sess = s
	c.resumeUpTo = upTo
	c.replaying.Store(true)
	c.identified.Store(true)
	c.armWatchdog(h.cfg.heartbeatTimeout())
	go c.writeLoop(s)
	c.wakeUp()
	return true
}

// writeLoop envia os eventos da sessão em ordem. Lê direto do buffer da sessão, então o "limite da
// fila de envio" é a distância entre o último s numerado e o último escrito (ver Session.push).
func (c *conn) writeLoop(s *Session) {
	h := c.hub
	var buf []byte
	for {
		for {
			evs, _, ok := s.pending(c, c.sent.Load())
			if !ok { // o consumidor ficou além do que o buffer guarda
				h.met.slowClose()
				c.closeAsync(CloseSlowConsumer, "consumidor lento")
				return
			}
			if c.replaying.Load() && c.sent.Load() >= c.resumeUpTo {
				if !c.finishResume(s) {
					return
				}
			}
			if len(evs) == 0 {
				break
			}
			for _, e := range evs {
				buf = appendDispatch(buf[:0], e)
				if err := c.writeRaw(buf); err != nil {
					c.cancel()
					return
				}
				c.sent.Store(e.Seq)
				h.met.observeLatency(c.ctx, e.At, e.T)
				if c.replaying.Load() && e.Seq >= c.resumeUpTo {
					if !c.finishResume(s) {
						return
					}
				}
			}
		}
		select {
		case <-c.wake:
		case <-c.ctx.Done():
			return
		}
	}
}

// finishResume manda o RESUMED depois de reenviar tudo que faltava.
func (c *conn) finishResume(s *Session) bool {
	if !c.replaying.CompareAndSwap(true, false) {
		return true
	}
	// RESUMED não consome sequência (s = null): o cliente segue com o último s que viu.
	err := c.writeControl(OpDispatch, EventResumed, Resumed{SessionID: s.id, Replayed: int(c.resumeUpTo - c.resumeFrom)})
	if err != nil {
		c.cancel()
		return false
	}
	return true
}
