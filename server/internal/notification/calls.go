package notification

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"time"

	"github.com/riverqueue/river"
	"go.opentelemetry.io/otel/attribute"

	"github.com/devGustavoMuniz/spook/server/internal/platform/jobs"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
)

// Blocks diz quem bloqueou o autor, para não notificar essas pessoas (relationship.Service). Nulo = ninguém.
type Blocks interface {
	BlockersOf(ctx context.Context, userID int64, candidates []int64) ([]int64, error)
}

// SetBlocks liga o filtro de bloqueios: menções e mensagens de quem foi bloqueado não notificam o bloqueador.
func (s *Service) SetBlocks(b Blocks) { s.blocks = b }

// withoutBlockers tira de ids quem bloqueou authorID.
func (s *Service) withoutBlockers(ctx context.Context, authorID int64, ids []int64) ([]int64, error) {
	if s.blocks == nil || len(ids) == 0 {
		return ids, nil
	}
	blockers, err := s.blocks.BlockersOf(ctx, authorID, ids)
	if err != nil {
		return nil, fmt.Errorf("filtrar quem bloqueou o autor: %w", err)
	}
	if len(blockers) == 0 {
		return ids, nil
	}
	return slices.DeleteFunc(slices.Clone(ids), func(id int64) bool { return slices.Contains(blockers, id) }), nil
}

// CallRecipients filtra, dos candidatos, quem pode ser avisado de uma chamada na DM: sem "Não perturbar" e sem
// a DM silenciada. (Bloqueios são tratados por quem chama.)
func (s *Service) CallRecipients(ctx context.Context, channelID int64, candidates []int64) ([]int64, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	filters, err := s.Store.NotifyFilters(ctx, candidates, channelID, nil)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	out := make([]int64, 0, len(filters))
	for _, f := range filters {
		if f.DND {
			continue
		}
		if muted, _ := Resolve(now, f.Channel, f.Guild, false); muted {
			continue
		}
		out = append(out, f.UserID)
	}
	return out, nil
}

// CallPushArgs é o job que avisa UMA inscrição de uma chamada recebida. Só vale até ExpiresAt (a chamada toca
// por 45 s); depois disso o worker descarta.
type CallPushArgs struct {
	SubscriptionID int64  `json:"subscription_id"`
	ChannelID      int64  `json:"channel_id"`
	CallerName     string `json:"caller_name"`
	ExpiresAt      int64  `json:"expires_at" doc:"unix, segundos"`
}

func (CallPushArgs) Kind() string { return "push_call" }
func (CallPushArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueuePush, MaxAttempts: 2}
}

// CallPushQueue enfileira os pushes de chamada (o Enqueuer do River implementa).
type CallPushQueue interface {
	EnqueueCallPush(ctx context.Context, args []CallPushArgs) error
}

// EnqueueCallPush implementa CallPushQueue sobre o River.
func (e *Enqueuer) EnqueueCallPush(ctx context.Context, args []CallPushArgs) error {
	c := e.client.Load()
	if c == nil || len(args) == 0 {
		return nil
	}
	params := make([]river.InsertManyParams, len(args))
	for i, a := range args {
		params[i] = river.InsertManyParams{Args: a}
	}
	if _, err := c.InsertMany(ctx, params); err != nil {
		return fmt.Errorf("enfileirar push de chamada: %w", err)
	}
	return nil
}

// PushCall avisa por Web Push quem recebeu a chamada e está sem sessão de gateway ativa (quem está com o app
// aberto já ouve o toque pelo gateway). recipients já passou por CallRecipients. Falhas só vão para o log.
func (s *Service) PushCall(ctx context.Context, callerName string, channelID int64, recipients []int64, expires time.Time) {
	ctx, span := tracer.Start(ctx, "notification.PushCall")
	defer span.End()
	q, ok := s.Queue.(CallPushQueue)
	if !s.PushEnabled() || !ok || len(recipients) == 0 {
		return
	}
	offline := pushRecipients(recipients, func(id int64) bool { return s.Presence.Status(id) != presence.StatusOffline })
	if len(offline) == 0 {
		return
	}
	subs, err := s.Store.SubscriptionsOf(ctx, offline)
	if err != nil {
		slog.Warn("push de chamada: inscrições não carregadas", "channel", channelID, "err", err)
		return
	}
	args := make([]CallPushArgs, len(subs))
	for i, sub := range subs {
		args[i] = CallPushArgs{SubscriptionID: sub.ID, ChannelID: channelID, CallerName: callerName, ExpiresAt: expires.Unix()}
	}
	span.SetAttributes(attribute.Int("subscriptions", len(args)))
	if err := q.EnqueueCallPush(ctx, args); err != nil {
		slog.Warn("push de chamada não enfileirado", "channel", channelID, "err", err)
	}
}

// BuildCallPayload monta a notificação de chamada recebida.
func BuildCallPayload(callerName string, channelID int64) PushPayload {
	return PushPayload{
		Title: callerName, Body: "Chamada de voz recebida",
		URL: "/channels/@me/" + strconv.FormatInt(channelID, 10), Tag: "call:" + strconv.FormatInt(channelID, 10),
	}
}

// deliverCall envia o push de chamada de UMA inscrição. Mesma classificação de resultados do push de mensagens.
func (s *Service) deliverCall(ctx context.Context, a CallPushArgs) (string, error) {
	if time.Now().Unix() > a.ExpiresAt {
		return resSkipped, nil // a chamada já parou de tocar
	}
	sub, err := s.Store.Subscription(ctx, a.SubscriptionID)
	if errors.Is(err, ErrNotFound) {
		return resSkipped, nil
	}
	if err != nil {
		return resFailed, err
	}
	if s.Presence.Status(sub.UserID) != presence.StatusOffline {
		return resSkipped, nil // voltou a ficar online: ouve pelo gateway
	}
	status, err := s.Sender.Send(ctx, sub, BuildCallPayload(a.CallerName, a.ChannelID).JSON())
	switch {
	case errors.Is(err, ErrBlockedAddress):
		slog.Warn("push de chamada bloqueado (anti-SSRF): inscrição removida", "subscription", sub.ID)
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

// CallPushWorker entrega o push de chamada.
type CallPushWorker struct {
	river.WorkerDefaults[CallPushArgs]
	svc *Service
}

func (w *CallPushWorker) Work(ctx context.Context, job *river.Job[CallPushArgs]) error {
	ctx, span := tracer.Start(ctx, "notification.push_call")
	defer span.End()
	res, err := w.svc.deliverCall(ctx, job.Args)
	if err != nil && errors.Is(err, errPermanent) {
		err = river.JobCancel(err)
	}
	if err != nil {
		slog.Warn("push de chamada falhou", "subscription", job.Args.SubscriptionID, "err", err)
	}
	span.SetAttributes(attribute.String("job.result", res))
	return err
}
