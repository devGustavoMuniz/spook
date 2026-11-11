package voice

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
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
	Audit    Auditor // opcional
	Plans    Plans   // opcional: limites de plano (Nitro) no token e na faixa de tela
	// EnforceScreen liga o silenciamento da tela acima do plano (NITRO_ENFORCE_SCREEN; padrão desligado).
	EnforceScreen bool
	Now           func() time.Time // opcional (testes)
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
	plans    Plans
	// enforceScreen liga o silenciamento de tela acima do plano (plan.go). Desligado por padrão: clientes antigos não
	// conhecem os limites e a faixa silenciada deixa quem assiste carregando para sempre.
	enforceScreen bool
	now           func() time.Time

	locks [lockStripes]sync.Mutex

	rateMu  sync.Mutex
	lastPut map[int64]time.Time // último envio de prévia por usuário (limite de frequência)
	seen    *dedupe
	met     *metrics

	// Espectadores das transmissões (watch.go). watchMu ordena as mudanças + publicações; é uma trava folha
	// (nada que a segura pega a trava de um usuário).
	watch   *watchers
	watchMu sync.Mutex
}

func NewService(d Deps) *Service {
	s := &Service{
		prov: d.Provider, store: d.Store, previews: d.Previews, access: d.Access, users: d.Users, pub: d.Pub, audit: d.Audit, plans: d.Plans, enforceScreen: d.EnforceScreen, now: d.Now,
		seen: newDedupe(2048), lastPut: map[int64]time.Time{}, watch: newWatchers(),
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.pub == nil {
		s.pub = events.Discard{}
	}
	s.met = newMetrics(s.store, s.previews, s.watch)
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
	p := s.statePayload(st)
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
	// Quem sai deixa de assistir (e de ser assistido): os transmissores afetados recebem a contagem nova.
	s.watchMu.Lock()
	s.watch.dropStreamer(st.UserID)
	for _, streamer := range s.watch.dropViewer(st.UserID) {
		s.republishStreamer(streamer)
	}
	s.watchMu.Unlock()
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
	tier := s.tierOf(ctx, userID)
	return TokenResponse{
		URL: s.prov.PublicURL(), Token: token, ExpiresIn: int(TokenTTL / time.Second),
		Plan: string(tier), Limits: plan.For(tier),
	}, nil
}

// tierOf lê o plano de quem entra; sem planos ligados ou com falha vale grátis (a voz nunca deixa de funcionar por
// causa do plano).
func (s *Service) tierOf(ctx context.Context, userID int64) plan.Tier {
	if s.plans == nil {
		return plan.Free
	}
	t, err := s.plans.Tier(ctx, userID)
	if err != nil {
		slog.WarnContext(ctx, "voice: não foi possível ler o plano", "user", userID, "err", err)
		return plan.Free
	}
	return t
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
	return s.payloadsFor(userID, out), nil
}

// Occupants diz quantas pessoas estão na sala do canal agora (DM ou canal de voz).
func (s *Service) Occupants(channelID int64) int { return len(s.store.ByChannel(channelID)) }

// Snapshot devolve os estados de voz dos servidores e DMs informados (READY). Só memória; o
// chamador (gateway) já sabe quais servidores o usuário vê; a lista de espectadores só vai ao próprio transmissor
// (userID). Nunca devolve nil.
func (s *Service) Snapshot(userID int64, guildIDs, dmChannelIDs []int64) []StatePayload {
	out := s.payloadsFor(userID, s.store.ByGuilds(guildIDs))
	return append(out, s.payloadsFor(userID, s.store.ByChannels(dmChannelIDs))...)
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
	s.enforceScreenLimit(ctx, ev) // depois do estado e fora das travas; nunca devolve erro (o LiveKit não reenvia por isso)
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
			if !on { // parou de transmitir: a prévia e os espectadores somem junto
				if s.previews != nil {
					s.previews.Delete(userID)
				}
				next.Preview = false
				s.watchMu.Lock()
				s.watch.dropStreamer(userID)
				s.watchMu.Unlock()
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
		s.watchMu.Lock()
		s.watch.dropStreamer(userID)
		s.watchMu.Unlock()
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

// Run varre as prévias e os espectadores vencidos (todo previewSweepEvery) e, se reconcileEvery > 0, roda o
// reconciliador a cada intervalo até ctx terminar. Em produção o reconciliador roda como job periódico do River
// (`voice_reconcile`, ver jobs.go) e reconcileEvery fica em 0; sem a fila (sem pool do pgx) ou nos testes, é este laço.
func (s *Service) Run(ctx context.Context, reconcileEvery time.Duration) {
	if !s.Enabled() {
		return
	}
	var tick <-chan time.Time
	if reconcileEvery > 0 {
		t := time.NewTicker(reconcileEvery)
		defer t.Stop()
		tick = t.C
	}
	sweep := time.NewTicker(previewSweepEvery)
	defer sweep.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			s.SweepPreviews(ctx)
			s.SweepWatchers()
		case <-tick:
			if err := s.Reconcile(ctx); err != nil {
				slog.Warn("voice: reconciliação falhou", "err", err)
			}
		}
	}
}

// ReconcileReport resume uma rodada do reconciliador (testes e logs).
type ReconcileReport struct {
	Rooms       int // salas consultadas
	Joined      int // participantes do LiveKit que o backend não conhecia
	Orphans     int // estados removidos (a pessoa não está mais no LiveKit)
	FlagsFixed  int // indicadores de câmera/tela/prévia corrigidos
	MuteApplied int // mutes do servidor reaplicados no LiveKit
}

// Reconcile compara o estado em memória com o LiveKit e corrige as divergências, sem nunca derrubar quem está
// conectado por engano:
//   - estado órfão (LiveKit reiniciado, webhook perdido) é removido, mas só se a sala foi lida com sucesso e a
//     entrada é anterior à consulta;
//   - participante que o backend não conhecia (backend reiniciou) é registrado;
//   - câmera/tela desligadas no LiveKit sem webhook limpam o indicador, a prévia e os espectadores;
//   - prévia marcada sem prévia guardada limpa o indicador;
//   - quem está mutado pelo servidor e mesmo assim publica microfone tem as permissões reaplicadas;
//   - as permissões de cada participante são reavaliadas (rede de segurança de eventos de permissão perdidos).
//
// LiveKit fora do ar: devolve o erro (é registrado) e não toca em nada. É idempotente.
func (s *Service) Reconcile(ctx context.Context) error {
	_, err := s.ReconcileOnce(ctx)
	return err
}

// ReconcileOnce é o Reconcile devolvendo o relatório.
func (s *Service) ReconcileOnce(ctx context.Context) (rep ReconcileReport, err error) {
	if !s.Enabled() {
		return rep, nil
	}
	ctx, span := tracer.Start(ctx, "voice.Reconcile")
	defer span.End()
	start := s.now()
	defer func() {
		result := "ok"
		if err != nil {
			result = "unreachable"
			span.SetStatus(codes.Error, err.Error())
		}
		s.met.reconcileRuns.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
		s.met.reconcileTime.Record(ctx, time.Since(start).Seconds())
		s.met.reconcileFix.Add(ctx, int64(rep.Joined), metric.WithAttributes(attribute.String("kind", "joined")))
		s.met.reconcileFix.Add(ctx, int64(rep.FlagsFixed), metric.WithAttributes(attribute.String("kind", "flags")))
		s.met.reconcileFix.Add(ctx, int64(rep.MuteApplied), metric.WithAttributes(attribute.String("kind", "mute")))
		span.SetAttributes(attribute.Int("rooms", rep.Rooms), attribute.Int("removed", rep.Orphans))
		if rep.Orphans > 0 {
			s.met.orphans.Add(ctx, int64(rep.Orphans))
			slog.Info("voice: estados órfãos removidos", "count", rep.Orphans)
		}
	}()
	rctx, cancel := remote(ctx)
	rooms, err := s.prov.ListRooms(rctx)
	cancel()
	if err != nil {
		return rep, fmt.Errorf("listar as salas do LiveKit: %w", err)
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
	for ch := range set {
		rctx, cancel := remote(ctx)
		parts, err := s.prov.ListParticipants(rctx, roomName(ch))
		cancel()
		if err != nil {
			slog.Warn("voice: não foi possível listar a sala", "channel", ch, "err", err)
			continue // sala não lida: nada dela é removido
		}
		rep.Rooms++
		live := map[int64]struct{}{}
		for _, p := range parts {
			uid, ok := parseID(p.Identity)
			if !ok {
				continue
			}
			live[uid] = struct{}{}
			before, known := s.store.Get(uid)
			if known {
				s.Reevaluate(ctx, uid) // antes do join: ele atualiza o estado e esconderia a diferença das permissões
			}
			if err := s.join(ctx, uid, ch, p.SID, p.Sources); err != nil {
				slog.Warn("voice: não foi possível registrar o participante", "user", uid, "channel", ch, "err", err)
				continue
			}
			if cur, ok := s.store.Get(uid); ok && cur.ChannelID == ch {
				if !known {
					rep.Joined++
				}
				if known && (before.Video != cur.Video || before.Screen != cur.Screen) {
					rep.FlagsFixed++ // webhook de câmera/tela perdido: o join alinhou ao que o LiveKit publica
				}
				rep.FlagsFixed += s.syncPreview(uid, ch)
				if s.reapplyServerMute(ctx, uid, ch, p) {
					rep.MuteApplied++
				}
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
					rep.Orphans++
				}
			}()
		}
	}
	s.SweepWatchers()
	return rep, nil
}

// syncPreview limpa a prévia e os espectadores de quem não transmite mais (o join já alinhou câmera e tela às
// mídias publicadas no LiveKit, mas não mexe nisso) e o indicador de prévia sem prévia guardada. Devolve quantos
// indicadores corrigiu.
func (s *Service) syncPreview(userID, channelID int64) int {
	defer s.lock(userID)()
	st, ok := s.store.Get(userID)
	if !ok || st.ChannelID != channelID {
		return 0
	}
	next, fixed := st, 0
	if !next.Screen {
		if s.previews != nil {
			s.previews.Delete(userID)
		}
		if next.Preview {
			next.Preview, fixed = false, fixed+1
		}
		s.watchMu.Lock()
		s.watch.dropStreamer(userID)
		s.watchMu.Unlock()
	} else if next.Preview && s.previews != nil {
		if _, ok := s.previews.Get(userID, channelID, s.now()); !ok { // indicador sem prévia guardada
			next.Preview, fixed = false, fixed+1
		}
	}
	if next != st {
		s.store.Put(next)
		s.publish(next, false)
	}
	return fixed
}

// reapplyServerMute reaplica o mute do servidor quando o LiveKit ainda mostra o microfone do participante
// publicado (as permissões do token não foram respeitadas ou se perderam).
func (s *Service) reapplyServerMute(ctx context.Context, userID, channelID int64, p Participant) bool {
	st, ok := s.store.Get(userID)
	if !ok || st.ChannelID != channelID || !st.ServerMuted || st.GuildID == 0 {
		return false
	}
	mic := false
	for _, src := range p.Sources {
		if src == SourceMicrophone {
			mic = true
		}
	}
	if !mic {
		return false
	}
	rctx, cancel := remote(ctx)
	defer cancel()
	if err := s.prov.UpdatePermissions(rctx, roomName(channelID), identity(userID), GrantsFor(false, st.CanVideo)); err != nil {
		slog.Warn("voice: não foi possível reaplicar o mute do servidor", "user", userID, "err", err)
		return false
	}
	return true
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
