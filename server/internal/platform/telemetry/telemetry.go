// Package telemetry configura o OpenTelemetry (traces e métricas via OTLP/gRPC).
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// metricInterval é o intervalo de exportação das métricas (o padrão do SDK é 60 s).
const metricInterval = 15 * time.Second

// Setup registra o TracerProvider e o MeterProvider globais (mesmo endpoint OTLP) e liga as
// métricas de runtime do Go. Sem endpoint, a telemetria fica desligada (no-op, os instrumentos
// do pacote otel viram no-op) e o shutdown retornado não faz nada.
func Setup(ctx context.Context, endpoint, service string) (shutdown func(context.Context) error, err error) {
	if endpoint == "" {
		return func(context.Context) error { return nil }, nil
	}

	res, err := resource.New(ctx, resource.WithAttributes(semconv.ServiceName(service)))
	if err != nil {
		return nil, fmt.Errorf("criar resource: %w", err)
	}

	texp, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("criar exporter OTLP: %w", err)
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(texp), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	mexp, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(endpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		_ = tp.Shutdown(ctx)
		return nil, fmt.Errorf("criar exporter OTLP de métricas: %w", err)
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(mexp, sdkmetric.WithInterval(metricInterval))),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(mp)
	if err := runtime.Start(runtime.WithMeterProvider(mp)); err != nil {
		_ = tp.Shutdown(ctx)
		_ = mp.Shutdown(ctx)
		return nil, fmt.Errorf("métricas de runtime: %w", err)
	}

	return func(ctx context.Context) error {
		return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx))
	}, nil
}
