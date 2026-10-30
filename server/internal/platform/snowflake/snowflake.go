// Package snowflake gera IDs de 64 bits ordenáveis no tempo (41 bits de ms, 10 de nó, 12 de sequência).
package snowflake

import (
	"fmt"
	"sync"
	"time"
)

// Epoch do Spook: 2026-01-01T00:00:00Z.
var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

const (
	nodeBits = 10
	seqBits  = 12
	maxNode  = 1<<nodeBits - 1
	seqMask  = 1<<seqBits - 1
)

type Generator struct {
	mu     sync.Mutex
	node   int64
	lastMS int64
	seq    int64
	now    func() time.Time
}

func New(node int64) (*Generator, error) {
	if node < 0 || node > maxNode {
		return nil, fmt.Errorf("nó %d fora do intervalo 0..%d", node, maxNode)
	}
	return &Generator{node: node, now: time.Now}, nil
}

func (g *Generator) Next() int64 {
	g.mu.Lock()
	defer g.mu.Unlock()

	ms := g.now().Sub(epoch).Milliseconds()
	if ms < g.lastMS { // relógio andou para trás: continua no último ms conhecido
		ms = g.lastMS
	}
	if ms == g.lastMS {
		g.seq = (g.seq + 1) & seqMask
		if g.seq == 0 { // sequência esgotada neste ms: avança para o próximo
			ms++
		}
	} else {
		g.seq = 0
	}
	g.lastMS = ms
	return ms<<(nodeBits+seqBits) | g.node<<seqBits | g.seq
}

// Time extrai o instante de criação embutido no ID.
func Time(id int64) time.Time {
	return epoch.Add(time.Duration(id>>(nodeBits+seqBits)) * time.Millisecond)
}
