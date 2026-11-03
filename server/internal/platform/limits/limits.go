// Package limits reúne os limites de domínio configuráveis por variável de ambiente (LIMIT_*), com os
// padrões do SPEC (7.1, 7.3 e 7.9). Os services aplicam o valor configurado; o contrato OpenAPI anuncia só o
// máximo absoluto de cada campo (ver Absolute*), então mudar a configuração nunca desalinha o cliente gerado.
package limits

import "fmt"

// Limits são os tetos de domínio. Zero em qualquer campo vale o padrão (veja Normalize).
type Limits struct {
	GuildsPerUser    int   // LIMIT_GUILDS_PER_USER: servidores em que uma pessoa pode estar (SPEC 7.1)
	ChannelsPerGuild int   // LIMIT_CHANNELS_PER_GUILD: canais (texto, voz e categorias) por servidor
	MembersPerGuild  int   // LIMIT_MEMBERS_PER_GUILD: membros por servidor
	RolesPerGuild    int   // LIMIT_ROLES_PER_GUILD: cargos por servidor, contando o @everyone
	InvitesPerGuild  int   // LIMIT_INVITES_PER_GUILD: convites ativos por servidor
	AttachmentBytes  int64 // LIMIT_ATTACHMENT_MB (em MB na variável): tamanho máximo de um anexo (SPEC 7.3)
}

// Padrões (SPEC 7.1 e 7.3 para servidores e anexos; os demais são decisão registrada em 5.5).
const (
	DefaultGuildsPerUser    = 100
	DefaultChannelsPerGuild = 500
	DefaultMembersPerGuild  = 10000
	DefaultRolesPerGuild    = 250
	DefaultInvitesPerGuild  = 1000
	DefaultAttachmentMB     = 25
)

// Máximos absolutos aceitos na configuração (e anunciados no contrato quando um campo depende deles).
const (
	MaxGuildsPerUser    = 10000
	MaxChannelsPerGuild = 5000
	MaxMembersPerGuild  = 1_000_000
	MaxRolesPerGuild    = 1000
	MaxInvitesPerGuild  = 100_000
	MaxAttachmentMB     = 100
)

// Default devolve os limites do SPEC.
func Default() Limits {
	return Limits{
		GuildsPerUser: DefaultGuildsPerUser, ChannelsPerGuild: DefaultChannelsPerGuild, MembersPerGuild: DefaultMembersPerGuild,
		RolesPerGuild: DefaultRolesPerGuild, InvitesPerGuild: DefaultInvitesPerGuild, AttachmentBytes: DefaultAttachmentMB << 20,
	}
}

// Normalize troca os campos zerados pelo padrão (um Limits{} vale Default()).
func (l Limits) Normalize() Limits {
	d := Default()
	if l.GuildsPerUser <= 0 {
		l.GuildsPerUser = d.GuildsPerUser
	}
	if l.ChannelsPerGuild <= 0 {
		l.ChannelsPerGuild = d.ChannelsPerGuild
	}
	if l.MembersPerGuild <= 0 {
		l.MembersPerGuild = d.MembersPerGuild
	}
	if l.RolesPerGuild <= 0 {
		l.RolesPerGuild = d.RolesPerGuild
	}
	if l.InvitesPerGuild <= 0 {
		l.InvitesPerGuild = d.InvitesPerGuild
	}
	if l.AttachmentBytes <= 0 {
		l.AttachmentBytes = d.AttachmentBytes
	}
	return l
}

// AttachmentMB é o limite de anexo em MB (para mensagens de erro).
func (l Limits) AttachmentMB() int64 { return l.AttachmentBytes >> 20 }

// Mensagens de erro em pt-br com o valor configurado.

func GuildsPerUserMsg(n int) string {
	return fmt.Sprintf("limite de %d servidores por usuário atingido", n)
}
func ChannelsPerGuildMsg(n int) string {
	return fmt.Sprintf("este servidor já tem o máximo de %d canais", n)
}
func MembersPerGuildMsg(n int) string {
	return fmt.Sprintf("este servidor atingiu o limite de %d membros", n)
}
func RolesPerGuildMsg(n int) string {
	return fmt.Sprintf("este servidor já tem o máximo de %d cargos", n)
}
func InvitesPerGuildMsg(n int) string {
	return fmt.Sprintf("este servidor já tem o máximo de %d convites; revogue algum antes de criar outro", n)
}
