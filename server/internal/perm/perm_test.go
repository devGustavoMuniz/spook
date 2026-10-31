package perm

import "testing"

func TestEffective(t *testing.T) {
	tests := []struct {
		name     string
		owner    bool
		everyone Perm
		roles    []Perm
		want     Perm
	}{
		{"só everyone", false, DefaultEveryone, nil, DefaultEveryone},
		{"união com cargos", false, ViewChannel, []Perm{ManageRoles, KickMembers}, ViewChannel | ManageRoles | KickMembers},
		{"dono tem tudo", true, 0, nil, All},
		{"administrador tem tudo", false, ViewChannel, []Perm{Administrator}, All},
		{"nada", false, 0, nil, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Effective(tt.owner, tt.everyone, tt.roles...); got != tt.want {
				t.Fatalf("Effective = %b, quer %b", got, tt.want)
			}
		})
	}
}

func TestDefaultEveryone(t *testing.T) {
	want := []Perm{ViewChannel, SendMessages, AttachFiles, CreateInvite, Connect, Speak, Video}
	var all Perm
	for _, p := range want {
		all |= p
		if !DefaultEveryone.Has(p) {
			t.Fatalf("falta %b nos padrões", p)
		}
	}
	if DefaultEveryone != all {
		t.Fatalf("padrões têm bits a mais: %b", DefaultEveryone)
	}
}

func TestHasAndValid(t *testing.T) {
	if !Perm(Administrator).Has(ManageGuild | KickMembers) {
		t.Fatal("administrador deve ter tudo")
	}
	if (ViewChannel).Has(ViewChannel | SendMessages) {
		t.Fatal("Has exige todos os bits")
	}
	if !All.Valid() || Perm(1<<13).Valid() || Perm(-1).Valid() {
		t.Fatal("Valid incorreto")
	}
}

func TestCanManageRole(t *testing.T) {
	owner := NewMember(1, true, 0, 0)
	mod := NewMember(2, false, ManageRoles|KickMembers|ViewChannel, 5)
	noPerm := NewMember(3, false, ViewChannel, 9)
	admin := NewMember(4, false, Administrator, 5)

	tests := []struct {
		name         string
		m            Member
		pos          int
		old, granted Perm
		want         bool
	}{
		{"dono ignora hierarquia", owner, 100, 0, All, true},
		{"sem MANAGE_ROLES", noPerm, 1, 0, 0, false},
		{"cargo abaixo", mod, 4, 0, ViewChannel, true},
		{"cargo igual", mod, 5, 0, ViewChannel, false},
		{"cargo acima", mod, 6, 0, ViewChannel, false},
		{"concede o que não tem", mod, 4, 0, ManageGuild, false},
		{"mantém bit que o cargo já tinha", mod, 4, ManageGuild, ManageGuild | ViewChannel, true},
		{"admin concede qualquer coisa abaixo", admin, 4, 0, All, true},
		{"admin respeita hierarquia", admin, 5, 0, ViewChannel, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.m.CanManageRole(tt.pos, tt.old, tt.granted); got != tt.want {
				t.Fatalf("CanManageRole = %v, quer %v", got, tt.want)
			}
		})
	}
}

func TestCanKick(t *testing.T) {
	owner := NewMember(1, true, 0, 0)
	mod := NewMember(2, false, KickMembers, 5)
	peer := NewMember(3, false, KickMembers, 5)
	low := NewMember(4, false, ViewChannel, 2)
	plain := NewMember(5, false, ViewChannel, 0)

	tests := []struct {
		name      string
		actor, to Member
		want      bool
	}{
		{"dono expulsa qualquer um", owner, mod, true},
		{"ninguém expulsa o dono", mod, owner, false},
		{"admin não expulsa o dono", NewMember(6, false, Administrator, 50), owner, false},
		{"cargo maior expulsa menor", mod, low, true},
		{"cargo igual não", mod, peer, false},
		{"cargo menor não expulsa maior", low, mod, false},
		{"sem KICK_MEMBERS", plain, plain, false},
		{"sem KICK_MEMBERS expulsando outro", NewMember(7, false, ViewChannel, 9), low, false},
		{"não expulsa a si mesmo", mod, mod, false},
		{"expulsa quem só tem @everyone", mod, plain, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.actor.CanKick(tt.to); got != tt.want {
				t.Fatalf("CanKick = %v, quer %v", got, tt.want)
			}
		})
	}
}

func TestNewMemberOwnerHighest(t *testing.T) {
	m := NewMember(1, true, 0, 3)
	if m.Perms != All || m.Highest < 1_000_000 || !m.Has(ManageRoles) {
		t.Fatalf("dono mal montado: %+v", m)
	}
}
