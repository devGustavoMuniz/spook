package admin

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
	"github.com/devGustavoMuniz/spook/server/internal/platform/snowflake"
)

type PGStore struct {
	db db.DB
	q  *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{db: d, q: dbgen.New(d)} }

var _ Store = (*PGStore)(nil)

func ts(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func (s *PGStore) IsAdmin(ctx context.Context, userID int64) (bool, error) {
	ok, err := s.q.AdminIsAdmin(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("ler is_admin: %w", err)
	}
	return ok, nil
}

func (s *PGStore) Promote(ctx context.Context, usernames []string) ([]string, error) {
	return s.q.AdminPromoteUsernames(ctx, usernames)
}

func (s *PGStore) Counts(ctx context.Context, now time.Time) (Counts, error) {
	r, err := s.q.AdminCounts(ctx, dbgen.AdminCountsParams{
		Since24h: ts(now.Add(-24 * time.Hour)), Since7d: ts(now.Add(-7 * 24 * time.Hour)),
		MinID24h: snowflake.MinID(now.Add(-24 * time.Hour)), MinID7d: snowflake.MinID(now.Add(-7 * 24 * time.Hour)),
	})
	if err != nil {
		return Counts{}, fmt.Errorf("contagens do painel: %w", err)
	}
	return Counts{
		UsersTotal: r.UsersTotal, Admins: r.Admins, UsersNew24h: r.UsersNew24h, UsersNew7d: r.UsersNew7d, Avatars: r.Avatars,
		GuildsTotal: r.GuildsTotal, GuildIcons: r.GuildIcons, Memberships: r.Memberships,
		TextChannels: r.TextChannels, VoiceChannels: r.VoiceChannels, Categories: r.Categories,
		DirectChats: r.DirectChats, GroupChats: r.GroupChats, Roles: r.Roles,
		InvitesActive: r.InvitesActive, InviteUses: r.InviteUses,
		Messages24h: r.Messages24h, Messages7d: r.Messages7d, Attachments: r.Attachments, AttachmentBytes: r.AttachmentBytes,
	}, nil
}

func (s *PGStore) MessageTotals(ctx context.Context) (MessageTotals, error) {
	r, err := s.q.AdminMessageTotals(ctx)
	if err != nil {
		return MessageTotals{}, fmt.Errorf("total de mensagens: %w", err)
	}
	return MessageTotals{Total: r.Total, InGuilds: r.InGuilds, InDMs: r.InDms}, nil
}

func day(d pgtype.Date) string { return d.Time.UTC().Format("2006-01-02") }

func (s *PGStore) UsersPerDay(ctx context.Context, since time.Time) (map[string]int64, error) {
	rows, err := s.q.AdminUsersPerDay(ctx, ts(since))
	if err != nil {
		return nil, fmt.Errorf("contas por dia: %w", err)
	}
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		out[day(r.Day)] = r.N
	}
	return out, nil
}

func (s *PGStore) MessagesPerDay(ctx context.Context, since time.Time) (map[string]int64, error) {
	rows, err := s.q.AdminMessagesPerDay(ctx, snowflake.MinID(since))
	if err != nil {
		return nil, fmt.Errorf("mensagens por dia: %w", err)
	}
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		out[day(r.Day)] = r.N
	}
	return out, nil
}

func (s *PGStore) DatabaseSize(ctx context.Context) (int64, error) {
	n, err := s.q.AdminDatabaseSize(ctx)
	if err != nil {
		return 0, fmt.Errorf("tamanho do banco: %w", err)
	}
	return n, nil
}

func (s *PGStore) LargestTables(ctx context.Context) ([]TableSize, error) {
	rows, err := s.q.AdminLargestTables(ctx)
	if err != nil {
		return nil, fmt.Errorf("maiores tabelas: %w", err)
	}
	out := make([]TableSize, len(rows))
	for i, r := range rows {
		out[i] = TableSize{Name: r.Name, Bytes: r.Bytes, RowsEstimate: r.RowsEstimate}
	}
	return out, nil
}

func (s *PGStore) Users(ctx context.Context, q ListQuery) (UserPage, error) {
	rows, err := s.q.AdminListUsers(ctx, dbgen.AdminListUsersParams{
		Q: q.Q, Sort: q.Sort, Dir: dir(q.Desc), PageOffset: int32(q.PageOffset), PageSize: int32(q.PageSize),
	})
	if err != nil {
		return UserPage{}, fmt.Errorf("listar usuários: %w", err)
	}
	var p UserPage
	for _, r := range rows {
		row := UserRow{
			ID: fmt.Sprint(r.ID), Username: r.Username, Email: r.Email, GuildsMember: r.GuildsMember,
			GuildsOwned: r.GuildsOwned, MessagesSent: r.MessagesSent, CreatedAt: r.CreatedAt.Time,
		}
		if r.LastActiveAt.Valid {
			t := r.LastActiveAt.Time
			row.LastActiveAt = &t
		}
		p.Items = append(p.Items, row)
		p.Total = r.Total
	}
	return p, nil
}

func (s *PGStore) Servers(ctx context.Context, q ListQuery) (ServerPage, error) {
	rows, err := s.q.AdminListGuilds(ctx, dbgen.AdminListGuildsParams{
		Q: q.Q, Sort: q.Sort, Dir: dir(q.Desc), PageOffset: int32(q.PageOffset), PageSize: int32(q.PageSize),
	})
	if err != nil {
		return ServerPage{}, fmt.Errorf("listar servidores: %w", err)
	}
	var p ServerPage
	for _, r := range rows {
		p.Items = append(p.Items, ServerRow{
			ID: fmt.Sprint(r.ID), Name: r.Name, Owner: r.Owner, Members: r.Members, Channels: r.Channels,
			Messages: r.Messages, InvitesActive: r.InvitesActive, CreatedAt: r.CreatedAt.Time,
		})
		p.Total = r.Total
	}
	return p, nil
}

func dir(desc bool) string {
	if desc {
		return "desc"
	}
	return "asc"
}

func (s *PGStore) Channels(ctx context.Context, ids []int64) (map[int64]ChannelInfo, error) {
	rows, err := s.q.AdminChannelInfo(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("canais das chamadas: %w", err)
	}
	out := make(map[int64]ChannelInfo, len(rows))
	for _, r := range rows {
		ci := ChannelInfo{DM: r.GuildID == nil}
		if r.Name != nil {
			ci.Name = *r.Name
		}
		if r.GuildName != nil {
			ci.GuildName = *r.GuildName
		}
		out[r.ID] = ci
	}
	return out, nil
}

func (s *PGStore) Usernames(ctx context.Context, ids []int64) (map[int64]string, error) {
	rows, err := s.q.AdminUsernames(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("usernames das chamadas: %w", err)
	}
	out := make(map[int64]string, len(rows))
	for _, r := range rows {
		out[r.ID] = r.Username
	}
	return out, nil
}

// JobCounts lê a tabela do River (fora do sqlc: ela vem das migrations do próprio River). Se a tabela
// não existe (River nunca migrado), ok=false.
func (s *PGStore) JobCounts(ctx context.Context) (JobCounts, bool, error) {
	rows, err := s.db.Query(ctx, `SELECT state::text, count(*)::bigint FROM river_job GROUP BY state`)
	if err != nil {
		if isUndefinedTable(err) {
			return JobCounts{}, false, nil
		}
		return JobCounts{}, false, fmt.Errorf("contar jobs: %w", err)
	}
	defer rows.Close()
	var jc JobCounts
	for rows.Next() {
		var state string
		var n int64
		if err := rows.Scan(&state, &n); err != nil {
			return JobCounts{}, false, fmt.Errorf("ler contagem de jobs: %w", err)
		}
		switch state {
		case "available":
			jc.Available = n
		case "running":
			jc.Running = n
		case "retryable":
			jc.Retryable = n
		case "discarded":
			jc.Discarded = n
		case "scheduled":
			jc.Scheduled = n
		}
	}
	if err := rows.Err(); err != nil {
		if isUndefinedTable(err) {
			return JobCounts{}, false, nil
		}
		return JobCounts{}, false, fmt.Errorf("contar jobs: %w", err)
	}
	return jc, true, nil
}

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

// ---- histórico e atividade ----

func (s *PGStore) InsertSample(ctx context.Context, m Sample) error {
	err := s.q.AdminInsertSample(ctx, dbgen.AdminInsertSampleParams{
		Ts: ts(m.TS), Media: m.Media, Rooms: m.Rooms, Participants: m.Participants,
		TracksPublished: m.TracksPublished, TracksSubscribed: m.TracksSubs,
		BytesIn: m.BytesIn, BytesOut: m.BytesOut, PacketsIn: m.PacketsIn, PacketsOut: m.PacketsOut,
		LossPct: m.LossPct, JitterMs: m.JitterMs, RttMs: m.RTTMs, OnlineUsers: m.OnlineUsers, Connections: m.Connections,
	})
	if err != nil {
		return fmt.Errorf("gravar amostra: %w", err)
	}
	return nil
}

func (s *PGStore) PurgeSamples(ctx context.Context, cutoff time.Time, batch int) (int64, error) {
	n, err := s.q.AdminPurgeSamples(ctx, dbgen.AdminPurgeSamplesParams{Cutoff: ts(cutoff), Batch: int32(batch)})
	if err != nil {
		return 0, fmt.Errorf("apagar amostras antigas: %w", err)
	}
	return n, nil
}

func (s *PGStore) SampleSeries(ctx context.Context, since time.Time, bucketSecs int) ([]SampleBucket, error) {
	rows, err := s.q.AdminSampleSeries(ctx, dbgen.AdminSampleSeriesParams{Since: ts(since), BucketSecs: int32(bucketSecs)})
	if err != nil {
		return nil, fmt.Errorf("série do LiveKit: %w", err)
	}
	out := make([]SampleBucket, len(rows))
	for i, r := range rows {
		out[i] = SampleBucket{
			Bucket: r.Bucket.Time, MediaSamples: int(r.MediaSamples), Samples: int(r.Samples),
			Rooms: int(r.RoomsMax), Participants: int(r.ParticipantsMax),
			TracksPublished: int(r.TracksPublishedMax), TracksSubscribed: int(r.TracksSubscribedMax),
			BytesOut: r.BytesOut, BytesIn: r.BytesIn, Packets: r.Packets, PeakOutBps: r.BytesOutPerSecPeak,
			LossPct: r.LossPctMax, JitterMs: r.JitterMsAvg, RTTMs: r.RttMsAvg,
			OnlineUsers: int(r.OnlineUsersMax), Connections: int(r.ConnectionsMax),
		}
	}
	return out, nil
}

func (s *PGStore) SampleTraffic(ctx context.Context, since time.Time) (Traffic, error) {
	r, err := s.q.AdminSampleTraffic(ctx, ts(since))
	if err != nil {
		return Traffic{}, fmt.Errorf("tráfego do LiveKit: %w", err)
	}
	return Traffic{BytesOut: r.BytesOut, BytesIn: r.BytesIn, PeakOutBps: r.PeakOutPerSec, Samples: r.Samples}, nil
}

// MessageHeatmap devolve as mensagens por dia da semana (0 = domingo) e hora UTC desde since.
func (s *PGStore) MessageHeatmap(ctx context.Context, since time.Time) ([7][24]int64, error) {
	var m [7][24]int64
	rows, err := s.q.AdminMessageHeatmap(ctx, snowflake.MinID(since))
	if err != nil {
		return m, fmt.Errorf("mapa de calor de mensagens: %w", err)
	}
	for _, r := range rows {
		d := int(r.Dow) % 7 // ISO 7 (domingo) → 0
		if h := int(r.Hour); h >= 0 && h < 24 {
			m[d][h] += r.N
		}
	}
	return m, nil
}

func (s *PGStore) TopGuilds(ctx context.Context, since time.Time, limit int) ([]TopGuild, error) {
	rows, err := s.q.AdminTopGuilds(ctx, dbgen.AdminTopGuildsParams{MinID: snowflake.MinID(since), MaxRows: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("maiores servidores: %w", err)
	}
	out := make([]TopGuild, len(rows))
	for i, r := range rows {
		out[i] = TopGuild{ID: r.ID, Name: r.Name, Messages: r.Messages, Members: r.Members}
	}
	return out, nil
}
