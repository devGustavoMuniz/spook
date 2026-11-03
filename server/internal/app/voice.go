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
	// dmBlocked diz se a DM 1:1 tem bloqueio entre os participantes (nulo = sem bloqueios): ninguém liga nem entra.
	dmBlocked func(ctx context.Context, channelID int64) (bool, error)
}

func (a voiceAccess) Channel(ctx context.Context, userID, channelID int64) (voice.ChannelAccess, error) {
	ch, m, err := a.channels.Authorize(ctx, userID, channelID, 0)
	if err != nil {
		return voice.ChannelAccess{}, err
	}
	if ch.GuildID == nil { // DM: basta participar (e não haver bloqueio no 1:1); as quatro origens
		if ch.Type == channel.TypeDM && a.dmBlocked != nil {
			blocked, err := a.dmBlocked(ctx, channelID)
			if err != nil {
				return voice.ChannelAccess{}, err
			}
			if blocked {
				return voice.ChannelAccess{Type: int(ch.Type), CanConnect: false}, nil
			}
		}
		return voice.ChannelAccess{Type: int(ch.Type), CanConnect: true, CanSpeak: true, CanVideo: true}, nil
	}
	muted, err := a.guilds.VoiceMuted(ctx, *ch.GuildID, userID)
	if err != nil {
		return voice.ChannelAccess{}, err
	}
	// m já é a permissão EFETIVA do canal (cargos + overwrites), calculada por channel.Authorize.
	return voice.ChannelAccess{
		Type: int(ch.Type), GuildID: *ch.GuildID,
		CanConnect: m.Has(perm.Connect), CanSpeak: m.Has(perm.Speak), CanVideo: m.Has(perm.Video), ServerMuted: muted,
	}, nil
}

func (a voiceAccess) ViewableChannels(ctx context.Context, userID, guildID int64) (map[int64]struct{}, error) {
	ids, err := a.channels.ViewableIDs(ctx, guildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return nil, apperr.NotFound("servidor não encontrado")
	}
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, apperr.Forbidden("você não tem permissão para ver este servidor")
	}
	out := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		out[id] = struct{}{}
	}
	return out, nil
}

func (a voiceAccess) Moderate(ctx context.Context, actorID, channelID, targetID int64) (int64, error) {
	ch, _, err := a.channels.Authorize(ctx, actorID, channelID, 0) // o moderador precisa ver o canal
	if err != nil {
		return 0, err
	}
	if ch.GuildID == nil {
		return 0, apperr.Invalid("chamadas de DM não têm moderação")
	}
	if ch.Type != channel.TypeVoice {
		return 0, voice.ErrNotVoiceChannel
	}
	if err := a.guilds.CanModerateVoice(ctx, actorID, *ch.GuildID, targetID, perm.DisconnectMembers); err != nil {
		return 0, err
	}
	return *ch.GuildID, nil
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
