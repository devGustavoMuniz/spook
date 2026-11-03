package voice

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

var tracer = otel.Tracer("spook/voice")

// lockStripes é o número de travas por usuário (as transições de um mesmo usuário são serializadas).
const lockStripes = 64

// remoteTimeout limita cada chamada administrativa ao LiveKit.
const remoteTimeout = 5 * time.Second

// Deps reúne as dependências do Service. Provider nulo desliga a voz (endpoints respondem 503).
type Deps struct {
	Provider Provider
	Store    StateStore
	Previews PreviewStore // opcional: nulo desliga a prévia da transmissão
	Access   Access
	Users    Users
	Pub      events.Publisher
	Audit    Auditor          // opcional
	Now      func() time.Time // opcional (testes)
}

// Service são os casos de uso da voz.
type Service struct {
	prov     Provider
	store    StateStore
	previews PreviewStore
	access   Access
	users    Users
	pub      events.Publisher
	audit    Auditor
	now      func() time.Time

	locks [lockStripes]sync.Mutex

	rateMu  sync.Mutex
	lastPut map[int64]time.Time // último envio de prévia por usuário (limite de frequência)
	seen    *dedupe
	met     *metrics
}

func NewService(d Deps) *Service {
	s := &Service{
		prov: d.Provider, store: d.Store, previews: d.Previews, access: d.Access, users: d.Users, pub: d.Pub, audit: d.Audit, now: d.Now,
		seen: newDedupe(2048), lastPut: map[int64]time.Time{},
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.pub == nil {
		s.pub = events.Discard{}
	}
	s.met = newMetrics(s.store, s.previews)
	return s
}

// Enabled diz se o LiveKit está configurado.
func (s *Service) Enabled() bool { return s.prov != nil }

func (s *Service) lock(userID int64) func() {
	mu := &s.locks[uint64(userID)%lockStripes]
	mu.Lock()
	return mu.Unlock
}

func remote(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, remoteTimeout)
}

// denied diz se o erro é "sem acesso" (404/403), em oposição a falhas de infraestrutura.
func denied(err error) bool {
	return apperr.IsKind(err, apperr.KindNotFound) || apperr.IsKind(err, apperr.KindForbidden)
}

func (s *Service) publish(st State, left bool) {
	p := st.Payload()
	if left {
		p = leftPayload(st)
	}
	ev := events.Event{Type: events.VoiceStateUpdate, GuildID: st.GuildID, ChannelID: st.ChannelID, Data: p}
	if st.GuildID != 0 {
		ev.Topics = []string{"guild:" + httpx.ID(st.GuildID)}
	} else {
		ev.Topics = []string{"channel:" + httpx.ID(st.ChannelID)}
	}
	s.pub.Publish(ev)
}

// kick tira o participante da sala no LiveKit; falha só é registrada (a regra de uma sala por
// usuário e o reconciliador cobrem o resto).
func (s *Service) kick(ctx context.Context, channelID, userID int64) {
	rctx, cancel := remote(ctx)
	defer cancel()
	if err := s.prov.RemoveParticipant(rctx, roomName(channelID), identity(userID)); err != nil {
		slog.Warn("voice: não foi possível remover o participante da sala", "channel", channelID, "user", userID, "err", err)
	}
}

// dropLocked remove o estado de st (já com a trava do usuário), opcionalmente expulsando do LiveKit,
// e publica a saída.
func (s *Service) dropLocked(ctx context.Context, st State, kick bool) {
	if kick {
		s.kick(ctx, st.ChannelID, st.UserID)
	}
	s.store.Delete(st.UserID)
	if s.previews != nil {
		s.previews.Delete(st.UserID)
	}
	s.publish(st, true)
}

// ---- token ----

// IssueToken emite o token de entrada no canal (RNF04) e aplica a regra 7.7: se o usuário estava
// em outro canal, ele sai de lá antes.
func (s *Service) IssueToken(ctx context.Context, userID, channelID int64) (resp TokenResponse, err error) {
	if !s.Enabled() {
		return TokenResponse{}, ErrDisabled
	}
	ctx, span := tracer.Start(ctx, "voice.IssueToken", trace.WithAttributes(attribute.Int64("channel.id", channelID)))
	start := time.Now()
	defer func() {
		s.met.tokenTime.Record(ctx, time.Since(start).Seconds())
		if err != nil {
			reason := "error"
			switch {
			case apperr.IsKind(err, apperr.KindNotFound):
				reason = "not_found"
			case apperr.IsKind(err, apperr.KindForbidden):
				reason = "forbidden"
			case apperr.IsKind(err, apperr.KindInvalid):
				reason = "invalid_channel"
			}
			s.met.tokensDenied.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", reason)))
			if reason == "error" {
				span.SetStatus(codes.Error, err.Error())
			}
		}
		span.End()
	}()

	acc, err := s.access.Channel(ctx, userID, channelID)
	if err != nil {
		return TokenResponse{}, err
	}
	if !acc.Voiceable() {
		return TokenResponse{}, ErrNotVoiceChannel
	}
	if !acc.CanConnect {
		return TokenResponse{}, apperr.Forbidden("você não tem permissão para entrar neste canal de voz")
	}
	name, err := s.users.Username(ctx, userID)
	if err != nil {
		return TokenResponse{}, err
	}

	unlock := s.lock(userID)
	next := Pending{UserID: userID, ChannelID: channelID, GuildID: acc.GuildID, ExpiresAt: s.now().Add(PendingTTL)}
	if cur, ok := s.store.Get(userID); ok {
		next.SelfMute, next.SelfDeaf = cur.SelfMute, cur.SelfDeaf // mute/deaf acompanham a troca de canal
	} else if p, ok := s.store.GetPending(userID, s.now()); ok {
		next.SelfMute, next.SelfDeaf = p.SelfMute, p.SelfDeaf
	}
	s.leaveOtherLocked(ctx, userID, channelID)
	s.store.SetPending(next)
	unlock()

	token, err := s.prov.IssueToken(TokenRequest{
		Room: roomName(channelID), Identity: identity(userID), Name: name, TTL: TokenTTL,
		Grants: grantsFor(acc),
	})
	if err != nil {
		return TokenResponse{}, err
	}
	s.met.tokensIssued.Add(ctx, 1, metric.WithAttributes(attribute.String("kind", acc.Kind())))
	return TokenResponse{URL: s.prov.PublicURL(), Token: token, ExpiresIn: int(TokenTTL / time.Second)}, nil
}

func grantsFor(acc ChannelAccess) Grants {
	if acc.GuildID == 0 {
		return GrantsFor(true, true) // DM: todos têm as quatro origens
	}
	return GrantsFor(acc.CanSpeak && !acc.ServerMuted, acc.CanVideo)
}

// leaveOtherLocked tira o usuário do canal em que estiver (ou for entrar), se for outro que
// channelID. Com a trava do usuário.
func (s *Service) leaveOtherLocked(ctx context.Context, userID, channelID int64) {
	if cur, ok := s.store.Get(userID); ok && cur.ChannelID != channelID {
		s.dropLocked(ctx, cur, true)
	}
	// Token emitido e ainda sem webhook: o usuário pode já estar conectado na sala antiga.
	if p, ok := s.store.GetPending(userID, s.now()); ok && p.ChannelID != channelID {
		s.kick(ctx, p.ChannelID, userID)
	}
}

// ---- sair, mute/deaf, snapshots ----

// Leave tira o usuário da sala atual. Idempotente.
func (s *Service) Leave(ctx context.Context, userID int64) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	ctx, span := tracer.Start(ctx, "voice.Leave")
	defer span.End()
	defer s.lock(userID)()
	if p, ok := s.store.GetPending(userID, s.now()); ok {
		s.store.ClearPending(userID)
		if _, joined := s.store.Get(userID); !joined {
			s.kick(ctx, p.ChannelID, userID) // pode estar conectado sem o webhook ter chegado
		}
	}
	if st, ok := s.store.Get(userID); ok {
		s.dropLocked(ctx, st, true)
	}
	return nil
}

// SetSelfState atualiza mute/deaf (estado do cliente). 409 se o usuário não está num canal de voz.
func (s *Service) SetSelfState(ctx context.Context, userID int64, mute, deaf bool) (StatePayload, error) {
	if !s.Enabled() {
		return StatePayload{}, ErrDisabled
	}
	_, span := tracer.Start(ctx, "voice.SetSelfState")
	defer span.End()
	defer s.lock(userID)()
	if st, ok := s.store.Get(userID); ok {
		if st.SelfMute != mute || st.SelfDeaf != deaf {
			st.SelfMute, st.SelfDeaf = mute, deaf
			s.store.Put(st)
			s.publish(st, false)
		}
		return st.Payload(), nil
	}
	// Token emitido, mas o webhook de entrada ainda não chegou: guarda para aplicar na entrada.
	if p, ok := s.store.GetPending(userID, s.now()); ok {
		p.SelfMute, p.SelfDeaf = mute, deaf
		s.store.SetPending(p)
		return State{UserID: userID, ChannelID: p.ChannelID, GuildID: p.GuildID, SelfMute: mute, SelfDeaf: deaf}.Payload(), nil
	}
	return StatePayload{}, ErrNotInVoice
}

// GuildStates é o snapshot dos estados de voz de um servidor (membro com VIEW_CHANNEL).
func (s *Service) GuildStates(ctx context.Context, userID, guildID int64) ([]StatePayload, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	view, err := s.access.ViewableChannels(ctx, userID, guildID)
	if err != nil {
		return nil, err
	}
	// Só os canais que o usuário vê (permissão efetiva): quem não vê um canal privado não vê quem está nele.
	out := make([]State, 0)
	for _, st := range s.store.ByGuild(guildID) {
		if _, ok := view[st.ChannelID]; ok {
			out = append(out, st)
		}
	}
	return payloads(out), nil
}

// Occupants diz quantas pessoas estão na sala do canal agora (DM ou canal de voz).
func (s *Service) Occupants(channelID int64) int { return len(s.store.ByChannel(channelID)) }

// Snapshot devolve os estados de voz dos servidores e DMs informados (READY). Só memória; o
// chamador (gateway) já sabe quais servidores o usuário vê. Nunca devolve nil.
func (s *Service) Snapshot(guildIDs, dmChannelIDs []int64) []StatePayload {
	out := payloads(s.store.ByGuilds(guildIDs))
	return append(out, payloads(s.store.ByChannels(dmChannelIDs))...)
}

func payloads(sts []State) []StatePayload {
	out := make([]StatePayload, 0, len(sts))
	for _, st := range sts {
		out = append(out, st.Payload())
	}
	return out
}

// ---- webhook ----

// HandleWebhook verifica a assinatura e aplica o evento ao estado. Idempotente: o mesmo evento
// (por ID) ou uma transição repetida não produz efeito duas vezes. ok=false: evento ignorado.
func (s *Service) HandleWebhook(ctx context.Context, authorization string, body []byte) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	ev, ok, err := s.prov.VerifyWebhook(authorization, body)
	if err != nil {
		s.met.webhooks.Add(ctx, 1, metric.WithAttributes(attribute.String("type", "invalid")))
		return err
	}
	typ := ev.Type
	if !ok {
		typ = "ignored"
	}
	s.met.webhooks.Add(ctx, 1, metric.WithAttributes(attribute.String("type", typ)))
	if !ok {
		return nil
	}
	ctx, span := tracer.Start(ctx, "voice.Webhook", trace.WithAttributes(attribute.String("event.type", ev.Type)))
	defer span.End()
	if ev.ID != "" && s.seen.has(ev.ID) {
		return nil
	}
	if err := s.apply(ctx, ev); err != nil {
		span.SetStatus(codes.Error, err.Error())
		return err
	}
	if ev.ID != "" {
		s.seen.add(ev.ID)
	}
	return nil
}

func (s *Service) apply(ctx context.Context, ev RoomEvent) error {
	channelID, ok := parseID(ev.Room)
	if !ok {
		return nil // sala que não é nossa
	}
	if ev.Type == EventRoomFinished {
		for _, st := range s.store.ByChannel(channelID) {
			func() {
				defer s.lock(st.UserID)()
				if cur, ok := s.store.Get(st.UserID); ok && cur.ChannelID == channelID {
					s.dropLocked(ctx, cur, false)
				}
			}()
		}
		return nil
	}
	userID, ok := parseID(ev.Identity)
	if !ok {
		return nil // participante que não é usuário (ingress, egress…)
	}
	switch ev.Type {
	case EventParticipantJoined:
		return s.join(ctx, userID, channelID, ev.SID, ev.Tracks)
	case EventParticipantLeft:
		defer s.lock(userID)()
		st, ok := s.store.Get(userID)
		if !ok || st.ChannelID != channelID {
			return nil // já saiu, ou é a sala antiga de quem trocou de canal
		}
		if ev.SID != "" && st.SID != "" && ev.SID != st.SID {
			return nil // conexão antiga de quem reconectou: a nova já está valendo
		}
		s.dropLocked(ctx, st, false)
	case EventTrackPublished, EventTrackUnpublished:
		defer s.lock(userID)()
		st, ok := s.store.Get(userID)
		if !ok || st.ChannelID != channelID {
			return nil
		}
		on := ev.Type == EventTrackPublished
		next := st
		switch ev.Source {
		case SourceCamera:
			next.Video = on
		case SourceScreenShare:
			next.Screen = on
			if !on && s.previews != nil { // parou de transmitir: a prévia some junto
				s.previews.Delete(userID)
				next.Preview = false
			}
		}
		if next != st {
			s.store.Put(next)
			s.publish(next, false)
		}
	}
	return nil
}

// join registra a entrada de um participante vista no LiveKit (webhook ou reconciliador).
func (s *Service) join(ctx context.Context, userID, channelID int64, sid string, sources []Source) error {
	defer s.lock(userID)()
	// Token antigo (válido por 10 min) usado depois de pedir outro canal: a intenção mais recente vence.
	pend, hasPend := s.store.GetPending(userID, s.now())
	if hasPend && pend.ChannelID != channelID {
		s.kick(ctx, channelID, userID)
		return nil
	}
	cur, joined := s.store.Get(userID)
	if joined && cur.ChannelID != channelID {
		// Já está em outro canal e não pediu este token agora: conexão duplicada, derruba esta.
		s.kick(ctx, channelID, userID)
		return nil
	}
	acc, err := s.access.Channel(ctx, userID, channelID)
	if err != nil && !denied(err) {
		return err
	}
	if err != nil || !acc.Voiceable() || !acc.CanConnect {
		s.kick(ctx, channelID, userID)
		if joined {
			s.dropLocked(ctx, cur, false)
		}
		return nil
	}

	next := State{
		UserID: userID, ChannelID: channelID, GuildID: acc.GuildID, SID: sid,
		CanSpeak: (acc.CanSpeak && !acc.ServerMuted) || acc.GuildID == 0, CanVideo: acc.CanVideo || acc.GuildID == 0,
		ServerMuted: acc.ServerMuted && acc.GuildID != 0, JoinedAt: s.now(),
	}
	if joined {
		next.SelfMute, next.SelfDeaf, next.JoinedAt = cur.SelfMute, cur.SelfDeaf, cur.JoinedAt
		next.Preview = cur.Preview // reconexão da mesma chamada mantém a prévia
	} else if hasPend {
		next.SelfMute, next.SelfDeaf = pend.SelfMute, pend.SelfDeaf
	}
	for _, src := range sources {
		switch src {
		case SourceCamera:
			next.Video = true
		case SourceScreenShare:
			next.Screen = true
		}
	}
	if hasPend {
		s.store.ClearPending(userID)
	}
	if joined && next == cur {
		return nil
	}
	s.store.Put(next)
	s.publish(next, false)
	return nil
}

// ---- mudança de permissão no meio da chamada ----

// OnEvent reavalia os participantes quando uma mudança de domínio pode ter alterado o acesso
// deles (assinante do barramento de eventos).
func (s *Service) OnEvent(ev events.Event) {
	if !s.Enabled() {
		return
	}
	switch ev.Type {
	case events.RoleUpdate, events.RoleDelete, events.GuildMemberUpdate, events.GuildMemberRemove,
		events.GuildUpdate, events.GuildDelete, events.ChannelUpdate, events.ChannelDelete, events.ChannelOverwritesUpdate:
	default:
		return
	}
	var sts []State
	switch {
	case ev.GuildID != 0:
		sts = s.store.ByGuild(ev.GuildID)
	case ev.ChannelID != 0:
		sts = s.store.ByChannel(ev.ChannelID) // DM
	}
	if len(sts) == 0 {
		return
	}
	ctx, span := tracer.Start(context.Background(), "voice.Reevaluate",
		trace.WithAttributes(attribute.String("event.type", ev.Type), attribute.Int("participants", len(sts))))
	defer span.End()
	for _, st := range sts {
		s.Reevaluate(ctx, st.UserID)
	}
}

// Reevaluate confere o acesso do participante ao canal em que está: perdeu CONNECT ou VIEW_CHANNEL
// (ou o canal/servidor sumiu) → sai da sala; mudou SPEAK/VIDEO → atualiza o LiveKit.
func (s *Service) Reevaluate(ctx context.Context, userID int64) {
	defer s.lock(userID)()
	st, ok := s.store.Get(userID)
	if !ok {
		return
	}
	acc, err := s.access.Channel(ctx, userID, st.ChannelID)
	if err != nil && !denied(err) {
		slog.Warn("voice: não foi possível reavaliar as permissões", "user", userID, "channel", st.ChannelID, "err", err)
		return
	}
	if err != nil || !acc.Voiceable() || !acc.CanConnect {
		s.met.evictions.Add(ctx, 1)
		s.dropLocked(ctx, st, true)
		return
	}
	g := grantsFor(acc)
	speak, video := (acc.CanSpeak && !acc.ServerMuted) || acc.GuildID == 0, acc.CanVideo || acc.GuildID == 0
	muted := acc.ServerMuted && acc.GuildID != 0
	if speak == st.CanSpeak && video == st.CanVideo && muted == st.ServerMuted {
		return
	}
	rctx, cancel := remote(ctx)
	defer cancel()
	if err := s.prov.UpdatePermissions(rctx, roomName(st.ChannelID), identity(userID), g); err != nil {
		slog.Warn("voice: não foi possível atualizar as permissões no LiveKit", "user", userID, "err", err)
		return // tenta de novo no próximo evento
	}
	mutedChanged := muted != st.ServerMuted
	st.CanSpeak, st.CanVideo, st.ServerMuted = speak, video, muted
	if !video { // sem VIDEO o LiveKit encerra câmera e tela
		st.Video, st.Screen = false, false
		if s.previews != nil {
			s.previews.Delete(userID)
		}
		st.Preview = false
	}
	s.store.Put(st)
	if !video || mutedChanged {
		s.publish(st, false)
	}
}

// ---- reconciliação ----

// Run roda o reconciliador a cada interval até ctx terminar.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	if !s.Enabled() {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	sweep := time.NewTicker(previewSweepEvery)
	defer sweep.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			s.SweepPreviews(ctx)
		case <-t.C:
			if err := s.Reconcile(ctx); err != nil {
				slog.Warn("voice: reconciliação falhou", "err", err)
			}
		}
	}
}

// Reconcile compara o estado em memória com o LiveKit: remove estados órfãos (LiveKit reiniciou,
// webhook perdido) e registra participantes que o backend não conhecia (backend reiniciou).
// Falha ao consultar uma sala nunca remove estados dela.
func (s *Service) Reconcile(ctx context.Context) error {
	if !s.Enabled() {
		return nil
	}
	ctx, span := tracer.Start(ctx, "voice.Reconcile")
	defer span.End()
	start := s.now()
	rctx, cancel := remote(ctx)
	rooms, err := s.prov.ListRooms(rctx)
	cancel()
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		return err
	}
	set := map[int64]struct{}{}
	for _, r := range rooms {
		if id, ok := parseID(r.Name); ok && r.Participants > 0 {
			set[id] = struct{}{}
		}
	}
	for _, ch := range s.store.Channels() {
		set[ch] = struct{}{}
	}
	removed := 0
	for ch := range set {
		rctx, cancel := remote(ctx)
		parts, err := s.prov.ListParticipants(rctx, roomName(ch))
		cancel()
		if err != nil {
			slog.Warn("voice: não foi possível listar a sala", "channel", ch, "err", err)
			continue
		}
		live := map[int64]struct{}{}
		for _, p := range parts {
			uid, ok := parseID(p.Identity)
			if !ok {
				continue
			}
			live[uid] = struct{}{}
			if err := s.join(ctx, uid, ch, p.SID, p.Sources); err != nil {
				slog.Warn("voice: não foi possível registrar o participante", "user", uid, "channel", ch, "err", err)
			}
		}
		for _, st := range s.store.ByChannel(ch) {
			if _, ok := live[st.UserID]; ok || !st.JoinedAt.Before(start) {
				continue // vivo, ou entrou depois da consulta (o webhook chegou antes da lista)
			}
			func() {
				defer s.lock(st.UserID)()
				if cur, ok := s.store.Get(st.UserID); ok && cur.ChannelID == ch && cur.JoinedAt.Equal(st.JoinedAt) {
					s.dropLocked(ctx, cur, false)
					removed++
				}
			}()
		}
	}
	span.SetAttributes(attribute.Int("removed", removed))
	if removed > 0 {
		s.met.orphans.Add(ctx, int64(removed))
		slog.Info("voice: estados órfãos removidos", "count", removed)
	}
	return nil
}

// ---- deduplicação de webhooks ----

// dedupe lembra dos últimos IDs de evento processados (LiveKit pode reenviar o mesmo webhook).
type dedupe struct {
	mu    sync.Mutex
	max   int
	ids   map[string]struct{}
	order []string
}

func newDedupe(max int) *dedupe { return &dedupe{max: max, ids: map[string]struct{}{}} }

func (d *dedupe) has(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.ids[id]
	return ok
}

func (d *dedupe) add(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.ids[id]; ok {
		return
	}
	d.ids[id] = struct{}{}
	d.order = append(d.order, id)
	if len(d.order) > d.max {
		delete(d.ids, d.order[0])
		d.order = d.order[1:]
	}
}
