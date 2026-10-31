package voice

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

type metrics struct {
	tokensIssued metric.Int64Counter
	tokensDenied metric.Int64Counter
	webhooks     metric.Int64Counter
	evictions    metric.Int64Counter
	orphans      metric.Int64Counter
	tokenTime    metric.Float64Histogram
}

func newMetrics(store StateStore) *metrics {
	m := otel.Meter("spook/voice")
	x := &metrics{}
	x.tokensIssued, _ = m.Int64Counter("spook.voice.tokens.issued", metric.WithDescription("Tokens do LiveKit emitidos"))
	x.tokensDenied, _ = m.Int64Counter("spook.voice.tokens.denied", metric.WithDescription("Pedidos de token negados (por motivo)"))
	x.webhooks, _ = m.Int64Counter("spook.voice.webhooks", metric.WithDescription("Webhooks do LiveKit recebidos (por tipo)"))
	x.evictions, _ = m.Int64Counter("spook.voice.evictions", metric.WithDescription("Participantes removidos por perda de permissão"))
	x.orphans, _ = m.Int64Counter("spook.voice.reconcile.orphans", metric.WithDescription("Estados órfãos removidos pelo reconciliador"))
	x.tokenTime, _ = m.Float64Histogram("spook.voice.token.duration", metric.WithUnit("s"),
		metric.WithDescription("Latência da emissão de token (autorização + token)"))
	_, _ = m.Int64ObservableGauge("spook.voice.participants",
		metric.WithDescription("Participantes em voz agora, por tipo de canal"),
		metric.WithInt64Callback(func(_ context.Context, o metric.Int64Observer) error {
			g, d := store.CountByKind()
			o.Observe(int64(g), metric.WithAttributes(attribute.String("channel_type", "guild")))
			o.Observe(int64(d), metric.WithAttributes(attribute.String("channel_type", "dm")))
			return nil
		}))
	return x
}
