package notification

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/message"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

// Channels é o que a feature precisa de channel: autorização de acesso (servidor e DM).
type Channels interface {
	Authorize(ctx context.Context, userID, channelID int64, need perm.Perm) (channel.Channel, perm.Member, error)
	// ViewableIDs são os canais do servidor que o usuário vê (permissão efetiva de cada canal).
	ViewableIDs(ctx context.Context, guildID, userID int64) ([]int64, error)
	// Audience são os membros do servidor do canal que o veem (com os cargos de cada um): o público das
	// menções em massa (@everyone, @here e cargos).
	Audience(ctx context.Context, channelID int64) ([]perm.Member, error)
}

// Presence diz se o usuário tem sessão de gateway ativa (implementada por presence.Service). Status
// diferente de "offline" conta como ativo.
type Presence interface {
	Status(userID int64) string
}

// Limiter limita os endpoints de push por usuário.
type Limiter interface {
	Take(key string) (ok bool, retryAfter time.Duration)
}

type IDGenerator interface{ Next() int64 }

// Bus é o que a feature precisa do barramento para assinar os eventos.
type Bus interface {
	Subscribe(fn func(events.Event)) (cancel func())
}

const (
	workers    = 4    // goroutines que processam MESSAGE_CREATE
	queueSize  = 4096 // eventos esperando; acima disso são descartados (e contados)
	eventLimit = 15 * time.Second
)

// Deps são as dependências do Service.
type Deps struct {
	Store    Store
	Channels Channels
	Presence Presence
	Pub      events.Publisher
	IDs      IDGenerator
	Limiter  Limiter // nulo = sem limite

	// EveryonePushMax é o máximo de destinatários de push de uma menção em massa (EVERYONE_PUSH_MAX, padrão 200
	// na config): acima disso a mensagem só soma contadores. Zero = menção em massa nunca dispara push.
	EveryonePushMax int

	// Push. Sem Sender/Queue (ou com Config desligada) os endpoints respondem 503 e nada é enfileirado.
	Push   PushConfig
	Sender Sender
	Queue  PushQueue
	Policy EndpointPolicy
}

type Service struct {
	Deps
	m      *metrics
	blocks Blocks

	startOnce, stopOnce sync.Once
	cancelBus           func()
	queue               chan events.Event
	wg                  sync.WaitGroup
}

func NewService(d Deps) *Service {
	return &Service{Deps: d, m: newMetrics()}
}

// PushEnabled diz se o Web Push está configurado e ligado a uma fila.
func (s *Service) PushEnabled() bool {
	return s.Push.Enabled() && s.Sender != nil && s.Queue != nil
}

func userTopic(id int64) string { return "user:" + strconv.FormatInt(id, 10) }

// ---- ack e leitura ----

// Ack marca o canal como lido até messageID. A leitura nunca regride (vale o maior ID) e nunca passa da
// última mensagem do canal; quando alcança a última, as menções zeram. O usuário precisa acessar o canal.
func (s *Service) Ack(ctx context.Context, userID, channelID, messageID int64) (UpdatePayload, error) {
	ctx, span := tracer.Start(ctx, "notification.Ack")
	defer span.End()
	span.SetAttributes(attribute.Int64("channel.id", channelID))
	if messageID <= 0 {
		return UpdatePayload{}, errInvalidMessage
	}
	ch, _, err := s.Channels.Authorize(ctx, userID, channelID, 0)
	if err != nil {
		return UpdatePayload{}, err
	}
	if ch.Type != channel.TypeText && !ch.IsDM() {
		return UpdatePayload{}, ErrNotReadable
	}
	last, mentions, err := s.Store.Ack(ctx, userID, channelID, messageID)
	if err != nil {
		return UpdatePayload{}, err
	}
	s.m.acks.Add(ctx, 1)
	up := updatePayload(channelID, last, mentions)
	s.publishUpdate(userID, ch.GuildID, up)
	return up, nil
}

func updatePayload(channelID, lastRead int64, mentions int) UpdatePayload {
	return UpdatePayload{
		ChannelID: strconv.FormatInt(channelID, 10), LastReadMessageID: strconv.FormatInt(lastRead, 10), MentionCount: mentions,
	}
}

// publishUpdate avisa todas as sessões do usuário (tópico user:<id>).
func (s *Service) publishUpdate(userID int64, guildID *int64, up UpdatePayload) {
	cid, _ := strconv.ParseInt(up.ChannelID, 10, 64)
	ev := events.Event{Type: events.ReadStateUpdate, ChannelID: cid, Topics: []string{userTopic(userID)}, Data: up}
	if guildID != nil {
		ev.GuildID = *guildID
	}
	s.Pub.Publish(ev)
}

// ReadStates devolve o estado de todos os canais acessíveis (servidores onde o usuário tem VIEW_CHANNEL e
// DMs) e o agregado por servidor. É uma consulta só, qualquer que seja o número de canais.
func (s *Service) ReadStates(ctx context.Context, userID int64) ([]ReadState, error) {
	ctx, span := tracer.Start(ctx, "notification.ReadStates")
	defer span.End()
	start := time.Now()
	states, err := s.Store.ReadStates(ctx, userID)
	s.m.readStatesDur.Record(ctx, time.Since(start).Seconds())
	if err != nil {
		return nil, err
	}
	// Canais privados: o store filtra por servidor; aqui sai o que o usuário não vê por permissão de canal.
	states, err = s.onlyViewable(ctx, userID, states)
	if err != nil {
		return nil, err
	}
	span.SetAttributes(attribute.Int("channels", len(states)))
	return states, nil
}

// onlyViewable descarta os estados de canais de servidor que o usuário não vê (overwrites).
func (s *Service) onlyViewable(ctx context.Context, userID int64, states []ReadState) ([]ReadState, error) {
	view := map[int64]map[int64]struct{}{}
	out := states[:0:0]
	for _, st := range states {
		if st.GuildID == nil {
			out = append(out, st)
			continue
		}
		gid := *st.GuildID
		set, ok := view[gid]
		if !ok {
			ids, err := s.Channels.ViewableIDs(ctx, gid, userID)
			if err != nil && !errors.Is(err, perm.ErrNotMember) {
				return nil, err
			}
			set = make(map[int64]struct{}, len(ids))
			for _, id := range ids {
				set[id] = struct{}{}
			}
			view[gid] = set
		}
		if _, ok := set[st.ChannelID]; ok {
			out = append(out, st)
		}
	}
	return out, nil
}

// ReadyStates são os read_states do READY: só canais com não lidas ou menções (o resto vale zero).
func (s *Service) ReadyStates(ctx context.Context, userID int64) ([]ReadStatePayload, error) {
	states, err := s.ReadStates(ctx, userID)
	if err != nil {
		return nil, err
	}
	return Payloads(states, false), nil
}

// ---- menções ----

// Resolve implementa message.Mentions: os usuários citados com @username que podem ver o canal (membros
// com VIEW_CHANNEL; em DM, participantes), sem o autor, em ordem de ID, no máximo MaxMentions. Em canais de
// servidor também acha @everyone, @here e @NomeDoCargo: canMentionAll (MENTION_EVERYONE do autor) libera os
// três; sem ele, só valem cargos marcados como mencionáveis, e @everyone/@here ficam como texto comum.
func (s *Service) Resolve(ctx context.Context, ch channel.Channel, authorID int64, content string, canMentionAll bool) (message.MentionResult, error) {
	var res message.MentionResult
	if !strings.Contains(content, "@") {
		return res, nil
	}
	ctx, span := tracer.Start(ctx, "notification.ResolveMentions")
	defer span.End()

	names := slices.DeleteFunc(ParseMentions(content), func(n string) bool { return n == "everyone" || n == "here" })
	span.SetAttributes(attribute.Int("candidates", len(names)))
	if len(names) > 0 {
		ids, err := s.resolveUsers(ctx, ch, authorID, names)
		if err != nil {
			return message.MentionResult{}, err
		}
		// Menção de quem foi bloqueado não destaca nem notifica o bloqueador (e não revela o bloqueio).
		if ids, err = s.withoutBlockers(ctx, authorID, ids); err != nil {
			return message.MentionResult{}, err
		}
		res.UserIDs = ids
		if len(ids) > 0 {
			s.m.mentions.Add(ctx, int64(len(ids)))
		}
	}
	if ch.GuildID != nil {
		roles, err := s.Store.RoleMentionTargets(ctx, *ch.GuildID)
		if err != nil {
			return message.MentionResult{}, err
		}
		b := ParseBulk(content, roles)
		if canMentionAll {
			res.Everyone, res.Here = b.Everyone, b.Here
		}
		for _, id := range b.RoleIDs {
			if i := slices.IndexFunc(roles, func(r RoleRef) bool { return r.ID == id }); i >= 0 && (canMentionAll || roles[i].Mentionable) {
				res.RoleIDs = append(res.RoleIDs, id)
			}
		}
		span.SetAttributes(attribute.Bool("everyone", res.Everyone), attribute.Bool("here", res.Here), attribute.Int("roles", len(res.RoleIDs)))
	}
	return res, nil
}

func (s *Service) resolveUsers(ctx context.Context, ch channel.Channel, authorID int64, names []string) ([]int64, error) {
	var ids []int64
	var err error
	if ch.GuildID != nil {
		ids, err = s.Store.ResolveGuildMentions(ctx, *ch.GuildID, authorID, names)
	} else {
		ids, err = s.Store.ResolveDMMentions(ctx, ch.ID, authorID, names)
	}
	if err != nil {
		return nil, err
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	if len(ids) > MaxMentions {
		ids = ids[:MaxMentions]
	}
	if ch.GuildID != nil {
		// Menção só vale para quem vê ESTE canal (o store só conhece a permissão do servidor).
		kept := ids[:0:0]
		for _, id := range ids {
			if _, _, err := s.Channels.Authorize(ctx, id, ch.ID, 0); err == nil {
				kept = append(kept, id)
			} else if !apperr.IsKind(err, apperr.KindNotFound) && !apperr.IsKind(err, apperr.KindForbidden) {
				return nil, err
			}
		}
		ids = kept
	}
	return ids, nil
}

// bulkTargets resolve quem uma menção em massa atinge entre quem vê o canal: @everyone atinge todos, @here só
// quem está online (presença visível; invisível conta como offline), @cargo os membros do cargo. Quem pediu
// "Suprimir @everyone e @here" no servidor sai do que veio de @everyone/@here (não soma nem avisa), mas continua
// recebendo o que veio de um cargo. O autor nunca entra.
func (s *Service) bulkTargets(ctx context.Context, msg message.MessagePayload, channelID, authorID, guildID int64) ([]int64, error) {
	if !msg.MentionEveryone && !msg.MentionHere && len(msg.MentionRoles) == 0 {
		return nil, nil
	}
	audience, err := s.Channels.Audience(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("público da menção em massa: %w", err)
	}
	roleSet := make(map[int64]struct{}, len(msg.MentionRoles))
	for _, r := range msg.MentionRoles {
		if id, err := strconv.ParseInt(r, 10, 64); err == nil {
			roleSet[id] = struct{}{}
		}
	}
	var viaRole, viaMass []int64
	for _, m := range audience {
		if m.UserID == authorID {
			continue
		}
		if slices.ContainsFunc(m.RoleIDs, func(id int64) bool { _, ok := roleSet[id]; return ok }) {
			viaRole = append(viaRole, m.UserID)
			continue
		}
		if msg.MentionEveryone || (msg.MentionHere && s.Presence.Status(m.UserID) != presence.StatusOffline) {
			viaMass = append(viaMass, m.UserID)
		}
	}
	if len(viaMass) > 0 {
		suppressed, err := s.Store.SuppressedEveryone(ctx, guildID, viaMass)
		if err != nil {
			return nil, err
		}
		if len(suppressed) > 0 {
			viaMass = slices.DeleteFunc(viaMass, func(id int64) bool { return slices.Contains(suppressed, id) })
		}
	}
	return append(viaRole, viaMass...), nil
}

// ---- assinatura do barramento ----

// Start assina o barramento: cada MESSAGE_CREATE entra numa fila processada por poucas goroutines (o
// assinante do barramento nunca bloqueia). Cancelar ctx ou chamar Stop encerra a assinatura.
func (s *Service) Start(ctx context.Context, bus Bus) {
	s.startOnce.Do(func() {
		s.queue = make(chan events.Event, queueSize)
		for range workers {
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				for ev := range s.queue {
					s.process(ev)
				}
			}()
		}
		s.cancelBus = bus.Subscribe(s.enqueue)
		go func() { <-ctx.Done(); s.Stop() }()
	})
}

// Stop cancela a assinatura e espera os eventos já enfileirados terminarem. Idempotente.
func (s *Service) Stop() {
	s.stopOnce.Do(func() {
		if s.cancelBus == nil {
			return
		}
		s.cancelBus() // espera o evento em andamento do assinante: depois disso ninguém mais escreve em queue
		close(s.queue)
		s.wg.Wait()
	})
}

func (s *Service) enqueue(ev events.Event) {
	if ev.Type != events.MessageCreate && ev.Type != events.GuildMemberRemove {
		return
	}
	select {
	case s.queue <- ev:
	default:
		s.m.dropped.Add(context.Background(), 1, metric.WithAttributes(attribute.String("reason", "queue_full")))
		slog.Warn("notificação descartada: fila cheia", "channel", ev.ChannelID)
	}
}

func (s *Service) process(ev events.Event) {
	ctx, cancel := context.WithTimeout(context.Background(), eventLimit)
	defer cancel()
	var err error
	if ev.Type == events.GuildMemberRemove {
		err = s.onMemberRemove(ctx, ev)
	} else {
		err = s.onMessage(ctx, ev)
	}
	if err != nil {
		s.m.dropped.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", "error")))
		slog.Warn("notificação de mensagem falhou", "channel", ev.ChannelID, "err", err)
	}
}

// onMemberRemove apaga o estado de leitura de quem saiu do servidor: ao voltar ele não herda o que
// aconteceu enquanto esteve fora (nem o que já tinha lido antes).
func (s *Service) onMemberRemove(ctx context.Context, ev events.Event) error {
	p, ok := ev.Data.(guild.MemberRemovePayload)
	if !ok {
		return nil
	}
	gid, err1 := strconv.ParseInt(p.GuildID, 10, 64)
	uid, err2 := strconv.ParseInt(p.UserID, 10, 64)
	if err := errors.Join(err1, err2); err != nil {
		return fmt.Errorf("ids do payload: %w", err)
	}
	return s.Store.DeleteGuildReadStates(ctx, gid, uid)
}

// onMessage trata um MESSAGE_CREATE: avança a leitura do autor; soma uma menção a quem foi citado (e, nas
// DMs, a todos os outros participantes), avisando suas sessões; e enfileira o push de quem estiver offline.
func (s *Service) onMessage(ctx context.Context, ev events.Event) error {
	msg, ok := ev.Data.(message.MessagePayload)
	if !ok {
		return nil
	}
	ctx, span := tracer.Start(ctx, "notification.OnMessage")
	defer span.End()
	authorID, err1 := strconv.ParseInt(msg.Author.ID, 10, 64)
	messageID, err2 := strconv.ParseInt(msg.ID, 10, 64)
	if err := errors.Join(err1, err2); err != nil {
		return fmt.Errorf("ids do payload: %w", err)
	}
	// Mensagem de sistema ("fulano entrou"): não avança leitura, não soma menção e não avisa ninguém.
	if msg.Kind != "" && msg.Kind != message.KindDefault {
		return nil
	}
	channelID := ev.ChannelID
	isDM := ev.GuildID == 0
	var guildID *int64
	if !isDM {
		guildID = &ev.GuildID
	}

	// Quem escreve leu o canal até a própria mensagem (e suas menções zeram).
	if _, _, err := s.Store.Ack(ctx, authorID, channelID, messageID); err != nil {
		return fmt.Errorf("avançar leitura do autor: %w", err)
	}

	mentioned := make([]int64, 0, len(msg.MentionIDs))
	for _, id := range msg.MentionIDs {
		if n, err := strconv.ParseInt(id, 10, 64); err == nil {
			mentioned = append(mentioned, n)
		}
	}
	var bulk []int64
	if !isDM {
		var err error
		if bulk, err = s.bulkTargets(ctx, msg, channelID, authorID, ev.GuildID); err != nil {
			return err
		}
	}
	var participants []int64
	if isDM {
		var err error
		if participants, err = s.Store.RecipientIDs(ctx, channelID); err != nil {
			return err
		}
	}
	targets := notifyTargets(authorID, isDM, participants, append(slices.Clone(mentioned), bulk...))
	// Quem bloqueou o autor não soma menção nem recebe aviso (nas DMs em grupo e nos servidores).
	targets, ferr := s.withoutBlockers(ctx, authorID, targets)
	if ferr != nil {
		return ferr
	}
	if len(targets) == 0 {
		return nil
	}

	states, err := s.Store.IncrementMentions(ctx, channelID, guildID, targets)
	if err != nil {
		return err
	}
	for _, st := range states {
		s.publishUpdate(st.UserID, guildID, updatePayload(channelID, st.LastRead, st.Mentions))
	}

	if !s.PushEnabled() {
		return nil
	}
	recipients := pushRecipients(targets, func(id int64) bool {
		return s.Presence.Status(id) != presence.StatusOffline
	})
	if len(recipients) == 0 {
		return nil
	}
	// Nos servidores todo alvo é uma menção (direta, de cargo ou em massa); nas DMs, só os citados.
	mentionSet := make(map[int64]bool, len(targets))
	for _, id := range mentioned {
		mentionSet[id] = true
	}
	if !isDM {
		for _, id := range targets {
			mentionSet[id] = true
		}
	}
	// Limite de fan-out: menção em massa para mais gente que EveryonePushMax só soma contadores; os citados
	// diretamente continuam recebendo o push.
	if len(bulk) > s.EveryonePushMax {
		direct := make(map[int64]struct{}, len(mentioned))
		for _, id := range mentioned {
			direct[id] = struct{}{}
		}
		recipients = slices.DeleteFunc(recipients, func(id int64) bool { _, ok := direct[id]; return !ok })
		s.m.dropped.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", "fanout_limit")))
		if len(recipients) == 0 {
			return nil
		}
	}
	// Não perturbar e silenciar/nível: só o aviso muda; a contagem de menções acima já foi somada.
	if recipients, err = s.notifiable(ctx, recipients, channelID, guildID, mentionSet); err != nil {
		return err
	}
	return s.enqueuePush(ctx, messageID, channelID, recipients)
}

func (s *Service) enqueuePush(ctx context.Context, messageID, channelID int64, recipients []int64) error {
	if len(recipients) == 0 {
		return nil
	}
	subs, err := s.Store.SubscriptionsOf(ctx, recipients)
	if err != nil {
		return err
	}
	if len(subs) == 0 {
		return nil
	}
	args := make([]PushArgs, len(subs))
	for i, sub := range subs {
		args[i] = PushArgs{SubscriptionID: sub.ID, MessageID: messageID, ChannelID: channelID}
	}
	return s.Queue.EnqueuePush(ctx, args)
}

// ---- push: inscrições e entrega ----

// errPermanent marca respostas do serviço de push que nenhuma nova tentativa resolve.
var errPermanent = errors.New("recusado pelo serviço de push")

func (s *Service) takePush(userID int64) error {
	if s.Limiter == nil {
		return nil
	}
	if ok, wait := s.Limiter.Take("push:" + strconv.FormatInt(userID, 10)); !ok {
		return apperr.RateLimited("muitas requisições de notificação; tente novamente em instantes", wait)
	}
	return nil
}

// VAPIDPublicKey é a chave que o navegador usa em pushManager.subscribe (applicationServerKey).
func (s *Service) VAPIDPublicKey(userID int64) (string, error) {
	if !s.PushEnabled() {
		return "", ErrPushDisabled
	}
	if err := s.takePush(userID); err != nil {
		return "", err
	}
	return s.Push.PublicKey, nil
}

// Subscribe guarda (ou atualiza, pelo endpoint) a inscrição de push do usuário. Máximo de MaxSubscriptions
// por usuário; o endpoint precisa ser https e não pode apontar para rede interna.
func (s *Service) Subscribe(ctx context.Context, userID int64, endpoint, p256dh, auth string) error {
	ctx, span := tracer.Start(ctx, "notification.Subscribe")
	defer span.End()
	if !s.PushEnabled() {
		return ErrPushDisabled
	}
	if err := s.takePush(userID); err != nil {
		return err
	}
	if err := validateSubscriptionKeys(p256dh, auth); err != nil {
		return err
	}
	if err := s.Policy.Validate(ctx, endpoint); err != nil {
		return err
	}
	return s.Store.Subscribe(ctx, Subscription{ID: s.IDs.Next(), UserID: userID, Endpoint: endpoint, P256dh: p256dh, Auth: auth}, MaxSubscriptions)
}

// Unsubscribe remove a inscrição do usuário (idempotente).
func (s *Service) Unsubscribe(ctx context.Context, userID int64, endpoint string) error {
	ctx, span := tracer.Start(ctx, "notification.Unsubscribe")
	defer span.End()
	if !s.PushEnabled() {
		return ErrPushDisabled
	}
	if err := s.takePush(userID); err != nil {
		return err
	}
	return s.Store.Unsubscribe(ctx, userID, endpoint)
}

// deliver envia um push e diz o resultado (rótulo da métrica). Erro != nil pede nova tentativa, exceto
// quando embrulha errPermanent.
func (s *Service) deliver(ctx context.Context, a PushArgs) (string, error) {
	sub, err := s.Store.Subscription(ctx, a.SubscriptionID)
	if errors.Is(err, ErrNotFound) {
		return resSkipped, nil
	}
	if err != nil {
		return resFailed, err
	}
	// Reavalia na hora do envio (o job pode ter esperado uma retentativa): quem voltou não é incomodado.
	if s.Presence.Status(sub.UserID) != presence.StatusOffline {
		return resSkipped, nil
	}
	pc, err := s.Store.PushContext(ctx, a.MessageID)
	if errors.Is(err, ErrNotFound) {
		return resSkipped, nil // mensagem apagada
	}
	if err != nil {
		return resFailed, err
	}
	if pc.Kind != "" && pc.Kind != message.KindDefault {
		return resSkipped, nil // mensagem de sistema nunca avisa
	}

	status, err := s.Sender.Send(ctx, sub, BuildPushPayload(pc, a.ChannelID).JSON())
	switch {
	case errors.Is(err, ErrBlockedAddress):
		// O endpoint passou a apontar para rede interna: a inscrição não presta mais.
		slog.Warn("push bloqueado (anti-SSRF): inscrição removida", "subscription", sub.ID)
		return resRemoved, s.Store.DeleteSubscription(ctx, sub.ID)
	case err != nil:
		return resFailed, err
	}
	switch classify(status) {
	case outcomeSent:
		return resSent, nil
	case outcomeGone:
		return resRemoved, s.Store.DeleteSubscription(ctx, sub.ID)
	case outcomeRetry:
		return resFailed, fmt.Errorf("serviço de push respondeu %d", status)
	default:
		return resFailed, fmt.Errorf("%w: status %d", errPermanent, status)
	}
}
