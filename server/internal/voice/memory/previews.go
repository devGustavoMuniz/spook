package memory

import (
	"sync"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

// Previews é o adaptador em memória da porta voice.PreviewStore: uma prévia por usuário, com teto
// de quantidade e de bytes. Sem goroutine própria: a varredura é chamada por quem usa (Service.Run).
type Previews struct {
	mu       sync.Mutex
	items    map[int64]voice.Preview
	bytes    int
	maxCount int
	maxBytes int
}

var _ voice.PreviewStore = (*Previews)(nil)

// NewPreviews cria o armazém com os tetos padrão do domínio.
func NewPreviews() *Previews {
	return NewPreviewsWithLimits(voice.PreviewMaxCount, voice.PreviewMaxTotalBytes)
}

// NewPreviewsWithLimits permite tetos menores (testes).
func NewPreviewsWithLimits(maxCount, maxBytes int) *Previews {
	return &Previews{items: map[int64]voice.Preview{}, maxCount: maxCount, maxBytes: maxBytes}
}

func (s *Previews) Put(p voice.Preview, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, had := s.items[p.UserID]
	if had {
		s.bytes -= len(old.Data)
		delete(s.items, p.UserID)
	}
	if len(s.items)+1 > s.maxCount || s.bytes+len(p.Data) > s.maxBytes {
		if had { // mantém a anterior: melhor uma prévia velha que nenhuma
			s.items[p.UserID] = old
			s.bytes += len(old.Data)
		}
		return voice.ErrPreviewCapacity
	}
	s.items[p.UserID] = p
	s.bytes += len(p.Data)
	return nil
}

func (s *Previews) Get(userID, channelID int64, now time.Time) (voice.Preview, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[userID]
	if !ok || p.ChannelID != channelID || !now.Before(p.ExpiresAt) {
		return voice.Preview{}, false
	}
	return p, true
}

func (s *Previews) Delete(userID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[userID]
	if ok {
		s.bytes -= len(p.Data)
		delete(s.items, userID)
	}
	return ok
}

func (s *Previews) Sweep(now time.Time) []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sweepLocked(now)
}

func (s *Previews) sweepLocked(now time.Time) []int64 {
	var out []int64
	for id, p := range s.items {
		if !now.Before(p.ExpiresAt) {
			s.bytes -= len(p.Data)
			delete(s.items, id)
			out = append(out, id)
		}
	}
	return out
}

func (s *Previews) Stats() (count, bytes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.items), s.bytes
}
