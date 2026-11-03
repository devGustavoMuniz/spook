// Package audit cuida do registro de auditoria dos servidores (adicional de moderação): quem fez o quê, em
// quem e quando. Quem age (guild, channel, voice, invite) grava pelo Recorder que define; este pacote só
// guarda, lista e apaga o que passou da retenção. Falha ao gravar NUNCA impede a ação principal.
package audit

import (
	"encoding/json"
	"time"
	"unicode/utf8"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// Action identifica o que foi feito. Os valores são estáveis (o cliente os traduz para texto).
type Action string

const (
	ChannelCreate      Action = "channel.create"
	ChannelUpdate      Action = "channel.update"
	ChannelDelete      Action = "channel.delete"
	OverwriteUpdate    Action = "channel.overwrite_update"
	OverwriteDelete    Action = "channel.overwrite_delete"
	RoleCreate         Action = "role.create"
	RoleUpdate         Action = "role.update"
	RoleDelete         Action = "role.delete"
	MemberRoleAdd      Action = "member.role_add"
	MemberRoleRemove   Action = "member.role_remove"
	MemberKick         Action = "member.kick"
	MemberBan          Action = "member.ban"
	MemberUnban        Action = "member.unban"
	MemberNick         Action = "member.nick_update"
	VoiceMute          Action = "voice.mute"
	VoiceUnmute        Action = "voice.unmute"
	VoiceDisconnect    Action = "voice.disconnect"
	InviteCreate       Action = "invite.create"
	InviteRevoke       Action = "invite.revoke"
	GuildUpdate        Action = "guild.update"
	GuildTransferOwner Action = "guild.transfer"
)

// All lista as ações conhecidas (validação do filtro da API).
var All = []Action{
	ChannelCreate, ChannelUpdate, ChannelDelete, OverwriteUpdate, OverwriteDelete, RoleCreate, RoleUpdate, RoleDelete,
	MemberRoleAdd, MemberRoleRemove, MemberKick, MemberBan, MemberUnban, MemberNick, VoiceMute, VoiceUnmute,
	VoiceDisconnect, InviteCreate, InviteRevoke, GuildUpdate, GuildTransferOwner,
}

// Valid diz se a ação é conhecida.
func (a Action) Valid() bool {
	for _, k := range All {
		if k == a {
			return true
		}
	}
	return false
}

// Tipos de alvo.
const (
	TargetChannel = "channel"
	TargetRole    = "role"
	TargetMember  = "member"
	TargetInvite  = "invite"
	TargetGuild   = "guild"
)

const (
	// MaxChangesBytes é o limite do campo changes (também há CHECK no banco).
	MaxChangesBytes = 4096
	MaxReasonRunes  = 512
	DefaultLimit    = 50
	MaxLimit        = 100
)

var (
	ErrForbidden = apperr.Forbidden("você não tem permissão para ver o registro de auditoria")
	ErrNotFound  = apperr.NotFound("servidor não encontrado")
)

// Entry é o que um service entrega para registrar. TargetID zero = sem alvo. Changes costuma ter
// "target_name" (nome legível do alvo) e o antes/depois dos campos alterados.
type Entry struct {
	GuildID    int64
	ActorID    int64
	Action     Action
	TargetType string
	TargetID   int64
	Reason     string
	Changes    map[string]any
}

// Row é uma linha guardada.
type Row struct {
	ID         int64
	GuildID    int64
	ActorID    *int64
	Action     string
	TargetType *string
	TargetID   *int64
	Reason     *string
	Changes    []byte // JSON
	CreatedAt  time.Time

	ActorUsername    *string
	ActorDisplayName *string
	ActorAvatarKey   *string
	ActorAvatarURL   string
}

// AuditActorPayload é quem fez a ação (nulo quando a conta foi excluída).
type AuditActorPayload struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

// AuditEntryPayload é uma linha do registro na API.
type AuditEntryPayload struct {
	ID         string             `json:"id"`
	GuildID    string             `json:"guild_id"`
	Actor      *AuditActorPayload `json:"actor" doc:"Nulo quando a conta de quem agiu foi excluída"`
	Action     string             `json:"action" doc:"Ver audit.All: channel.create, member.ban, voice.mute..."`
	TargetType *string            `json:"target_type" doc:"channel, role, member, invite ou guild"`
	TargetID   *string            `json:"target_id"`
	Reason     *string            `json:"reason"`
	Changes    map[string]any     `json:"changes" doc:"Detalhes (até 4 KB): target_name e o antes/depois dos campos alterados"`
	CreatedAt  time.Time          `json:"created_at"`
}

func (r Row) Payload() AuditEntryPayload {
	p := AuditEntryPayload{
		ID: httpx.ID(r.ID), GuildID: httpx.ID(r.GuildID), Action: r.Action, TargetType: r.TargetType,
		TargetID: httpx.IDPtr(r.TargetID), Reason: r.Reason, CreatedAt: r.CreatedAt, Changes: map[string]any{},
	}
	if len(r.Changes) > 0 {
		_ = json.Unmarshal(r.Changes, &p.Changes)
		if p.Changes == nil {
			p.Changes = map[string]any{}
		}
	}
	if r.ActorID != nil && r.ActorUsername != nil {
		a := &AuditActorPayload{ID: httpx.ID(*r.ActorID), Username: *r.ActorUsername, AvatarURL: r.ActorAvatarURL}
		if r.ActorDisplayName != nil {
			a.DisplayName = *r.ActorDisplayName
		}
		p.Actor = a
	}
	return p
}

// encodeChanges serializa changes respeitando o limite; acima dele guarda só um marcador.
func encodeChanges(c map[string]any) []byte {
	if len(c) == 0 {
		return nil
	}
	b, err := json.Marshal(c)
	if err != nil || len(b) > MaxChangesBytes {
		keep := map[string]any{"truncated": true}
		if n, ok := c["target_name"].(string); ok {
			keep["target_name"] = truncateRunes(n, 100)
		}
		b, _ = json.Marshal(keep)
	}
	return b
}

func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max])
}
