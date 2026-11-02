package memory

import (
	"errors"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

func TestStoreQueriesAndCounts(t *testing.T) {
	s := New()
	s.Put(voice.State{UserID: 1, ChannelID: 10, GuildID: 100})
	s.Put(voice.State{UserID: 2, ChannelID: 10, GuildID: 100})
	s.Put(voice.State{UserID: 3, ChannelID: 11, GuildID: 100})
	s.Put(voice.State{UserID: 4, ChannelID: 50})
	if len(s.ByChannel(10)) != 2 || len(s.ByGuild(100)) != 3 || len(s.ByChannels([]int64{50, 11})) != 2 || len(s.ByGuilds([]int64{100, 7})) != 3 {
		t.Fatal("consultas inesperadas")
	}
	if g, d := s.CountByKind(); g != 3 || d != 1 {
		t.Fatalf("contagem = %d/%d", g, d)
	}
	if len(s.Channels()) != 3 {
		t.Fatalf("canais = %v", s.Channels())
	}
	s.Put(voice.State{UserID: 1, ChannelID: 11, GuildID: 100}) // um estado por usuário
	if len(s.ByChannel(10)) != 1 || len(s.ByChannel(11)) != 2 {
		t.Fatal("Put deve substituir o estado do usuário")
	}
	s.Delete(1)
	if _, ok := s.Get(1); ok {
		t.Fatal("Delete")
	}
}

func TestPendingExpiry(t *testing.T) {
	s := New()
	now := time.Now()
	s.SetPending(voice.Pending{UserID: 1, ChannelID: 10, ExpiresAt: now.Add(time.Second)})
	if p, ok := s.GetPending(1, now); !ok || p.ChannelID != 10 {
		t.Fatal("pendente vivo")
	}
	if _, ok := s.GetPending(1, now.Add(2*time.Second)); ok {
		t.Fatal("pendente expirado deve sumir")
	}
	s.ClearPending(1)
	if _, ok := s.GetPending(1, now); ok {
		t.Fatal("ClearPending")
	}
}

func TestPreviewsLimitsExpiryAndReplace(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	s := NewPreviewsWithLimits(2, 100)
	mk := func(user int64, n int, ttl time.Duration) voice.Preview {
		return voice.Preview{UserID: user, ChannelID: 10, Data: make([]byte, n), ExpiresAt: now.Add(ttl)}
	}
	if err := s.Put(mk(1, 40, time.Minute), now); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(mk(2, 40, time.Second), now); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(mk(3, 10, time.Minute), now); !errors.Is(err, voice.ErrPreviewCapacity) { // quantidade
		t.Fatalf("teto de quantidade: %v", err)
	}
	if err := s.Put(mk(1, 90, time.Minute), now); !errors.Is(err, voice.ErrPreviewCapacity) { // 90+40 > 100
		t.Fatalf("teto de bytes: %v", err)
	}
	if c, b := s.Stats(); c != 2 || b != 80 {
		t.Fatalf("falha não pode mexer no armazém: %d/%d", c, b)
	}
	if err := s.Put(mk(1, 60, time.Minute), now); err != nil { // substituir devolve os bytes antigos
		t.Fatal(err)
	}
	if _, b := s.Stats(); b != 100 {
		t.Fatalf("bytes = %d", b)
	}
	if _, ok := s.Get(1, 11, now); ok {
		t.Fatal("canal diferente não deve achar a prévia")
	}
	later := now.Add(2 * time.Second)
	if _, ok := s.Get(2, 10, later); ok {
		t.Fatal("vencida deve sumir na leitura")
	}
	if got := s.Sweep(later); len(got) != 1 || got[0] != 2 {
		t.Fatalf("Sweep = %v", got)
	}
	if !s.Delete(1) || s.Delete(1) {
		t.Fatal("Delete deve dizer se havia prévia")
	}
	if c, b := s.Stats(); c != 0 || b != 0 {
		t.Fatalf("vazio = %d/%d", c, b)
	}
}
