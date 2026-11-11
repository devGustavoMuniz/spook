package voice

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
)

// screenHeightSlack é a folga sobre o limite de altura antes de a faixa contar como excedente: janelas e monitores
// que não dividem certo para 720/1080/1440 chegam alguns pixels acima do pedido, e isso não é burla.
const screenHeightSlack = 10 // por cento

// enforceScreenLimit confere, em track_published de tela, se a altura informada passa do limite do plano de quem
// publicou; se passar, silencia a faixa no LiveKit e registra. É melhor esforço e NUNCA derruba a chamada nem
// devolve erro: o limite de verdade é o clamp do cliente (com `limits` do token). Só age com NITRO_ENFORCE_SCREEN
// ligado: clientes antigos (sem o clamp) compartilham em 1080p e a faixa silenciada deixa os espectadores
// carregando para sempre.
//
// Limitações: o webhook traz a largura e a altura que o cliente declarou ao publicar, mas não a taxa de quadros,
// então os 30/60 fps não são conferidos aqui; um cliente adulterado pode declarar menos do que envia, e quem
// reconectar a faixa pode desmutá-la. Sem LiveKit com dimensões no webhook (altura 0), nada é feito.
func (s *Service) enforceScreenLimit(ctx context.Context, ev RoomEvent) {
	if !s.enforceScreen || s.plans == nil || ev.Type != EventTrackPublished || ev.Source != SourceScreenShare || ev.TrackHeight <= 0 || ev.TrackSID == "" {
		return
	}
	userID, ok := parseID(ev.Identity)
	if !ok {
		return
	}
	tier, err := s.plans.Tier(ctx, userID)
	if err != nil {
		slog.WarnContext(ctx, "voice: não foi possível conferir o plano da faixa de tela", "user", userID, "err", err)
		return
	}
	limit := plan.For(tier).ScreenMaxHeight
	if ev.TrackHeight <= limit+limit*screenHeightSlack/100 {
		return
	}
	rctx, cancel := remote(ctx)
	defer cancel()
	attrs := metric.WithAttributes(attribute.String("tier", string(tier)))
	if err := s.prov.MuteTrack(rctx, ev.Room, ev.Identity, ev.TrackSID); err != nil {
		s.met.planEnforced.Add(ctx, 1, metric.WithAttributes(attribute.String("tier", string(tier)), attribute.String("result", "mute_failed")))
		slog.WarnContext(ctx, "voice: não foi possível silenciar a tela acima do plano", "user", userID, "track", ev.TrackSID, "err", err)
		return
	}
	s.met.planEnforced.Add(ctx, 1, attrs)
	slog.InfoContext(ctx, "voice: tela acima do limite do plano silenciada", "user", userID, "channel", ev.Room, "track", ev.TrackSID,
		"tier", string(tier), "height", ev.TrackHeight, "limit", limit)
}
