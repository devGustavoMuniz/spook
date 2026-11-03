package voice

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// ErrNotInChannel: o alvo não está neste canal de voz agora.
var ErrNotInChannel = apperr.Conflict("esta pessoa não está neste canal de voz")

// Disconnect tira targetID do canal de voz channelID, a pedido de um moderador (DISCONNECT_MEMBERS + hierarquia,
// autorizados pela porta Access.Moderate). A pessoa pode entrar de novo: desconectar não é banir nem mutar.
func (s *Service) Disconnect(ctx context.Context, actorID, channelID, targetID int64) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	ctx, span := tracer.Start(ctx, "voice.Disconnect", trace.WithAttributes(attribute.Int64("channel.id", channelID)))
	defer span.End()
	guildID, err := s.access.Moderate(ctx, actorID, channelID, targetID)
	if err != nil {
		return err
	}
	unlock := s.lock(targetID)
	st, ok := s.store.Get(targetID)
	if !ok || st.ChannelID != channelID {
		unlock()
		return ErrNotInChannel
	}
	s.dropLocked(ctx, st, true)
	unlock()
	if s.audit != nil {
		name, err := s.users.Username(ctx, targetID)
		if err != nil {
			slog.Warn("voice: nome do alvo indisponível para a auditoria", "user", targetID, "err", err)
		}
		s.audit.Record(ctx, audit.Entry{
			GuildID: guildID, ActorID: actorID, Action: audit.VoiceDisconnect, TargetType: audit.TargetMember, TargetID: targetID,
			Changes: map[string]any{"target_name": name, "channel_id": httpx.ID(channelID)},
		})
	}
	return nil
}
