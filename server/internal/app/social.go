package app

import (
	"context"
	"errors"

	"github.com/devGustavoMuniz/spook/server/internal/dm"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/message"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
)

// Adaptadores do "Convidar amigo pela DM": relationship só conhece as interfaces dele, sem importar guild, dm
// nem message.

type guildMembers struct{ guilds *guild.Service }

func (g guildMembers) IsMember(ctx context.Context, guildID, userID int64) (bool, error) {
	_, err := g.guilds.Member(ctx, guildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return false, nil
	}
	return err == nil, err
}

type dmOpener struct{ dms *dm.Service }

func (d dmOpener) OpenDM(ctx context.Context, userID, otherID int64) (int64, error) {
	ch, _, err := d.dms.Open(ctx, userID, otherID)
	if err != nil {
		return 0, err
	}
	return ch.ID, nil
}

type messageSender struct{ msgs *message.Service }

func (m messageSender) SendText(ctx context.Context, userID, channelID int64, content string) (int64, error) {
	msg, err := m.msgs.Send(ctx, userID, channelID, content, nil, message.SendOptions{})
	if err != nil {
		return 0, err
	}
	return msg.ID, nil
}
