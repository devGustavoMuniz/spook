package presence

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

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

func (s *PGStore) Prefs(ctx context.Context, userID int64) (Prefs, error) {
	r, err := s.q.GetStatusPrefs(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Prefs{Pref: PrefOnline}, nil
	}
	if err != nil {
		return Prefs{}, fmt.Errorf("ler preferências de status: %w", err)
	}
	p := Prefs{Pref: r.StatusPref}
	if (r.CustomStatusText != nil && *r.CustomStatusText != "") || (r.CustomStatusEmoji != nil && *r.CustomStatusEmoji != "") {
		c := &CustomStatus{}
		if r.CustomStatusText != nil {
			c.Text = *r.CustomStatusText
		}
		if r.CustomStatusEmoji != nil {
			c.Emoji = *r.CustomStatusEmoji
		}
		if r.CustomStatusExpiresAt.Valid {
			t := r.CustomStatusExpiresAt.Time
			c.ExpiresAt = &t
		}
		p.Custom = c
	}
	return p, nil
}

func (s *PGStore) SetPrefs(ctx context.Context, userID int64, p Prefs) (bool, error) {
	arg := dbgen.SetStatusPrefsParams{ID: userID, StatusPref: p.Pref}
	if c := p.Custom; c != nil {
		arg.CustomStatusText, arg.CustomStatusEmoji = &c.Text, &c.Emoji
		if c.ExpiresAt != nil {
			arg.CustomStatusExpiresAt = pgtype.Timestamptz{Time: *c.ExpiresAt, Valid: true}
		}
	}
	n, err := s.q.SetStatusPrefs(ctx, arg)
	if err != nil {
		return false, fmt.Errorf("gravar preferências de status: %w", err)
	}
	return n > 0, nil
}
