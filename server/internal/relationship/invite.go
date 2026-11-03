package relationship

import (
	"context"
	"strings"

	"go.opentelemetry.io/otel/attribute"
)

// GuildMembers diz se alguém já está no servidor (implementada por guild.Service, via adaptador no app).
type GuildMembers interface {
	IsMember(ctx context.Context, guildID, userID int64) (bool, error)
}

// Invites cria (ou reaproveita) o convite do usuário no servidor; exige CREATE_INVITE (invite.Service).
type Invites interface {
	Share(ctx context.Context, userID, guildID int64) (code string, err error)
}

// DMs abre a DM 1:1 com a pessoa (dm.Service); recusa bloqueios e quem não pode receber DM.
type DMs interface {
	OpenDM(ctx context.Context, userID, otherID int64) (channelID int64, err error)
}

// Messages envia a mensagem na DM como o usuário (message.Service).
type Messages interface {
	SendText(ctx context.Context, userID, channelID int64, content string) (messageID int64, err error)
}

type inviteDeps struct {
	guilds    GuildMembers
	invites   Invites
	dms       DMs
	messages  Messages
	publicURL string
}

// SetInvites liga "Convidar amigo para o servidor". publicURL (PUBLIC_URL) é a base do link /invite/<código>.
func (s *Service) SetInvites(g GuildMembers, i Invites, d DMs, m Messages, publicURL string) {
	s.invites = &inviteDeps{guilds: g, invites: i, dms: d, messages: m, publicURL: strings.TrimRight(publicURL, "/")}
}

// FriendInviteResult é o que o convite pela DM devolve.
type FriendInviteResult struct {
	ChannelID string `json:"channel_id" doc:"DM onde a mensagem com o link foi enviada"`
	MessageID string `json:"message_id"`
	Code      string `json:"code" doc:"Código do convite usado (criado ou reaproveitado)"`
}

// InviteFriend envia ao amigo, na DM, o link de um convite do servidor. Quem convida precisa de CREATE_INVITE;
// só amigos recebem por aqui; quem já está no servidor não é convidado. Reaproveita um convite do próprio
// usuário (sem limite de usos e com validade longa) em vez de criar um por pessoa.
func (s *Service) InviteFriend(ctx context.Context, userID, friendID, guildID int64) (FriendInviteResult, error) {
	ctx, span := tracer.Start(ctx, "relationship.InviteFriend")
	defer span.End()
	if s.invites == nil {
		return FriendInviteResult{}, ErrNoPublicURL
	}
	if err := take(s.actions, "friends.action:"+idStr(userID), "muitas ações de amizade seguidas; aguarde um pouco"); err != nil {
		return FriendInviteResult{}, err
	}
	if s.invites.publicURL == "" {
		return FriendInviteResult{}, ErrNoPublicURL
	}
	if friendID == userID {
		return FriendInviteResult{}, ErrSelf
	}
	kind, _, err := s.store.Get(ctx, userID, friendID)
	if err != nil {
		return FriendInviteResult{}, err
	}
	if kind != KindFriend {
		return FriendInviteResult{}, ErrNotFriend
	}
	code, err := s.invites.invites.Share(ctx, userID, guildID) // CREATE_INVITE; antes de revelar se o amigo é membro
	if err != nil {
		return FriendInviteResult{}, err
	}
	if member, err := s.invites.guilds.IsMember(ctx, guildID, friendID); err != nil {
		return FriendInviteResult{}, err
	} else if member {
		return FriendInviteResult{}, ErrAlreadyMember
	}
	ch, err := s.invites.dms.OpenDM(ctx, userID, friendID)
	if err != nil {
		return FriendInviteResult{}, err
	}
	msg, err := s.invites.messages.SendText(ctx, userID, ch, "Te convidei para um servidor: "+s.invites.publicURL+"/invite/"+code)
	if err != nil {
		return FriendInviteResult{}, err
	}
	span.SetAttributes(attribute.Int64("guild.id", guildID))
	s.count(ctx, "invite")
	return FriendInviteResult{ChannelID: idStr(ch), MessageID: idStr(msg), Code: code}, nil
}
