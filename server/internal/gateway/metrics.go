package gateway

import (
	"context"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const meterName = "spook/gateway"

// metrics são os instrumentos do gateway (no-op sem MeterProvider configurado). Os gauges leem
// contadores atômicos, então não custam nada no caminho quente.
type metrics struct {
	conns, sessions atomic.Int64
	slowN           atomic.Int64 // espelho do contador de consumidores lentos (testes)

	dispatched   metric.Int64Counter
	resumes      metric.Int64Counter
	invalid      metric.Int64Counter
	slowClosed   metric.Int64Counter
	latency      metric.Float64Histogram
	identifyTime metric.Float64Histogram
}

func newMetrics() *metrics {
	m := &metrics{}
	meter := otel.Meter(meterName)
	// Os erros de criação de instrumento só ocorrem com nomes inválidos; ficam no no-op.
	_, _ = meter.Int64ObservableGauge("spook.gateway.connections",
		metric.WithDescription("Conexões WebSocket ativas"),
		metric.WithInt64Callback(func(_ context.Context, o metric.Int64Observer) error {
			o.Observe(m.conns.Load())
			return nil
		}))
	_, _ = meter.Int64ObservableGauge("spook.gateway.sessions",
		metric.WithDescription("Sessões vivas (com ou sem socket, dentro da janela de resume)"),
		metric.WithInt64Callback(func(_ context.Context, o metric.Int64Observer) error {
			o.Observe(m.sessions.Load())
			return nil
		}))
	m.dispatched, _ = meter.Int64Counter("spook.gateway.events.dispatched",
		metric.WithDescription("Eventos entregues às filas das sessões"))
	m.resumes, _ = meter.Int64Counter("spook.gateway.resumes",
		metric.WithDescription("Resumes de sessão"))
	m.invalid, _ = meter.Int64Counter("spook.gateway.invalid_sessions",
		metric.WithDescription("Resumes recusados (op 9)"))
	m.slowClosed, _ = meter.Int64Counter("spook.gateway.slow_consumer_closes",
		metric.WithDescription("Conexões fechadas por consumidor lento"))
	m.latency, _ = meter.Float64Histogram("spook.gateway.publish_to_write.duration",
		metric.WithDescription("Latência da publicação do evento até a escrita no socket"),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1))
	m.identifyTime, _ = meter.Float64Histogram("spook.gateway.identify.duration",
		metric.WithDescription("Tempo do IDENTIFY até o READY escrito"),
		metric.WithUnit("s"))
	return m
}

func (m *metrics) slowClose() {
	m.slowN.Add(1)
	m.slowClosed.Add(context.Background(), 1)
}

func (m *metrics) observeLatency(ctx context.Context, since time.Time, eventType string) {
	if since.IsZero() {
		return
	}
	m.latency.Record(ctx, time.Since(since).Seconds(), metric.WithAttributes(attribute.String("event", eventType)))
}
