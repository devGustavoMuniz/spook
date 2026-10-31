package attachment

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

// metrics são os instrumentos de uploads e thumbnails (no-op sem MeterProvider).
type metrics struct {
	uploads        metric.Int64Counter
	uploadBytes    metric.Int64Counter
	rejected       metric.Int64Counter
	thumbJobs      metric.Int64Counter
	thumbDuration  metric.Float64Histogram
	orphansDeleted metric.Int64Counter
}

func newMetrics() *metrics {
	m := otel.Meter("spook/attachment")
	x := &metrics{}
	x.uploads, _ = m.Int64Counter("spook.uploads.requested", metric.WithDescription("URLs de upload pedidas"))
	x.uploadBytes, _ = m.Int64Counter("spook.uploads.requested.bytes", metric.WithUnit("By"),
		metric.WithDescription("Soma dos tamanhos declarados nos pedidos de upload"))
	x.rejected, _ = m.Int64Counter("spook.uploads.rejected", metric.WithDescription("Pedidos de upload ou anexos de mensagem recusados (por motivo)"))
	x.thumbJobs, _ = m.Int64Counter("spook.thumbnail.jobs", metric.WithDescription("Jobs de thumbnail terminados (por resultado: ok, discarded, error)"))
	x.thumbDuration, _ = m.Float64Histogram("spook.thumbnail.job.duration", metric.WithUnit("s"),
		metric.WithDescription("Duração do job de thumbnail (download, decodificação, resize, upload e gravação)"),
		metric.WithExplicitBucketBoundaries(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30))
	x.orphansDeleted, _ = m.Int64Counter("spook.uploads.orphans.deleted", metric.WithDescription("Anexos órfãos apagados pelo job de limpeza"))
	return x
}
