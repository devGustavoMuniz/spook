package notification

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

var tracer = otel.Tracer("spook/notification")

// metrics são os instrumentos de leitura, menções e push (no-op sem MeterProvider).
type metrics struct {
	acks          metric.Int64Counter
	mentions      metric.Int64Counter
	readStatesDur metric.Float64Histogram
	pushJobs      metric.Int64Counter
	pushDur       metric.Float64Histogram
	dropped       metric.Int64Counter
}

func newMetrics() *metrics {
	m := otel.Meter("spook/notification")
	x := &metrics{}
	x.acks, _ = m.Int64Counter("spook.readstate.acks", metric.WithDescription("Acks de leitura de canal"))
	x.mentions, _ = m.Int64Counter("spook.mentions.detected", metric.WithDescription("Usuários mencionados (resolvidos) nas mensagens enviadas"))
	x.readStatesDur, _ = m.Float64Histogram("spook.readstate.query.duration", metric.WithUnit("s"),
		metric.WithDescription("Duração da consulta de não lidas de um usuário (todos os canais)"),
		metric.WithExplicitBucketBoundaries(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1))
	x.pushJobs, _ = m.Int64Counter("spook.push.jobs", metric.WithDescription("Jobs de push terminados (por resultado: sent, removed, failed, skipped)"))
	x.pushDur, _ = m.Float64Histogram("spook.push.job.duration", metric.WithUnit("s"),
		metric.WithDescription("Duração do job de push (consultas e requisição ao serviço de push)"),
		metric.WithExplicitBucketBoundaries(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10))
	x.dropped, _ = m.Int64Counter("spook.notification.dropped", metric.WithDescription("MESSAGE_CREATE descartados por fila cheia ou erro no processamento"))
	return x
}
