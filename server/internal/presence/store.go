package presence

import (
	"context"
	"fmt"

	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

type PGStore struct{ q *dbgen.Queries }

func NewStore(d dbgen.DBTX) *PGStore { return &PGStore{q: dbgen.New(d)} }

func (s *PGStore) Audience(ctx context.Context, userID int64) ([]int64, []int64, error) {
	guilds, err := s.q.ListUserGuildIDs(ctx, userID)
	if err != nil {
		return nil, nil, fmt.Errorf("listar servidores do usuário: %w", err)
	}
	peers, err := s.q.ListDMPeerIDs(ctx, userID)
	if err != nil {
		return nil, nil, fmt.Errorf("listar pares de DM: %w", err)
	}
	return guilds, peers, nil
}

func (s *PGStore) OnlineSharing(ctx context.Context, userID int64, online []int64) ([]int64, error) {
	ids, err := s.q.ListOnlineSharing(ctx, dbgen.ListOnlineSharingParams{UserID: userID, Column2: online})
	if err != nil {
		return nil, fmt.Errorf("cruzar online com servidores e DMs: %w", err)
	}
	return ids, nil
}

func (s *PGStore) OnlineGuildMembers(ctx context.Context, guildID int64, online []int64) ([]int64, error) {
	ids, err := s.q.ListOnlineGuildMembers(ctx, dbgen.ListOnlineGuildMembersParams{GuildID: guildID, Column2: online})
	if err != nil {
		return nil, fmt.Errorf("cruzar online com membros: %w", err)
	}
	return ids, nil
}
