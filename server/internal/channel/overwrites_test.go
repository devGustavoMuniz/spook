package channel

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

const (
	roleVip  = int64(201)
	roleMute = int64(202)
	privCh   = int64(11) // o canal "geral" do setup()
)

// matrixService monta o servidor 1 com usuários de papéis variados e devolve o service.
func matrixService(ows []perm.Overwrite) (*Service, *recorder) {
	svc, st, rec := setup()
	mk := func(id int64, base perm.Perm, highest int, roles ...int64) perm.Member {
		m := perm.NewMember(id, false, base, highest)
		m.GuildID, m.RoleIDs = guildID, roles
		return m
	}
	owner := perm.NewMember(owner, true, 0, 0)
	owner.GuildID = guildID
	svc.access = fakeAccess{members: map[int64]perm.Member{
		1:  owner,
		2:  mk(2, perm.DefaultEveryone, 0),
		3:  mk(3, perm.DefaultEveryone, 3, roleVip),
		4:  mk(4, perm.DefaultEveryone, 3, roleMute),
		5:  mk(5, perm.Administrator, 1),
		6:  mk(6, perm.DefaultEveryone, 0),
		7:  mk(7, perm.DefaultEveryone|perm.ManageChannels, 5),
		8:  mk(8, perm.DefaultEveryone, 3, roleVip, roleMute),
		9:  mk(9, perm.ViewChannel, 0), // só VIEW no servidor
		10: mk(10, perm.DefaultEveryone&^perm.ViewChannel, 0),
	}}
	st.ows = map[int64][]perm.Overwrite{privCh: ows}
	return svc, rec
}

func ow(t perm.TargetType, id int64, allow, deny perm.Perm) perm.Overwrite {
	return perm.Overwrite{Type: t, TargetID: id, Allow: allow, Deny: deny}
}

// Matriz de acesso a um canal: usuário × overwrites → o que Authorize permite.
func TestAuthorizeMatrix(t *testing.T) {
	priv := []perm.Overwrite{ow(perm.TargetRole, guildID, 0, perm.ViewChannel), ow(perm.TargetRole, roleVip, perm.ViewChannel, 0), ow(perm.TargetMember, 6, perm.ViewChannel, 0)}
	readonly := []perm.Overwrite{ow(perm.TargetRole, guildID, 0, perm.SendMessages), ow(perm.TargetMember, 6, perm.SendMessages, 0)}
	conflict := []perm.Overwrite{ow(perm.TargetRole, roleMute, 0, perm.SendMessages), ow(perm.TargetRole, roleVip, perm.SendMessages, 0)}
	tests := []struct {
		name string
		ows  []perm.Overwrite
		user int64
		need perm.Perm
		want error // nil = permitido
	}{
		{"sem overwrites: comum lê", nil, 2, 0, nil},
		{"sem overwrites: comum envia", nil, 2, perm.SendMessages, nil},
		{"privado: @everyone não vê", priv, 2, 0, ErrForbidden},
		{"privado: cargo vip vê", priv, 3, 0, nil},
		{"privado: membro liberado vê", priv, 6, 0, nil},
		{"privado: dono vê", priv, 1, 0, nil},
		{"privado: administrador vê", priv, 5, 0, nil},
		{"privado: cargo errado não vê", priv, 4, 0, ErrForbidden},
		{"privado: não-membro", priv, 99, 0, ErrNotFound},
		{"somente leitura: @everyone lê", readonly, 2, 0, nil},
		{"somente leitura: @everyone não envia", readonly, 2, perm.SendMessages, ErrForbidden},
		{"somente leitura: membro específico envia", readonly, 6, perm.SendMessages, nil},
		{"somente leitura: dono envia", readonly, 1, perm.SendMessages, nil},
		{"somente leitura: administrador envia", readonly, 5, perm.SendMessages, nil},
		{"conflito entre cargos: o allow vence (deny e depois allow)", conflict, 8, perm.SendMessages, nil},
		{"conflito: só o allow", conflict, 3, perm.SendMessages, nil},
		{"conflito: só o deny", conflict, 4, perm.SendMessages, ErrForbidden},
		{"sem VIEW no servidor, overwrite do membro libera", []perm.Overwrite{ow(perm.TargetMember, 10, perm.ViewChannel, 0)}, 10, 0, nil},
		{"sem VIEW no servidor e sem overwrite", nil, 10, 0, ErrForbidden},
		{"só VIEW no servidor não envia", nil, 9, perm.SendMessages, ErrForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, _ := matrixService(tt.ows)
			_, _, err := svc.Authorize(context.Background(), tt.user, privCh, tt.need)
			if !errors.Is(err, tt.want) && (tt.want != nil || err != nil) {
				t.Fatalf("Authorize = %v, quer %v", err, tt.want)
			}
		})
	}
}

func TestListFiltersByEffectiveView(t *testing.T) {
	priv := []perm.Overwrite{ow(perm.TargetRole, guildID, 0, perm.ViewChannel), ow(perm.TargetRole, roleVip, perm.ViewChannel, 0)}
	svc, _ := matrixService(priv)
	ids := func(user int64) map[int64]bool {
		chs, err := svc.List(context.Background(), user, guildID)
		if err != nil {
			t.Fatalf("List(%d): %v", user, err)
		}
		out := map[int64]bool{}
		for _, c := range chs {
			out[c.ID] = true
		}
		return out
	}
	if got := ids(2); got[privCh] || !got[10] || !got[12] {
		t.Fatalf("comum: %v", got)
	}
	if got := ids(3); !got[privCh] {
		t.Fatalf("vip deveria ver o canal privado: %v", got)
	}
	if got := ids(1); !got[privCh] {
		t.Fatalf("dono: %v", got)
	}
	if _, err := svc.List(context.Background(), 10, guildID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("sem VIEW em lugar nenhum: %v", err)
	}
	vis, err := svc.ViewableIDs(context.Background(), guildID, 2)
	if err != nil || len(vis) != 2 {
		t.Fatalf("ViewableIDs do comum: %v %v", vis, err)
	}
	if _, err := svc.ViewableIDs(context.Background(), guildID, 99); !errors.Is(err, perm.ErrNotMember) {
		t.Fatalf("não-membro: %v", err)
	}
}

func TestSetOverwriteRulesAndEvents(t *testing.T) {
	ctx := context.Background()
	svc, rec := matrixService(nil)
	set := func(user int64, tt perm.TargetType, target int64, allow, deny perm.Perm) error {
		_, err := svc.SetOverwrite(ctx, user, privCh, tt, target, allow, deny)
		return err
	}
	// Permissão e visibilidade.
	if err := set(2, perm.TargetRole, guildID, 0, perm.ViewChannel); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("sem MANAGE_CHANNELS: %v", err)
	}
	if err := set(99, perm.TargetRole, guildID, 0, perm.ViewChannel); !apperr.IsKind(err, apperr.KindNotFound) {
		t.Fatalf("não-membro: %v", err)
	}
	// Validação do corpo.
	for name, c := range map[string][2]perm.Perm{
		"sobreposição":       {perm.ViewChannel, perm.ViewChannel},
		"fora do escopo":     {perm.BanMembers, 0},
		"deny fora escopo":   {0, perm.Administrator},
		"bit desconhecido":   {0, perm.Perm(1) << 40},
		"negativo":           {-1, 0},
		"gerenciar servidor": {perm.ManageGuild, 0},
	} {
		if err := set(1, perm.TargetRole, guildID, c[0], c[1]); !apperr.IsKind(err, apperr.KindInvalid) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if err := set(1, perm.TargetType("x"), guildID, 0, 0); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("tipo inválido: %v", err)
	}
	if err := set(1, perm.TargetMember, 1, 0, perm.ViewChannel); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("o dono não é alvo: %v", err)
	}
	if len(rec.evs) != 0 {
		t.Fatalf("recusas não publicam: %v", rec.types())
	}
	// Dono define; evento interno publicado; leitura reflete.
	if err := set(1, perm.TargetRole, guildID, 0, perm.ViewChannel); err != nil {
		t.Fatal(err)
	}
	if got := rec.types(); len(got) != 1 || got[0] != events.ChannelOverwritesUpdate {
		t.Fatalf("eventos: %v", got)
	}
	got, err := svc.Overwrites(ctx, 1, privCh)
	if err != nil || len(got) != 1 || got[0].Deny != perm.ViewChannel {
		t.Fatalf("Overwrites: %v %v", got, err)
	}
	// Gerente (7, posição 5, MANAGE_CHANNELS) não vê mais o canal: 404. Libera por membro e testa a concessão.
	if _, err := svc.Overwrites(ctx, 7, privCh); !apperr.IsKind(err, apperr.KindNotFound) {
		t.Fatalf("gerente sem VIEW: %v", err)
	}
	if err := set(1, perm.TargetMember, 7, perm.ViewChannel, 0); err != nil {
		t.Fatal(err)
	}
	if err := set(7, perm.TargetRole, roleVip, perm.ViewChannel|perm.SendMessages, 0); err != nil {
		t.Fatalf("gerente concede o que tem (rank do vip = 201%%100=1 < 5): %v", err)
	}
	if err := set(7, perm.TargetRole, roleVip, perm.ViewChannel|perm.ManageMessages, 0); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("gerente concede o que não tem: %v", err)
	}
	// allow=deny=0 remove.
	if err := svc.DeleteOverwrite(ctx, 1, privCh, perm.TargetRole, guildID); err != nil {
		t.Fatal(err)
	}
	if got, _ := svc.Overwrites(ctx, 1, privCh); len(got) != 2 {
		t.Fatalf("depois de remover: %v", got)
	}
	// DM não tem overwrites.
	if _, err := svc.SetOverwrite(ctx, 1, 60, perm.TargetRole, guildID, 0, perm.ViewChannel); !apperr.IsKind(err, apperr.KindNotFound) {
		t.Fatalf("DM: %v", err)
	}
}

func TestSetOverwriteRateLimited(t *testing.T) {
	svc, _ := matrixService(nil)
	svc.SetLimiter(denyAll{})
	if _, err := svc.SetOverwrite(context.Background(), 1, privCh, perm.TargetRole, guildID, 0, perm.ViewChannel); !apperr.IsKind(err, apperr.KindRateLimited) {
		t.Fatalf("limite: %v", err)
	}
}

type denyAll struct{}

func (denyAll) Take(string) (bool, time.Duration) { return false, time.Second }
