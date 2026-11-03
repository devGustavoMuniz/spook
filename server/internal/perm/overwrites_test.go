package perm

import "testing"

const (
	g1       = int64(100) // servidor (o @everyone tem o mesmo ID)
	roleMod  = int64(201)
	roleVip  = int64(202)
	roleMute = int64(203)
)

func member(id int64, base Perm, roles ...int64) Member {
	m := NewMember(id, false, base, 0)
	m.GuildID, m.RoleIDs = g1, roles
	return m
}

func ow(t TargetType, id int64, allow, deny Perm) Overwrite {
	return Overwrite{Type: t, TargetID: id, Allow: allow, Deny: deny}
}

// Matriz de permissões por canal: cada linha é um caso (base, overwrites) → o que a pessoa tem no canal.
func TestInChannelMatrix(t *testing.T) {
	everyone := DefaultEveryone
	tests := []struct {
		name string
		m    Member
		ows  []Overwrite
		want Perm // só os bits de ChannelScoped são comparados
	}{
		{"sem overwrites herda o servidor", member(1, everyone), nil, everyone & ChannelScoped},
		{"@everyone nega VIEW: canal privado", member(1, everyone), []Overwrite{ow(TargetRole, g1, 0, ViewChannel)}, 0},
		{"@everyone nega VIEW, cargo permite", member(1, everyone, roleVip),
			[]Overwrite{ow(TargetRole, g1, 0, ViewChannel), ow(TargetRole, roleVip, ViewChannel, 0)}, everyone & ChannelScoped},
		{"@everyone nega VIEW, cargo que o membro não tem", member(1, everyone, roleMod),
			[]Overwrite{ow(TargetRole, g1, 0, ViewChannel), ow(TargetRole, roleVip, ViewChannel, 0)}, 0},
		{"@everyone nega VIEW, membro específico permite", member(1, everyone),
			[]Overwrite{ow(TargetRole, g1, 0, ViewChannel), ow(TargetMember, 1, ViewChannel, 0)}, everyone & ChannelScoped},
		{"overwrite de outro membro não vale", member(1, everyone),
			[]Overwrite{ow(TargetRole, g1, 0, ViewChannel), ow(TargetMember, 2, ViewChannel, 0)}, 0},
		{"cargo nega SEND", member(1, everyone, roleMute), []Overwrite{ow(TargetRole, roleMute, 0, SendMessages)},
			(everyone & ChannelScoped) &^ SendMessages},
		{"entre cargos o deny é aplicado antes e o allow depois: o allow vence", member(1, everyone, roleMute, roleVip),
			[]Overwrite{ow(TargetRole, roleMute, 0, SendMessages), ow(TargetRole, roleVip, SendMessages, 0)}, everyone & ChannelScoped},
		{"membro permite o que o cargo negou", member(1, everyone, roleMute),
			[]Overwrite{ow(TargetRole, roleMute, 0, SendMessages), ow(TargetMember, 1, SendMessages, 0)}, everyone & ChannelScoped},
		{"membro nega o que o cargo permitiu", member(1, everyone, roleVip),
			[]Overwrite{ow(TargetRole, roleVip, ManageMessages, 0), ow(TargetMember, 1, 0, ManageMessages)}, everyone & ChannelScoped},
		{"@everyone nega SEND, cargo permite, membro nega de novo", member(1, everyone, roleVip),
			[]Overwrite{ow(TargetRole, g1, 0, SendMessages), ow(TargetRole, roleVip, SendMessages, 0), ow(TargetMember, 1, 0, SendMessages)},
			(everyone & ChannelScoped) &^ SendMessages},
		{"cargo concede permissão que o servidor não dava", member(1, everyone, roleMod),
			[]Overwrite{ow(TargetRole, roleMod, ManageMessages, 0)}, (everyone & ChannelScoped) | ManageMessages},
		{"sem VIEW nada de canal sobra", member(1, everyone|ManageMessages), []Overwrite{ow(TargetRole, g1, 0, ViewChannel)}, 0},
		{"base sem VIEW, overwrite do membro libera só este canal", member(1, SendMessages),
			[]Overwrite{ow(TargetMember, 1, ViewChannel, 0)}, ViewChannel | SendMessages},
		{"bit fora do escopo de canal é ignorado", member(1, everyone), []Overwrite{ow(TargetRole, g1, BanMembers, ManageChannels)}, everyone & ChannelScoped},
		{"administrador ignora overwrites", NewMemberWith(member(1, Administrator)), []Overwrite{ow(TargetRole, g1, 0, ViewChannel)}, ChannelScoped},
		{"dono ignora overwrites", ownerOf(), []Overwrite{ow(TargetRole, g1, 0, ViewChannel), ow(TargetMember, 9, 0, ViewChannel|SendMessages)}, ChannelScoped},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.m.InChannel(tt.ows).Perms & ChannelScoped
			if got != tt.want {
				t.Fatalf("permissões no canal = %b, quer %b", got, tt.want)
			}
		})
	}
}

// NewMemberWith mantém RoleIDs/GuildID (NewMember não os conhece).
func NewMemberWith(m Member) Member { return m }

func ownerOf() Member {
	m := NewMember(9, true, 0, 0)
	m.GuildID = g1
	return m
}

func TestInChannelKeepsGuildOnlyPermissions(t *testing.T) {
	m := member(1, DefaultEveryone|ManageChannels|BanMembers).InChannel([]Overwrite{ow(TargetRole, g1, 0, ViewChannel)})
	if !m.Has(ManageChannels) || !m.Has(BanMembers) {
		t.Fatal("permissões de servidor não dependem do canal")
	}
	if m.Has(ViewChannel) || m.Has(SendMessages) {
		t.Fatal("sem VIEW as permissões de canal somem")
	}
}

func TestCanModerate(t *testing.T) {
	owner := NewMember(1, true, 0, 0)
	admin := NewMember(2, false, Administrator, 50)
	mod := NewMember(3, false, BanMembers, 10)
	peer := NewMember(4, false, BanMembers, 10)
	low := NewMember(5, false, ViewChannel, 3)
	plain := NewMember(6, false, ViewChannel, 0)
	tests := []struct {
		name  string
		actor Member
		to    Member
		want  bool
	}{
		{"dono bane qualquer um", owner, admin, true},
		{"ninguém bane o dono", admin, owner, false},
		{"administrador respeita a hierarquia (não age sobre cargo igual/superior)", admin, NewMember(7, false, ViewChannel, 50), false},
		{"administrador age sobre cargo menor", admin, mod, true},
		{"cargo maior bane menor", mod, low, true},
		{"cargo igual não", mod, peer, false},
		{"cargo menor não", low, mod, false},
		{"sem a permissão", low, plain, false},
		{"a si mesmo não", mod, mod, false},
		{"quem só tem @everyone é alvo", mod, plain, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.actor.CanModerate(BanMembers, tt.to); got != tt.want {
				t.Fatalf("CanModerate = %v, quer %v", got, tt.want)
			}
		})
	}
	if low.CanModerate(MuteMembers, plain) {
		t.Fatal("MUTE_MEMBERS é outra permissão")
	}
}

func TestCanEditOverwrite(t *testing.T) {
	eff := func(base Perm, highest int) Member { return NewMember(7, false, base, highest) }
	tests := []struct {
		name      string
		m         Member
		everyone  bool
		rank      int
		old, next Perm
		want      bool
	}{
		{"dono edita tudo", NewMember(1, true, 0, 0), false, 999, 0, ChannelScoped, true},
		{"edita o @everyone sem hierarquia", eff(ManageChannels|ViewChannel|SendMessages, 0), true, 0, 0, SendMessages, true},
		{"não concede o que não tem", eff(ManageChannels|ViewChannel, 5), false, 2, 0, SendMessages, false},
		{"concede o que tem", eff(ManageChannels|ViewChannel|SendMessages, 5), false, 2, 0, SendMessages, true},
		{"o que já era permitido não conta como concessão nova", eff(ManageChannels|ViewChannel, 5), false, 2, SendMessages, SendMessages, true},
		{"alvo de cargo igual", eff(ManageChannels|ViewChannel, 5), false, 5, 0, 0, false},
		{"alvo de cargo maior", eff(ManageChannels|ViewChannel, 5), false, 6, 0, 0, false},
		{"administrador concede qualquer coisa de canal abaixo dele", eff(Administrator, 5), false, 2, 0, ChannelScoped, true},
		{"administrador também respeita a hierarquia", eff(Administrator, 5), false, 5, 0, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.m.CanEditOverwrite(tt.everyone, tt.rank, tt.old, tt.next); got != tt.want {
				t.Fatalf("CanEditOverwrite = %v, quer %v", got, tt.want)
			}
		})
	}
}

func TestNewPermissionBitsAreDistinctAndValid(t *testing.T) {
	bits := []Perm{BanMembers, ChangeNickname, ManageNicknames, MuteMembers, DisconnectMembers, ViewAuditLog}
	seen := Perm(0)
	for _, b := range bits {
		if b&seen != 0 || b&ChannelScoped != 0 || !b.Valid() {
			t.Fatalf("bit %b repetido, de canal ou inválido", b)
		}
		seen |= b
	}
	if ChannelScoped&^All != 0 {
		t.Fatal("ChannelScoped fora de All")
	}
}
