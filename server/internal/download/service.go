// Package download serve o último release do app desktop (consultado no GitHub, com cache em memória).
// Sem banco e sem goroutine em segundo plano: a busca é preguiçosa, feita na requisição que encontra o cache vencido.
package download

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"golang.org/x/sync/singleflight"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

const (
	// TTL é por quanto tempo uma busca bem-sucedida vale sem consultar o GitHub de novo.
	TTL = 5 * time.Minute
	// StaleMax é por quanto tempo o último resultado bom ainda é servido se o GitHub falhar.
	StaleMax = 24 * time.Hour
)

var (
	tracer = otel.Tracer("spook/download")
	meter  = otel.Meter("spook/download")
)

// Outcome é o rótulo do contador spook.download.requests.
type Outcome string

const (
	OutcomeHit   Outcome = "hit"   // cache fresco
	OutcomeMiss  Outcome = "miss"  // buscou no GitHub
	OutcomeStale Outcome = "stale" // GitHub falhou; serviu o último bom
	OutcomeError Outcome = "error" // GitHub falhou e não havia cache
)

// ErrNotFound: ainda não há versão publicada (404 do GitHub ou release sem instaladores do app).
var ErrNotFound = apperr.NotFound("ainda não há versão publicada")

// ErrUnavailable: o GitHub falhou e não há cache. Mensagem genérica, sem detalhes.
var ErrUnavailable = apperr.Unavailable("não foi possível consultar a versão agora; tente de novo em instantes")

type entry struct {
	release *Release // nil = sem versão publicada
	etag    string   // ETag do GitHub
	at      time.Time
}

// Service guarda o último release em memória.
type Service struct {
	src      Source
	pageURL  string
	now      func() time.Time
	requests metric.Int64Counter

	mu    sync.Mutex
	cache *entry
	group singleflight.Group
}

// NewService cria o service. pageURL é a página de releases usada quando o release não traz link.
func NewService(src Source, pageURL string) *Service {
	c, _ := meter.Int64Counter("spook.download.requests",
		metric.WithDescription("Consultas ao último release do desktop, por resultado (hit, miss, stale, error)"))
	return &Service{src: src, pageURL: pageURL, now: time.Now, requests: c}
}

// Latest devolve o último release. Erros: ErrNotFound (404) e ErrUnavailable (503).
func (s *Service) Latest(ctx context.Context) (*Release, error) {
	ctx, span := tracer.Start(ctx, "download.latest")
	defer span.End()
	rel, outcome, err := s.latest(ctx)
	span.SetAttributes(attribute.String("download.outcome", string(outcome)))
	if outcome == OutcomeError {
		span.SetStatus(codes.Error, "github indisponível")
	}
	s.requests.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", string(outcome))))
	return rel, err
}

func (s *Service) latest(ctx context.Context) (*Release, Outcome, error) {
	s.mu.Lock()
	c := s.cache
	s.mu.Unlock()
	if c != nil && s.now().Sub(c.at) < TTL {
		return wrap(c, OutcomeHit)
	}

	// Uma busca por vez; quem chega junto espera o mesmo resultado. O contexto é desacoplado do primeiro
	// chamador (se ele desistir, os outros não herdam o cancelamento); o cliente HTTP tem timeout próprio.
	fctx := context.WithoutCancel(ctx)
	v, err, _ := s.group.Do("latest", func() (any, error) { return s.refresh(fctx) })
	if err == nil {
		return wrap(v.(*entry), OutcomeMiss)
	}

	s.mu.Lock()
	c = s.cache
	s.mu.Unlock()
	if c != nil && s.now().Sub(c.at) < StaleMax {
		slog.WarnContext(ctx, "download: GitHub falhou; servindo o último release em cache", "age", s.now().Sub(c.at).Round(time.Second), "err", err)
		return wrap(c, OutcomeStale)
	}
	slog.ErrorContext(ctx, "download: GitHub falhou e não há cache", "err", err)
	return nil, OutcomeError, ErrUnavailable
}

func wrap(c *entry, o Outcome) (*Release, Outcome, error) {
	if c.release == nil {
		return nil, o, ErrNotFound
	}
	return c.release, o, nil
}

func (s *Service) refresh(ctx context.Context) (*entry, error) {
	s.mu.Lock()
	prev := s.cache
	s.mu.Unlock()
	etag := ""
	if prev != nil {
		etag = prev.etag
	}
	body, newETag, notModified, err := s.src.Latest(ctx, etag)
	var e *entry
	switch {
	case errors.Is(err, ErrNoRelease):
		e = &entry{at: s.now()}
	case err != nil:
		return nil, err
	case notModified && prev != nil:
		e = &entry{release: prev.release, etag: prev.etag, at: s.now()}
	case notModified:
		return nil, errors.New("304 sem cache anterior")
	default:
		rel, perr := parseRelease(body, s.pageURL)
		if perr != nil {
			return nil, perr
		}
		e = &entry{release: rel, etag: newETag, at: s.now()}
	}
	s.mu.Lock()
	s.cache = e
	s.mu.Unlock()
	return e, nil
}
