package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/devGustavoMuniz/spook/server/internal/admin"
	"github.com/devGustavoMuniz/spook/server/internal/gateway"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

// adminCalls liga a porta admin.CallSource à voz: admin não importa o pacote voice.
type adminCalls struct{ voice *voice.Service }

func (a adminCalls) LiveRooms(ctx context.Context) ([]admin.LiveRoom, error) {
	rooms, err := a.voice.LiveRooms(ctx)
	if errors.Is(err, voice.ErrDisabled) {
		return nil, admin.ErrCallsDisabled
	}
	if err != nil {
		return nil, err
	}
	out := make([]admin.LiveRoom, len(rooms))
	for i, r := range rooms {
		lr := admin.LiveRoom{ChannelID: r.ChannelID, Since: r.Since}
		for _, p := range r.Participants {
			lr.Participants = append(lr.Participants, admin.LiveParticipant{UserID: p.UserID, Camera: p.Camera, Screen: p.Screen})
		}
		out[i] = lr
	}
	return out, nil
}

// adminGateway liga admin.GatewayStats ao hub.
type adminGateway struct{ hub *gateway.Hub }

func (a adminGateway) GatewayStats() admin.GatewaySample {
	s := a.hub.Stats()
	return admin.GatewaySample{Connections: s.Conns, Sessions: s.Sessions, Users: s.Users, EventsTotal: s.Dispatched}
}

// adminPool liga admin.PoolStats ao pgxpool.
type adminPool struct{ pool *pgxpool.Pool }

func (a adminPool) PoolStats() admin.PoolSample {
	s := a.pool.Stat()
	return admin.PoolSample{
		Max: s.MaxConns(), Open: s.TotalConns(), Idle: s.IdleConns(), InUse: s.AcquiredConns(), WaitCount: s.EmptyAcquireCount(),
	}
}
