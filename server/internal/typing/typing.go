// Package typing publica o indicador "digitando…" (RF08.2). Não persiste nada: cada chamada vira
// um TYPING_START em channel:<id>, com throttle por usuário e canal; o fim (8 s sem novo evento)
// é decidido pelo cliente.
package typing

import (
	"context"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

var tracer = otel.Tracer("spook/typing")

// Throttle é o intervalo mínimo entre dois TYPING_START do mesmo usuário no mesmo canal.
const Throttle = 3 * time.Second

// StartPayload é o dado do evento TYPING_START.
type StartPayload struct {
	ChannelID string  `json:"channel_id"`
	GuildID   *string `json:"guild_id"`
	UserID    string  `json:"user_id"`
	Timestamp int64   `json:"timestamp" doc:"Unix, em segundos"`
}

// Channels é o que typing precisa de channel: autorização de acesso ao canal (servidor ou DM).
type Channels interface {
	Authorize(ctx context.Context, userID, channelID int64, need perm.Perm) (channel.Channel, perm.Member, error)
}

// Limiter é o throttle (token bucket de 1 permissão a cada Throttle).
type Limiter interface {
	Take(key string) (ok bool, retryAfter time.Duration)
}

type Service struct {
	channels Channels
	limiter  Limiter
	pub      events.Publisher
	now      func() time.Time
	started  metric.Int64Counter
}

func NewService(channels Channels, limiter Limiter, pub events.Publisher) *Service {
	s := &Service{channels: channels, limiter: limiter, pub: pub, now: time.Now}
	s.started, _ = otel.Meter("spook/typing").Int64Counter("spook.typing.started",
		metric.WithDescription("TYPING_START publicados (depois do throttle)"))
	return s
}

// Start publica TYPING_START se o usuário pode escrever no canal (ou é participante da DM) e o
// throttle deixa. Excedente é ignorado sem erro; published diz se o evento saiu.
func (s *Service) Start(ctx context.Context, userID, channelID int64) (published bool, err error) {
	ctx, span := tracer.Start(ctx, "typing.Start")
	defer span.End()
	ch, _, err := s.channels.Authorize(ctx, userID, channelID, perm.SendMessages)
	if err != nil {
		return false, err
	}
	if ch.Type != channel.TypeText && !ch.IsDM() {
		return false, apperr.Invalid("só canais de texto e DMs têm o indicador de digitação")
	}
	if ok, _ := s.limiter.Take("typing:" + strconv.FormatInt(userID, 10) + ":" + strconv.FormatInt(channelID, 10)); !ok {
		span.SetAttributes(attribute.Bool("throttled", true))
		return false, nil
	}
	var gid int64
	if ch.GuildID != nil {
		gid = *ch.GuildID
	}
	s.pub.Publish(events.Event{
		Type: events.TypingStart, GuildID: gid, ChannelID: channelID,
		Topics: []string{"channel:" + strconv.FormatInt(channelID, 10)},
		Data: StartPayload{
			ChannelID: httpx.ID(channelID), GuildID: httpx.IDPtr(ch.GuildID), UserID: httpx.ID(userID),
			Timestamp: s.now().Unix(),
		},
	})
	s.started.Add(ctx, 1)
	return true, nil
}
