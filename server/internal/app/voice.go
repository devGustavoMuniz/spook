package app

import (
	"context"
	"errors"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/user"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

// voiceAccess liga a porta voice.Access às permissões de servidor (guild, perm) e de DM
// (channel.Authorize, que consulta o dm): voice não importa o store de ninguém.
type voiceAccess struct {
	channels *channel.Service
	guilds   *guild.Service
}

func (a voiceAccess) Channel(ctx context.Context, userID, channelID int64) (voice.ChannelAccess, error) {
	ch, m, err := a.channels.Authorize(ctx, userID, channelID, 0)
	if err != nil {
		return voice.ChannelAccess{}, err
	}
	if ch.GuildID == nil { // DM: basta participar; as quatro origens
		return voice.ChannelAccess{Type: int(ch.Type), CanConnect: true, CanSpeak: true, CanVideo: true}, nil
	}
	return voice.ChannelAccess{
		Type: int(ch.Type), GuildID: *ch.GuildID,
		CanConnect: m.Has(perm.Connect), CanSpeak: m.Has(perm.Speak), CanVideo: m.Has(perm.Video),
	}, nil
}

func (a voiceAccess) Guild(ctx context.Context, userID, guildID int64) error {
	m, err := a.guilds.Member(ctx, guildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return apperr.NotFound("servidor não encontrado")
	}
	if err != nil {
		return err
	}
	if !m.Has(perm.ViewChannel) {
		return apperr.Forbidden("você não tem permissão para ver este servidor")
	}
	return nil
}

// voiceUsers entrega o username (nome do participante no LiveKit).
type voiceUsers struct{ users *user.Service }

func (u voiceUsers) Username(ctx context.Context, id int64) (string, error) {
	usr, err := u.users.Get(ctx, id)
	if err != nil {
		return "", err
	}
	return usr.Username, nil
}
