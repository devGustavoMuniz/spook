// Package memory é o adaptador em memória da porta voice.StateStore (SPEC 6: voice states só em
// memória, reconstruídos pelos webhooks e pelo reconciliador).
package memory

import (
	"sync"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

type Store struct {
	mu      sync.RWMutex
	states  map[int64]voice.State
	pending map[int64]voice.Pending
}

var _ voice.StateStore = (*Store)(nil)

func New() *Store {
	return &Store{states: map[int64]voice.State{}, pending: map[int64]voice.Pending{}}
}

func (s *Store) Get(userID int64) (voice.State, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.states[userID]
	return st, ok
}

func (s *Store) Put(st voice.State) {
	s.mu.Lock()
	s.states[st.UserID] = st
	s.mu.Unlock()
}

func (s *Store) Delete(userID int64) {
	s.mu.Lock()
	delete(s.states, userID)
	s.mu.Unlock()
}

func (s *Store) filter(keep func(voice.State) bool) []voice.State {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []voice.State
	for _, st := range s.states {
		if keep(st) {
			out = append(out, st)
		}
	}
	return out
}

func (s *Store) ByChannel(channelID int64) []voice.State {
	return s.filter(func(st voice.State) bool { return st.ChannelID == channelID })
}

func (s *Store) ByGuild(guildID int64) []voice.State {
	return s.filter(func(st voice.State) bool { return st.GuildID == guildID })
}

func (s *Store) ByChannels(ids []int64) []voice.State {
	set := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return s.filter(func(st voice.State) bool { _, ok := set[st.ChannelID]; return ok })
}

func (s *Store) ByGuilds(ids []int64) []voice.State {
	set := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return s.filter(func(st voice.State) bool { _, ok := set[st.GuildID]; return ok })
}

func (s *Store) Channels() []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := map[int64]struct{}{}
	var out []int64
	for _, st := range s.states {
		if _, ok := seen[st.ChannelID]; !ok {
			seen[st.ChannelID] = struct{}{}
			out = append(out, st.ChannelID)
		}
	}
	return out
}

func (s *Store) CountByKind() (guild, dm int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, st := range s.states {
		if st.GuildID == 0 {
			dm++
		} else {
			guild++
		}
	}
	return guild, dm
}

func (s *Store) SetPending(p voice.Pending) {
	s.mu.Lock()
	s.pending[p.UserID] = p
	// Poda oportunista: o mapa não cresce com tokens nunca usados.
	if len(s.pending) > 1024 {
		now := time.Now()
		for id, o := range s.pending {
			if now.After(o.ExpiresAt) {
				delete(s.pending, id)
			}
		}
	}
	s.mu.Unlock()
}

func (s *Store) GetPending(userID int64, now time.Time) (voice.Pending, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.pending[userID]
	if !ok || !now.Before(p.ExpiresAt) {
		return voice.Pending{}, false
	}
	return p, true
}

func (s *Store) ClearPending(userID int64) {
	s.mu.Lock()
	delete(s.pending, userID)
	s.mu.Unlock()
}
