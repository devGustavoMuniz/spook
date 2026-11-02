package guild

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

type PGStore struct {
	db db.DB
	q  *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{db: d, q: dbgen.New(d)} }

func toGuild(g dbgen.Guild) Guild {
	return Guild{ID: g.ID, Name: g.Name, IconKey: g.IconKey, OwnerID: g.OwnerID, CreatedAt: g.CreatedAt.Time}
}

func toRole(r dbgen.Role) Role {
	return Role{ID: r.ID, GuildID: r.GuildID, Name: r.Name, Color: r.Color, Position: r.Position, Permissions: perm.Perm(r.Permissions)}
}

func wrap(op string, err error) error { return fmt.Errorf("%s: %w", op, err) }

// Create cria servidor, @everyone, categoria, canais iniciais e o dono como membro, numa transação.
// O lock na linha do usuário serializa criações/entradas simultâneas do mesmo usuário (limite de 100).
func (s *PGStore) Create(ctx context.Context, n NewGuild) (Guild, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Guild{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	if _, err := q.LockUser(ctx, n.OwnerID); err != nil {
		return Guild{}, wrap("travar usuário", err)
	}
	count, err := q.CountGuildsByUser(ctx, n.OwnerID)
	if err != nil {
		return Guild{}, wrap("contar servidores", err)
	}
	if count >= MaxGuildsPerUser {
		return Guild{}, ErrTooManyGuilds
	}
	g, err := q.InsertGuild(ctx, dbgen.InsertGuildParams{ID: n.ID, Name: n.Name, OwnerID: n.OwnerID})
	if err != nil {
		return Guild{}, wrap("criar servidor", err)
	}
	if _, err := q.InsertRole(ctx, dbgen.InsertRoleParams{
		ID: n.ID, GuildID: n.ID, Name: "@everyone", Position: 0, Permissions: int64(n.EveryonePermissions),
	}); err != nil {
		return Guild{}, wrap("criar @everyone", err)
	}
	if _, err := q.InsertMember(ctx, dbgen.InsertMemberParams{GuildID: n.ID, UserID: n.OwnerID}); err != nil {
		return Guild{}, wrap("adicionar dono", err)
	}
	gid := n.ID
	for _, c := range []dbgen.InsertChannelParams{
		{ID: n.CategoryID, Type: 2, GuildID: &gid, Name: &n.CategoryName, Position: 0},
		{ID: n.TextID, Type: 0, GuildID: &gid, ParentID: &n.CategoryID, Name: &n.TextName, Position: 0},
		{ID: n.VoiceID, Type: 1, GuildID: &gid, ParentID: &n.CategoryID, Name: &n.VoiceName, Position: 1},
	} {
		if _, err := q.InsertChannel(ctx, c); err != nil {
			return Guild{}, wrap("criar canal inicial", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Guild{}, wrap("confirmar transação", err)
	}
	return toGuild(g), nil
}

func (s *PGStore) Get(ctx context.Context, id int64) (Guild, error) {
	g, err := s.q.GetGuild(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Guild{}, ErrNotFound
	}
	if err != nil {
		return Guild{}, wrap("buscar servidor", err)
	}
	return toGuild(g), nil
}

func (s *PGStore) ListByUser(ctx context.Context, userID int64) ([]Guild, error) {
	rows, err := s.q.ListGuildsByUser(ctx, userID)
	if err != nil {
		return nil, wrap("listar servidores", err)
	}
	out := make([]Guild, len(rows))
	for i, g := range rows {
		out[i] = toGuild(g)
	}
	return out, nil
}

func (s *PGStore) Update(ctx context.Context, id int64, name string, iconKey *string) (Guild, error) {
	g, err := s.q.UpdateGuild(ctx, dbgen.UpdateGuildParams{ID: id, Name: name, IconKey: iconKey})
	if errors.Is(err, pgx.ErrNoRows) {
		return Guild{}, ErrNotFound
	}
	if err != nil {
		return Guild{}, wrap("atualizar servidor", err)
	}
	return toGuild(g), nil
}

func (s *PGStore) Delete(ctx context.Context, id int64) error {
	n, err := s.q.DeleteGuild(ctx, id)
	if err != nil {
		return wrap("excluir servidor", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PGStore) Transfer(ctx context.Context, id, newOwner int64) error {
	if err := s.q.UpdateGuildOwner(ctx, dbgen.UpdateGuildOwnerParams{ID: id, OwnerID: newOwner}); err != nil {
		return wrap("transferir posse", err)
	}
	return nil
}

func (s *PGStore) Access(ctx context.Context, guildID, userID int64) (Access, error) {
	r, err := s.q.GetMemberAccess(ctx, dbgen.GetMemberAccessParams{ID: guildID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Access{}, perm.ErrNotMember
	}
	if err != nil {
		return Access{}, wrap("buscar permissões", err)
	}
	return Access{OwnerID: r.OwnerID, Perms: perm.Perm(r.Permissions), Highest: int(r.HighestPosition)}, nil
}

func (s *PGStore) AccessByUser(ctx context.Context, userID int64) (map[int64]Access, map[int64][]int64, error) {
	rows, err := s.q.ListAccessByUser(ctx, userID)
	if err != nil {
		return nil, nil, wrap("buscar permissões", err)
	}
	access := make(map[int64]Access, len(rows))
	for _, r := range rows {
		access[r.GuildID] = Access{OwnerID: r.OwnerID, Perms: perm.Perm(r.Permissions), Highest: int(r.HighestPosition)}
	}
	mr, err := s.q.ListMemberRolesByUser(ctx, userID)
	if err != nil {
		return nil, nil, wrap("buscar cargos do usuário", err)
	}
	roles := map[int64][]int64{}
	for _, r := range mr {
		roles[r.GuildID] = append(roles[r.GuildID], r.RoleID)
	}
	return access, roles, nil
}

func toMember(guildID, userID int64, nick *string, joined time.Time, username string, display, avatar, bio, pronouns, bannerKey *string, bannerColor *int32, roleIDs []int64) Member {
	return Member{
		GuildID: guildID, UserID: userID, Nickname: nick, JoinedAt: joined, Username: username,
		DisplayName: display, AvatarKey: avatar, Bio: bio, Pronouns: pronouns, BannerKey: bannerKey, BannerColor: bannerColor,
		RoleIDs: roleIDs,
	}
}

func (s *PGStore) Members(ctx context.Context, guildID, afterUserID int64, limit int) ([]Member, error) {
	rows, err := s.q.ListMembers(ctx, dbgen.ListMembersParams{GuildID: guildID, UserID: afterUserID, Limit: int32(limit)})
	if err != nil {
		return nil, wrap("listar membros", err)
	}
	out := make([]Member, len(rows))
	for i, r := range rows {
		out[i] = toMember(r.GuildID, r.UserID, r.Nickname, r.JoinedAt.Time, r.Username, r.DisplayName, r.AvatarKey, r.Bio, r.Pronouns, r.BannerKey, r.BannerColor, r.RoleIds)
	}
	return out, nil
}

func (s *PGStore) Member(ctx context.Context, guildID, userID int64) (Member, error) {
	r, err := s.q.GetMember(ctx, dbgen.GetMemberParams{GuildID: guildID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Member{}, ErrMemberNotFound
	}
	if err != nil {
		return Member{}, wrap("buscar membro", err)
	}
	return toMember(r.GuildID, r.UserID, r.Nickname, r.JoinedAt.Time, r.Username, r.DisplayName, r.AvatarKey, r.Bio, r.Pronouns, r.BannerKey, r.BannerColor, r.RoleIds), nil
}

func (s *PGStore) RemoveMember(ctx context.Context, guildID, userID int64) error {
	n, err := s.q.DeleteMember(ctx, dbgen.DeleteMemberParams{GuildID: guildID, UserID: userID})
	if err != nil {
		return wrap("remover membro", err)
	}
	if n == 0 {
		return ErrMemberNotFound
	}
	return nil
}

func (s *PGStore) Roles(ctx context.Context, guildID int64) ([]Role, error) {
	rows, err := s.q.ListRolesByGuild(ctx, guildID)
	if err != nil {
		return nil, wrap("listar cargos", err)
	}
	out := make([]Role, len(rows))
	for i, r := range rows {
		out[i] = toRole(r)
	}
	return out, nil
}

func (s *PGStore) RolesByGuilds(ctx context.Context, guildIDs []int64) (map[int64][]Role, error) {
	rows, err := s.q.ListRolesByGuilds(ctx, guildIDs)
	if err != nil {
		return nil, wrap("listar cargos", err)
	}
	out := map[int64][]Role{}
	for _, r := range rows {
		out[r.GuildID] = append(out[r.GuildID], toRole(r))
	}
	return out, nil
}

func (s *PGStore) Role(ctx context.Context, guildID, roleID int64) (Role, error) {
	r, err := s.q.GetRole(ctx, dbgen.GetRoleParams{ID: roleID, GuildID: guildID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, ErrRoleNotFound
	}
	if err != nil {
		return Role{}, wrap("buscar cargo", err)
	}
	return toRole(r), nil
}

func (s *PGStore) CreateRole(ctx context.Context, r Role) (Role, error) {
	row, err := s.q.InsertRole(ctx, dbgen.InsertRoleParams{
		ID: r.ID, GuildID: r.GuildID, Name: r.Name, Color: r.Color, Position: r.Position, Permissions: int64(r.Permissions),
	})
	if err != nil {
		return Role{}, wrap("criar cargo", err)
	}
	return toRole(row), nil
}

func (s *PGStore) UpdateRole(ctx context.Context, r Role) (Role, error) {
	row, err := s.q.UpdateRole(ctx, dbgen.UpdateRoleParams{
		ID: r.ID, GuildID: r.GuildID, Name: r.Name, Color: r.Color, Position: r.Position, Permissions: int64(r.Permissions),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, ErrRoleNotFound
	}
	if err != nil {
		return Role{}, wrap("atualizar cargo", err)
	}
	return toRole(row), nil
}

func (s *PGStore) DeleteRole(ctx context.Context, guildID, roleID int64) error {
	n, err := s.q.DeleteRole(ctx, dbgen.DeleteRoleParams{ID: roleID, GuildID: guildID})
	if err != nil {
		return wrap("excluir cargo", err)
	}
	if n == 0 {
		return ErrRoleNotFound
	}
	return nil
}

func (s *PGStore) AddMemberRole(ctx context.Context, guildID, userID, roleID int64) error {
	if _, err := s.q.InsertMemberRole(ctx, dbgen.InsertMemberRoleParams{GuildID: guildID, UserID: userID, RoleID: roleID}); err != nil {
		return wrap("atribuir cargo", err)
	}
	return nil
}

func (s *PGStore) RemoveMemberRole(ctx context.Context, guildID, userID, roleID int64) error {
	if _, err := s.q.DeleteMemberRole(ctx, dbgen.DeleteMemberRoleParams{GuildID: guildID, UserID: userID, RoleID: roleID}); err != nil {
		return wrap("remover cargo do membro", err)
	}
	return nil
}
