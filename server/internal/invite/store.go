package invite

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
	"github.com/devGustavoMuniz/spook/server/internal/platform/limits"
)

type PGStore struct {
	db  db.DB
	q   *dbgen.Queries
	lim limits.Limits
}

func NewStore(d db.DB) *PGStore { return &PGStore{db: d, q: dbgen.New(d), lim: limits.Default()} }

// WithLimits troca os limites de domínio (LIMIT_*); o padrão é o do SPEC.
func (s *PGStore) WithLimits(l limits.Limits) *PGStore { s.lim = l.Normalize(); return s }

// Count devolve os convites ainda válidos do servidor.
func (s *PGStore) Count(ctx context.Context, guildID int64) (int, error) {
	n, err := s.q.CountInvitesByGuild(ctx, guildID)
	if err != nil {
		return 0, fmt.Errorf("contar convites: %w", err)
	}
	return int(n), nil
}

// FindReusable devolve um convite reaproveitável do criador no servidor.
func (s *PGStore) FindReusable(ctx context.Context, guildID, creatorID int64) (Invite, error) {
	r, err := s.q.FindReusableInvite(ctx, dbgen.FindReusableInviteParams{GuildID: guildID, CreatorID: creatorID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Invite{}, ErrNotFound
	}
	if err != nil {
		return Invite{}, fmt.Errorf("buscar convite reaproveitável: %w", err)
	}
	return toInvite(r), nil
}

func ts(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}

func toInvite(r dbgen.Invite) Invite {
	return Invite{
		Code: r.Code, GuildID: r.GuildID, CreatorID: r.CreatorID, MaxUses: r.MaxUses, Uses: r.Uses,
		ExpiresAt: ts(r.ExpiresAt), CreatedAt: r.CreatedAt.Time,
	}
}

func (s *PGStore) Create(ctx context.Context, i Invite) (Invite, error) {
	p := dbgen.InsertInviteParams{Code: i.Code, GuildID: i.GuildID, CreatorID: i.CreatorID, MaxUses: i.MaxUses}
	if i.ExpiresAt != nil {
		p.ExpiresAt = pgtype.Timestamptz{Time: *i.ExpiresAt, Valid: true}
	}
	r, err := s.q.InsertInvite(ctx, p)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return Invite{}, ErrCodeTaken
	}
	if err != nil {
		return Invite{}, fmt.Errorf("criar convite: %w", err)
	}
	return toInvite(r), nil
}

func (s *PGStore) Get(ctx context.Context, code string) (Invite, error) {
	r, err := s.q.GetInvite(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return Invite{}, ErrNotFound
	}
	if err != nil {
		return Invite{}, fmt.Errorf("buscar convite: %w", err)
	}
	return toInvite(r), nil
}

func (s *PGStore) List(ctx context.Context, guildID int64) ([]Invite, error) {
	rows, err := s.q.ListInvitesByGuild(ctx, guildID)
	if err != nil {
		return nil, fmt.Errorf("listar convites: %w", err)
	}
	out := make([]Invite, len(rows))
	for i, r := range rows {
		out[i] = toInvite(r)
	}
	return out, nil
}

func (s *PGStore) Delete(ctx context.Context, code string) error {
	n, err := s.q.DeleteInvite(ctx, code)
	if err != nil {
		return fmt.Errorf("excluir convite: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PGStore) Preview(ctx context.Context, code string) (Preview, error) {
	r, err := s.q.GetInvitePreview(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preview{}, ErrNotFound
	}
	if err != nil {
		return Preview{}, fmt.Errorf("buscar convite: %w", err)
	}
	return Preview{
		Invite:    Invite{Code: r.Code, GuildID: r.GuildID, MaxUses: r.MaxUses, Uses: r.Uses, ExpiresAt: ts(r.ExpiresAt)},
		GuildName: r.GuildName, GuildIconKey: r.GuildIconKey, MemberCount: r.MemberCount,
	}, nil
}

// Redeem: o lock na linha do usuário serializa entradas simultâneas dele (checagem de membro e limite
// de servidores sem corrida); o UPDATE condicional consome o uso de forma atômica, então N usuários
// disputando o último uso de um convite resultam em exatamente um sucesso.
func (s *PGStore) Redeem(ctx context.Context, code string, userID int64) (RedeemResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RedeemResult{}, fmt.Errorf("iniciar transação: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	inv, err := q.GetInvite(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return RedeemResult{}, ErrNotFound
	}
	if err != nil {
		return RedeemResult{}, fmt.Errorf("buscar convite: %w", err)
	}
	if _, err := q.LockUser(ctx, userID); err != nil {
		return RedeemResult{}, fmt.Errorf("travar usuário: %w", err)
	}
	// Banido não entra por convite nenhum (checado dentro da transação, sem corrida com um banimento).
	banned, err := q.IsBanned(ctx, dbgen.IsBannedParams{GuildID: inv.GuildID, UserID: userID})
	if err != nil {
		return RedeemResult{}, fmt.Errorf("checar banimento: %w", err)
	}
	if banned {
		return RedeemResult{}, guild.ErrBanned
	}
	member, err := q.IsMember(ctx, dbgen.IsMemberParams{GuildID: inv.GuildID, UserID: userID})
	if err != nil {
		return RedeemResult{}, fmt.Errorf("checar membro: %w", err)
	}
	if member { // já é membro: não consome uso
		return RedeemResult{GuildID: inv.GuildID}, nil
	}
	count, err := q.CountGuildsByUser(ctx, userID)
	if err != nil {
		return RedeemResult{}, fmt.Errorf("contar servidores: %w", err)
	}
	if int(count) >= s.lim.GuildsPerUser {
		return RedeemResult{}, guild.TooManyGuilds(s.lim.GuildsPerUser)
	}
	// O lock do servidor serializa as entradas dele: o limite de membros vale mesmo com várias pessoas entrando juntas.
	if _, err := q.LockGuild(ctx, inv.GuildID); err != nil {
		return RedeemResult{}, fmt.Errorf("travar servidor: %w", err)
	}
	members, err := q.CountMembers(ctx, inv.GuildID)
	if err != nil {
		return RedeemResult{}, fmt.Errorf("contar membros: %w", err)
	}
	if int(members) >= s.lim.MembersPerGuild {
		return RedeemResult{}, guild.TooManyMembers(s.lim.MembersPerGuild)
	}
	n, err := q.UseInvite(ctx, code)
	if err != nil {
		return RedeemResult{}, fmt.Errorf("consumir convite: %w", err)
	}
	if n == 0 {
		return RedeemResult{}, ErrGone
	}
	if _, err := q.InsertMember(ctx, dbgen.InsertMemberParams{GuildID: inv.GuildID, UserID: userID}); err != nil {
		return RedeemResult{}, fmt.Errorf("adicionar membro: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return RedeemResult{}, fmt.Errorf("confirmar transação: %w", err)
	}
	return RedeemResult{GuildID: inv.GuildID, Joined: true}, nil
}
