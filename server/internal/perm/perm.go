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

	// Moderação (adicional: banir, apelidos, voz e auditoria). Nenhum cargo existente recebe estes bits
	// na migração (exceto ChangeNickname no @everyone, ver SPEC 5.5): quem concede é o dono/administrador.
	BanMembers        Perm = 1 << 13 // banir e desbanir
	ChangeNickname    Perm = 1 << 14 // mudar o próprio apelido
	ManageNicknames   Perm = 1 << 15 // mudar o apelido dos outros
	MuteMembers       Perm = 1 << 16 // mutar pelo servidor na voz
	DisconnectMembers Perm = 1 << 17 // desconectar alguém de um canal de voz
	ViewAuditLog      Perm = 1 << 18 // ler o registro de auditoria

	// MentionEveryone (adicional): notificar @everyone, @here e cargos não mencionáveis. Vale no servidor
	// inteiro (não é permissão de canal). O @everyone do servidor NÃO a recebe por padrão.
	MentionEveryone Perm = 1 << 19
)

// All reúne todas as permissões definidas.
const All Perm = 1<<20 - 1

// ChannelScoped são as permissões que um canal pode permitir ou negar (overwrites). As demais valem só
// no servidor inteiro (gerenciar, convidar, moderar...).
const ChannelScoped = ViewChannel | SendMessages | ManageMessages | AttachFiles | Connect | Speak | Video

// DefaultEveryone são as permissões iniciais do cargo @everyone.
const DefaultEveryone = ViewChannel | SendMessages | AttachFiles | CreateInvite | Connect | Speak | Video | ChangeNickname

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
	// RoleIDs são os cargos do membro (sem o @everyone, cujo ID é o do servidor) e GuildID o servidor;
	// só são usados para resolver as permissões de um canal (InChannel).
	RoleIDs []int64
	GuildID int64
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
func (m Member) CanKick(target Member) bool { return m.CanModerate(KickMembers, target) }

// CanModerate generaliza CanKick para qualquer ação de moderação (banir, mutar, desconectar, mudar
// apelido alheio): exige a permissão need, o alvo não pode ser o dono nem o próprio membro, e o cargo mais
// alto do alvo deve ser estritamente menor que o do membro (cargo igual ou superior é intocável). O dono é
// isento da hierarquia. ADMINISTRATOR concede a permissão, mas NÃO ignora a hierarquia.
func (m Member) CanModerate(need Perm, target Member) bool {
	if !m.Has(need) || target.IsOwner || target.UserID == m.UserID {
		return false
	}
	if m.IsOwner {
		return true
	}
	return target.Highest < m.Highest
}

// TargetType diz se um overwrite de canal vale para um cargo ou para um membro.
type TargetType string

const (
	TargetRole   TargetType = "role"
	TargetMember TargetType = "member"
)

// Overwrite é uma regra de um canal: permitir (Allow) e negar (Deny) permissões a um cargo (o @everyone é o
// cargo de ID igual ao do servidor) ou a um membro.
type Overwrite struct {
	Type     TargetType
	TargetID int64
	Allow    Perm
	Deny     Perm
}

// InChannel devolve o membro com as permissões efetivas NO CANAL, na ordem do Discord: base por cargos
// (já em m.Perms) → overwrite do @everyone → overwrites dos cargos do membro (primeiro todos os deny, depois
// todos os allow) → overwrite do próprio membro (deny e depois allow). O dono e ADMINISTRATOR ignoram os
// overwrites. Sem VIEW_CHANNEL no resultado, as permissões de canal somem (quem não vê não age). Só os bits
// de ChannelScoped são considerados nos overwrites.
func (m Member) InChannel(ows []Overwrite) Member {
	if m.IsOwner || m.Perms&Administrator != 0 || len(ows) == 0 {
		return m
	}
	p := m.Perms
	var roleAllow, roleDeny Perm
	var member *Overwrite
	for i := range ows {
		o := &ows[i]
		switch {
		case o.Type == TargetRole && o.TargetID == m.GuildID: // @everyone
			p = p&^(o.Deny&ChannelScoped) | o.Allow&ChannelScoped
		case o.Type == TargetRole && hasID(m.RoleIDs, o.TargetID):
			roleAllow |= o.Allow & ChannelScoped
			roleDeny |= o.Deny & ChannelScoped
		case o.Type == TargetMember && o.TargetID == m.UserID:
			member = o
		}
	}
	p = p&^roleDeny | roleAllow
	if member != nil {
		p = p&^(member.Deny&ChannelScoped) | member.Allow&ChannelScoped
	}
	if p&ViewChannel == 0 {
		p &^= ChannelScoped
	}
	m.Perms = p
	return m
}

func hasID(ids []int64, id int64) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

// CanEditOverwrite diz se o membro pode criar/alterar/remover o overwrite de um alvo: o alvo (cargo na
// posição targetPos, ou membro com targetHighest) tem de estar estritamente abaixo do membro na hierarquia
// (o @everyone, everyone=true, não tem hierarquia; o dono é isento), e ele só pode PERMITIR
// permissões de canal que ele mesmo tem no canal (m deve ser o membro já resolvido com InChannel).
func (m Member) CanEditOverwrite(everyone bool, targetRank int, oldAllow, newAllow Perm) bool {
	if m.IsOwner {
		return true
	}
	if !everyone && targetRank >= m.Highest {
		return false
	}
	added := newAllow &^ oldAllow
	return m.Perms&Administrator != 0 || added&^m.Perms == 0
}
