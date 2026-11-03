package guild

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

type recorder struct {
	mu  sync.Mutex
	evs []events.Event
}

func (r *recorder) Publish(e events.Event) { r.mu.Lock(); r.evs = append(r.evs, e); r.mu.Unlock() }

func (r *recorder) types() []string {
	var out []string
	for _, e := range r.evs {
		out = append(out, e.Type)
	}
	return out
}

func (r *recorder) last() events.Event { return r.evs[len(r.evs)-1] }

// fakeStore guarda só o que os testes de regra precisam; o resto do contrato fica nil (panic se usado).
type fakeStore struct {
	Store
	guild      Guild
	members    map[int64]Access // userID -> acesso
	roles      map[int64]Role
	memRoles   map[int64]map[int64]bool
	created    *NewGuild
	tooMany    bool
	sysChannel int64
	removed    []int64
}

func newFake() *fakeStore {
	return &fakeStore{
		guild:    Guild{ID: 1, Name: "G", OwnerID: 1, SystemJoinEnabled: true},
		members:  map[int64]Access{},
		roles:    map[int64]Role{1: {ID: 1, GuildID: 1, Name: "@everyone", Permissions: perm.DefaultEveryone}},
		memRoles: map[int64]map[int64]bool{},
	}
}

func (f *fakeStore) Create(_ context.Context, n NewGuild) (Guild, error) {
	if f.tooMany {
		return Guild{}, ErrTooManyGuilds
	}
	f.created = &n
	f.guild = Guild{ID: n.ID, Name: n.Name, OwnerID: n.OwnerID}
	f.members[n.OwnerID] = Access{OwnerID: n.OwnerID, Perms: n.EveryonePermissions}
	return f.guild, nil
}
func (f *fakeStore) Get(context.Context, int64) (Guild, error) { return f.guild, nil }
func (f *fakeStore) Access(_ context.Context, _, userID int64) (Access, error) {
	a, ok := f.members[userID]
	if !ok {
		return Access{}, perm.ErrNotMember
	}
	a.OwnerID = f.guild.OwnerID
	return a, nil
}
func (f *fakeStore) Member(_ context.Context, g, u int64) (Member, error) {
	if _, ok := f.members[u]; !ok {
		return Member{}, ErrMemberNotFound
	}
	m := Member{GuildID: g, UserID: u, Username: "u"}
	for r := range f.memRoles[u] {
		m.RoleIDs = append(m.RoleIDs, r)
	}
	return m, nil
}
func (f *fakeStore) Roles(context.Context, int64) ([]Role, error) {
	var out []Role
	for _, r := range f.roles {
		out = append(out, r)
	}
	return out, nil
}
func (f *fakeStore) Role(_ context.Context, _, id int64) (Role, error) {
	r, ok := f.roles[id]
	if !ok {
		return Role{}, ErrRoleNotFound
	}
	return r, nil
}
func (f *fakeStore) CreateRole(_ context.Context, r Role) (Role, error) {
	f.roles[r.ID] = r
	return r, nil
}
func (f *fakeStore) UpdateRole(_ context.Context, r Role) (Role, error) {
	f.roles[r.ID] = r
	return r, nil
}
func (f *fakeStore) DeleteRole(_ context.Context, _, id int64) error { delete(f.roles, id); return nil }
func (f *fakeStore) AddMemberRole(_ context.Context, _, u, r int64) error {
	if f.memRoles[u] == nil {
		f.memRoles[u] = map[int64]bool{}
	}
	f.memRoles[u][r] = true
	return nil
}
func (f *fakeStore) RemoveMemberRole(_ context.Context, _, u, r int64) error {
	delete(f.memRoles[u], r)
	return nil
}
func (f *fakeStore) RemoveMember(_ context.Context, _, u int64) error {
	delete(f.members, u)
	f.removed = append(f.removed, u)
	return nil
}
func (f *fakeStore) Transfer(_ context.Context, _, n int64) error { f.guild.OwnerID = n; return nil }
func (f *fakeStore) Delete(context.Context, int64) error          { return nil }
func (f *fakeStore) Update(_ context.Context, _ int64, name string, icon *string, sysChannel *int64, sysEnabled bool) (Guild, error) {
	f.guild.Name, f.guild.IconKey, f.guild.SystemChannelID, f.guild.SystemJoinEnabled = name, icon, sysChannel, sysEnabled
	return f.guild, nil
}

func (f *fakeStore) SystemChannel(context.Context, int64) (int64, bool, error) {
	return f.sysChannel, f.guild.SystemJoinEnabled, nil
}
func (f *fakeStore) IsTextChannel(_ context.Context, _, c int64) (bool, error)   { return c == 5, nil }
func (f *fakeStore) MembersAccess(context.Context, int64) ([]perm.Member, error) { return nil, nil }

type fakeChannels struct{}

func (fakeChannels) ListVisible(_ context.Context, _ int64, m perm.Member) ([]channel.Channel, error) {
	if !m.Has(perm.ViewChannel) {
		return nil, nil
	}
	return []channel.Channel{{ID: 5, Name: "geral"}}, nil
}
func (fakeChannels) ListVisibleByGuilds(_ context.Context, ms map[int64]perm.Member) (map[int64][]channel.Channel, error) {
	out := map[int64][]channel.Channel{}
	for g, m := range ms {
		if m.Has(perm.ViewChannel) {
			out[g] = []channel.Channel{{ID: 5, Name: "geral"}}
		}
	}
	return out, nil
}

type noAvatars struct{}

func (noAvatars) AvatarURLForKey(context.Context, *string) string { return "" }

type seq struct{ n int64 }

func (s *seq) Next() int64 { s.n++; return 100 + s.n }

func newSvc(f *fakeStore) (*Service, *recorder) {
	rec := &recorder{}
	return NewService(f, fakeChannels{}, nil, noAvatars{}, &seq{}, rec), rec
}

func TestCreateGuild(t *testing.T) {
	f := newFake()
	svc, rec := newSvc(f)
	d, err := svc.Create(context.Background(), 7, "  Meu servidor  ")
	if err != nil {
		t.Fatal(err)
	}
	n := f.created
	if n == nil || n.Name != "Meu servidor" || n.OwnerID != 7 || n.EveryonePermissions != perm.DefaultEveryone ||
		n.TextName != "geral" || n.VoiceName != "Geral" || n.ID == 0 || n.CategoryID == 0 || n.TextID == 0 || n.VoiceID == 0 {
		t.Fatalf("NewGuild: %+v", n)
	}
	if !d.Member.IsOwner || d.Member.Perms != perm.All {
		t.Fatalf("criador deve ser dono: %+v", d.Member)
	}
	if got := rec.types(); len(got) != 1 || got[0] != events.GuildCreate {
		t.Fatalf("eventos: %v", got)
	}
	if ev := rec.last(); ev.Topics[0] != "user:7" || ev.GuildID != n.ID {
		t.Fatalf("GUILD_CREATE: %+v", ev)
	}

	for _, bad := range []string{"", "a", "   ", string(make([]rune, 101))} {
		if _, err := svc.Create(context.Background(), 7, bad); !apperr.IsKind(err, apperr.KindInvalid) {
			t.Fatalf("nome %q deveria ser inválido: %v", bad, err)
		}
	}
	f.tooMany = true
	if _, err := svc.Create(context.Background(), 7, "Outro"); !errors.Is(err, ErrTooManyGuilds) {
		t.Fatalf("limite de servidores: %v", err)
	}
}

func TestLeaveOwnerAndTransfer(t *testing.T) {
	f := newFake()
	f.members[1] = Access{Perms: perm.DefaultEveryone}
	f.members[2] = Access{Perms: perm.DefaultEveryone}
	svc, rec := newSvc(f)
	ctx := context.Background()

	if err := svc.Leave(ctx, 1, 1); !errors.Is(err, ErrOwnerCannotLeave) {
		t.Fatalf("dono não sai: %v", err)
	}
	if err := svc.Leave(ctx, 9, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("não-membro: %v", err)
	}
	// transferir: só o dono, novo dono precisa ser membro e outro usuário
	if _, err := svc.Transfer(ctx, 2, 1, 2); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("não-dono: %v", err)
	}
	if _, err := svc.Transfer(ctx, 1, 1, 9); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("novo dono não-membro: %v", err)
	}
	if _, err := svc.Transfer(ctx, 1, 1, 1); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("para si mesmo: %v", err)
	}
	g, err := svc.Transfer(ctx, 1, 1, 2)
	if err != nil || g.OwnerID != 2 {
		t.Fatalf("transferência: %+v %v", g, err)
	}
	if rec.last().Type != events.GuildUpdate {
		t.Fatalf("eventos: %v", rec.types())
	}
	// agora o antigo dono pode sair; sair publica MEMBER_REMOVE e GUILD_DELETE para o ex-membro
	rec.evs = nil
	if err := svc.Leave(ctx, 1, 1); err != nil {
		t.Fatal(err)
	}
	got := rec.types()
	if len(got) != 2 || got[0] != events.GuildMemberRemove || got[1] != events.GuildDelete || rec.evs[1].Topics[0] != "user:1" {
		t.Fatalf("eventos ao sair: %+v", rec.evs)
	}
}

func TestDeleteOnlyOwner(t *testing.T) {
	f := newFake()
	f.members[1] = Access{}
	f.members[2] = Access{Perms: perm.Administrator}
	svc, rec := newSvc(f)
	if err := svc.Delete(context.Background(), 2, 1); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("admin não exclui: %v", err)
	}
	if err := svc.Delete(context.Background(), 1, 1); err != nil {
		t.Fatal(err)
	}
	if rec.last().Type != events.GuildDelete || rec.last().Topics[0] != "guild:1" {
		t.Fatalf("evento: %+v", rec.last())
	}
}

func TestKickHierarchy(t *testing.T) {
	// dono=1; 2 mod (cargo 5, KICK); 3 baixo (cargo 2, KICK); 4 comum; 5 par do mod (cargo 5, KICK); 6 admin (cargo 5)
	tests := []struct {
		name          string
		actor, target int64
		want          error
		kind          apperr.Kind
	}{
		{"dono expulsa", 1, 2, nil, 0},
		{"mod expulsa mais baixo", 2, 3, nil, 0},
		{"mod expulsa comum", 2, 4, nil, 0},
		{"baixo não expulsa mod", 3, 2, nil, apperr.KindForbidden},
		{"par não expulsa par", 2, 5, nil, apperr.KindForbidden},
		{"ninguém expulsa o dono", 2, 1, nil, apperr.KindForbidden},
		{"admin não expulsa o dono", 6, 1, nil, apperr.KindForbidden},
		{"admin não expulsa par", 6, 2, nil, apperr.KindForbidden},
		{"comum sem KICK", 4, 3, nil, apperr.KindForbidden},
		{"alvo inexistente", 2, 99, ErrMemberNotFound, 0},
		{"ator não-membro", 99, 2, ErrNotFound, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFake()
			f.members = map[int64]Access{
				1: {}, 2: {Perms: perm.KickMembers, Highest: 5}, 3: {Perms: perm.KickMembers, Highest: 2},
				4: {Perms: perm.DefaultEveryone}, 5: {Perms: perm.KickMembers, Highest: 5}, 6: {Perms: perm.Administrator, Highest: 5},
			}
			svc, rec := newSvc(f)
			err := svc.Kick(context.Background(), tt.actor, 1, tt.target)
			switch {
			case tt.want != nil:
				if !errors.Is(err, tt.want) {
					t.Fatalf("esperava %v, veio %v", tt.want, err)
				}
			case tt.kind != 0:
				if !apperr.IsKind(err, tt.kind) {
					t.Fatalf("esperava erro %d, veio %v", tt.kind, err)
				}
			default:
				if err != nil || len(f.removed) != 1 || f.removed[0] != tt.target {
					t.Fatalf("esperava expulsar %d: %v %v", tt.target, err, f.removed)
				}
				if got := rec.types(); len(got) != 2 || got[0] != events.GuildMemberRemove {
					t.Fatalf("eventos: %v", got)
				}
				return
			}
			if len(f.removed) != 0 || len(rec.evs) != 0 {
				t.Fatal("recusa não pode remover nem publicar")
			}
		})
	}
}

func rolesFixture() *fakeStore {
	f := newFake()
	f.members = map[int64]Access{
		1: {}, 2: {Perms: perm.ManageRoles | perm.KickMembers, Highest: 5}, 3: {Perms: perm.DefaultEveryone}, 4: {Perms: perm.DefaultEveryone},
	}
	f.roles[20] = Role{ID: 20, GuildID: 1, Name: "mod", Position: 5, Permissions: perm.ManageRoles | perm.KickMembers}
	f.roles[21] = Role{ID: 21, GuildID: 1, Name: "baixo", Position: 3, Permissions: perm.KickMembers}
	f.roles[22] = Role{ID: 22, GuildID: 1, Name: "poderoso", Position: 2, Permissions: perm.ManageGuild}
	return f
}

func i32(v int32) *int32        { return &v }
func pp(p perm.Perm) *perm.Perm { return &p }
func sp(s string) *string       { return &s }

func TestCreateRoleRules(t *testing.T) {
	tests := []struct {
		name string
		user int64
		in   RoleParams
		ok   bool
		kind apperr.Kind
	}{
		{"dono cria acima de tudo", 1, RoleParams{Name: sp("x"), Position: i32(50), Permissions: pp(perm.All)}, true, 0},
		{"mod cria abaixo", 2, RoleParams{Name: sp("x"), Position: i32(4), Permissions: pp(perm.KickMembers)}, true, 0},
		{"mod: posição igual", 2, RoleParams{Name: sp("x"), Position: i32(5)}, false, apperr.KindForbidden},
		{"mod: posição acima", 2, RoleParams{Name: sp("x"), Position: i32(6)}, false, apperr.KindForbidden},
		{"mod: concede o que não tem", 2, RoleParams{Name: sp("x"), Position: i32(4), Permissions: pp(perm.ManageGuild)}, false, apperr.KindForbidden},
		{"sem MANAGE_ROLES", 3, RoleParams{Name: sp("x")}, false, apperr.KindForbidden},
		{"não-membro", 99, RoleParams{Name: sp("x")}, false, apperr.KindNotFound},
		{"sem nome", 1, RoleParams{}, false, apperr.KindInvalid},
		{"posição 0 é do @everyone", 1, RoleParams{Name: sp("x"), Position: i32(0)}, false, apperr.KindInvalid},
		{"permissões desconhecidas", 1, RoleParams{Name: sp("x"), Permissions: pp(1 << 40)}, false, apperr.KindInvalid},
		{"cor inválida", 1, RoleParams{Name: sp("x"), Color: i32(0x1000000)}, false, apperr.KindInvalid},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := rolesFixture()
			svc, rec := newSvc(f)
			r, err := svc.CreateRole(context.Background(), tt.user, 1, tt.in)
			if tt.ok {
				if err != nil || r.ID == 0 || rec.last().Type != events.RoleCreate || rec.last().Topics[0] != "guild:1" {
					t.Fatalf("esperava criar: %v %v", err, rec.types())
				}
				return
			}
			if !apperr.IsKind(err, tt.kind) || len(rec.evs) != 0 {
				t.Fatalf("esperava erro %d sem eventos, veio %v", tt.kind, err)
			}
		})
	}
}

func TestUpdateAndDeleteRoleRules(t *testing.T) {
	ctx := context.Background()
	f := rolesFixture()
	svc, rec := newSvc(f)

	// mod edita cargo abaixo; não o próprio nível; não promove acima do seu
	if _, err := svc.UpdateRole(ctx, 2, 1, 21, RoleParams{Name: sp("renomeado")}); err != nil {
		t.Fatal(err)
	}
	if rec.last().Type != events.RoleUpdate {
		t.Fatalf("evento: %v", rec.types())
	}
	if _, err := svc.UpdateRole(ctx, 2, 1, 20, RoleParams{Name: sp("x")}); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("cargo do mesmo nível: %v", err)
	}
	if _, err := svc.UpdateRole(ctx, 2, 1, 21, RoleParams{Position: i32(5)}); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("promover ao nível do mod: %v", err)
	}
	if _, err := svc.UpdateRole(ctx, 2, 1, 21, RoleParams{Permissions: pp(perm.ManageGuild)}); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("conceder permissão que não tem: %v", err)
	}
	// manter um bit que o cargo já tinha (e o mod não tem) é permitido
	if _, err := svc.UpdateRole(ctx, 2, 1, 22, RoleParams{Name: sp("poder")}); err != nil {
		t.Fatalf("editar nome sem mexer em permissões: %v", err)
	}
	if _, err := svc.UpdateRole(ctx, 2, 1, 999, RoleParams{Name: sp("x")}); !errors.Is(err, ErrRoleNotFound) {
		t.Fatalf("cargo inexistente: %v", err)
	}
	// cor removida com -1
	f.roles[21] = Role{ID: 21, GuildID: 1, Name: "baixo", Position: 3, Color: i32(5)}
	if r, err := svc.UpdateRole(ctx, 1, 1, 21, RoleParams{Color: i32(-1)}); err != nil || r.Color != nil {
		t.Fatalf("remover cor: %+v %v", r, err)
	}

	// @everyone: permissões podem mudar; nome/posição não; nunca exclui
	if _, err := svc.UpdateRole(ctx, 1, 1, 1, RoleParams{Permissions: pp(perm.ViewChannel)}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateRole(ctx, 1, 1, 1, RoleParams{Name: sp("todos")}); !errors.Is(err, ErrEveryoneImmutable) {
		t.Fatalf("renomear @everyone: %v", err)
	}
	if _, err := svc.UpdateRole(ctx, 1, 1, 1, RoleParams{Position: i32(3)}); !errors.Is(err, ErrEveryoneImmutable) {
		t.Fatalf("mover @everyone: %v", err)
	}
	if err := svc.DeleteRole(ctx, 1, 1, 1); !errors.Is(err, ErrEveryoneImmutable) {
		t.Fatalf("excluir @everyone: %v", err)
	}
	if _, ok := f.roles[1]; !ok {
		t.Fatal("@everyone sumiu")
	}

	// excluir respeita a hierarquia
	rec.evs = nil
	if err := svc.DeleteRole(ctx, 2, 1, 20); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("excluir cargo do mesmo nível: %v", err)
	}
	if err := svc.DeleteRole(ctx, 3, 1, 21); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("sem MANAGE_ROLES: %v", err)
	}
	if err := svc.DeleteRole(ctx, 2, 1, 21); err != nil {
		t.Fatal(err)
	}
	if rec.last().Type != events.RoleDelete {
		t.Fatalf("eventos: %v", rec.types())
	}
}

func TestMemberRoleAssignment(t *testing.T) {
	ctx := context.Background()
	f := rolesFixture()
	svc, rec := newSvc(f)

	if _, err := svc.AddMemberRole(ctx, 2, 1, 3, 21); err != nil {
		t.Fatal(err)
	}
	if !f.memRoles[3][21] || rec.last().Type != events.GuildMemberUpdate {
		t.Fatalf("cargo não atribuído: %v %v", f.memRoles, rec.types())
	}
	if _, err := svc.AddMemberRole(ctx, 2, 1, 3, 20); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("cargo do mesmo nível: %v", err)
	}
	if _, err := svc.AddMemberRole(ctx, 2, 1, 3, 22); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("cargo com permissão que o mod não tem: %v", err)
	}
	if _, err := svc.AddMemberRole(ctx, 2, 1, 3, 1); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("@everyone não se atribui: %v", err)
	}
	if _, err := svc.AddMemberRole(ctx, 2, 1, 99, 21); !errors.Is(err, ErrMemberNotFound) {
		t.Fatalf("alvo não-membro: %v", err)
	}
	if _, err := svc.AddMemberRole(ctx, 3, 1, 4, 21); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("sem MANAGE_ROLES: %v", err)
	}
	// remover cargo cujas permissões o mod não tem é permitido se estiver abaixo dele
	f.memRoles[3][22] = true
	if _, err := svc.RemoveMemberRole(ctx, 2, 1, 3, 22); err != nil {
		t.Fatalf("remover cargo abaixo: %v", err)
	}
	if f.memRoles[3][22] {
		t.Fatal("cargo deveria ter sido removido")
	}
}

func TestUpdateGuildAndIcon(t *testing.T) {
	ctx := context.Background()
	f := newFake()
	f.members = map[int64]Access{1: {}, 2: {Perms: perm.DefaultEveryone}, 3: {Perms: perm.ManageGuild, Highest: 1}}
	svc, rec := newSvc(f)
	if _, err := svc.Update(ctx, 2, 1, UpdateParams{Name: sp("Novo nome")}); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("sem MANAGE_GUILD: %v", err)
	}
	if _, err := svc.Update(ctx, 9, 1, UpdateParams{Name: sp("Novo nome")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("não-membro: %v", err)
	}
	if _, err := svc.Update(ctx, 3, 1, UpdateParams{IconKey: sp("guild-icons/2/x.png")}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("ícone de outro servidor: %v", err)
	}
	if _, err := svc.Update(ctx, 3, 1, UpdateParams{Name: sp("x")}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("nome curto: %v", err)
	}
	g, err := svc.Update(ctx, 1, 1, UpdateParams{Name: sp("Dono renomeia"), IconKey: sp("guild-icons/1/a.png")})
	if err != nil || g.Name != "Dono renomeia" || g.IconKey == nil {
		t.Fatalf("dono renomeia: %+v %v", g, err)
	}
	if rec.last().Type != events.GuildUpdate || rec.last().Topics[0] != "guild:1" {
		t.Fatalf("evento: %v", rec.types())
	}
	if _, err := svc.Update(ctx, 3, 1, UpdateParams{Name: sp("Gestor renomeia")}); err != nil {
		t.Fatalf("MANAGE_GUILD renomeia: %v", err)
	}
}
