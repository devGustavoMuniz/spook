package memory

import (
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
