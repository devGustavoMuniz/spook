// Package perm implementa as permissões de servidor (SPEC 7.2): bitflags, permissão efetiva e hierarquia.
// É puro: não conhece banco, HTTP nem outras features.
package perm

import (
	"errors"
	"math"
)

// Perm é um conjunto de permissões (bitflags).
type Perm int64

const (
	Administrator  Perm = 1 << 0 // todas as permissões
	ManageGuild    Perm = 1 << 1
	ManageChannels Perm = 1 << 2
	ManageRoles    Perm = 1 << 3
	KickMembers    Perm = 1 << 4
	CreateInvite   Perm = 1 << 5
	ViewChannel    Perm = 1 << 6
	SendMessages   Perm = 1 << 7
	ManageMessages Perm = 1 << 8
	AttachFiles    Perm = 1 << 9
	Connect        Perm = 1 << 10
	Speak          Perm = 1 << 11
	Video          Perm = 1 << 12
)

// All reúne todas as permissões definidas.
const All Perm = 1<<13 - 1

// DefaultEveryone são as permissões iniciais do cargo @everyone.
const DefaultEveryone = ViewChannel | SendMessages | AttachFiles | CreateInvite | Connect | Speak | Video

// ErrNotMember indica que o usuário não é membro do servidor. Quem consulta permissões
// (Access) devolve este erro; os services tratam o servidor como inexistente (404).
var ErrNotMember = errors.New("não é membro do servidor")

// Valid diz se p só usa bits conhecidos.
func (p Perm) Valid() bool { return p >= 0 && p&^All == 0 }

// Has diz se p concede todas as permissões de want; ADMINISTRATOR concede tudo.
func (p Perm) Has(want Perm) bool {
	return p&Administrator != 0 || p&want == want
}

// Effective calcula a permissão efetiva: OR do @everyone e dos cargos do membro. O dono tem tudo.
func Effective(isOwner bool, everyone Perm, roles ...Perm) Perm {
	if isOwner {
		return All
	}
	p := everyone
	for _, r := range roles {
		p |= r
	}
	if p&Administrator != 0 {
		return All
	}
	return p
}

// Member resume o que as regras precisam saber de um membro em um servidor.
type Member struct {
	UserID  int64
	IsOwner bool
	Perms   Perm // já efetiva (dono = All)
	Highest int  // posição do cargo mais alto (0 = só @everyone); o dono vale MaxInt32
}

// NewMember monta o Member a partir dos dados brutos.
func NewMember(userID int64, isOwner bool, perms Perm, highest int) Member {
	m := Member{UserID: userID, IsOwner: isOwner, Perms: Effective(isOwner, perms), Highest: highest}
	if isOwner {
		m.Highest = math.MaxInt32
	}
	return m
}

// Has diz se o membro tem a permissão (dono e ADMINISTRATOR têm todas).
func (m Member) Has(p Perm) bool { return m.IsOwner || m.Perms.Has(p) }

// CanManageRole diz se o membro pode criar/editar/excluir/atribuir um cargo na posição pos
// que passa a ter (ou já tem) as permissões granted, dado o conjunto anterior old.
// Exige MANAGE_ROLES, cargo estritamente abaixo do mais alto do membro e que o membro
// só conceda permissões que ele mesmo tem. O dono é isento da hierarquia.
func (m Member) CanManageRole(pos int, old, granted Perm) bool {
	if !m.Has(ManageRoles) {
		return false
	}
	if m.IsOwner {
		return true
	}
	if pos >= m.Highest {
		return false
	}
	return m.CanGrant(old, granted)
}

// CanGrant diz se o membro pode conceder as permissões novas (bits que não estavam em old).
func (m Member) CanGrant(old, granted Perm) bool {
	if m.IsOwner || m.Perms&Administrator != 0 {
		return true
	}
	added := granted &^ old
	return added&^m.Perms == 0
}

// CanKick diz se o membro pode expulsar target: exige KICK_MEMBERS, o alvo não pode ser o dono
// nem o próprio membro, e o cargo mais alto do alvo deve ser menor que o do membro.
// O dono é isento da hierarquia.
func (m Member) CanKick(target Member) bool {
	if !m.Has(KickMembers) || target.IsOwner || target.UserID == m.UserID {
		return false
	}
	if m.IsOwner {
		return true
	}
	return target.Highest < m.Highest
}
