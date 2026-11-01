package admin

import (
	"context"
	"sync"
	"time"
)

// cell guarda um valor calculado por load durante ttl e junta chamadas simultâneas numa só execução
// (singleflight). Erros não são guardados. A carga roda desvinculada do cancelamento de quem pediu,
// com timeout próprio: um cliente que desiste não derruba quem espera o mesmo resultado.
type cell[T any] struct {
	ttl time.Duration

	mu     sync.Mutex
	val    T
	at     time.Time
	ok     bool
	flight *flight[T]
}

type flight[T any] struct {
	done chan struct{}
	val  T
	at   time.Time
	err  error
}

const loadTimeout = 15 * time.Second

func (c *cell[T]) get(ctx context.Context, now func() time.Time, load func(context.Context) (T, error)) (T, time.Time, error) {
	c.mu.Lock()
	if c.ok && now().Sub(c.at) < c.ttl {
		v, at := c.val, c.at
		c.mu.Unlock()
		return v, at, nil
	}
	f := c.flight
	if f == nil {
		f = &flight[T]{done: make(chan struct{})}
		c.flight = f
		go func() {
			lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), loadTimeout)
			defer cancel()
			f.val, f.err = load(lctx)
			f.at = now()
			c.mu.Lock()
			if f.err == nil {
				c.val, c.at, c.ok = f.val, f.at, true
			}
			c.flight = nil
			c.mu.Unlock()
			close(f.done)
		}()
	}
	c.mu.Unlock()
	select {
	case <-f.done:
		return f.val, f.at, f.err
	case <-ctx.Done():
		var zero T
		return zero, time.Time{}, ctx.Err()
	}
}
