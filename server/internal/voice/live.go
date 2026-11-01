package voice

import (
	"context"
	"time"
)

// LiveParticipant é um participante visto agora no LiveKit.
type LiveParticipant struct {
	UserID  int64
	Camera  bool
	Screen  bool
	Joined  time.Time // do estado em memória; zero se o backend ainda não registrou a entrada
	Sources []Source
}

// LiveRoom é uma sala ativa lida do LiveKit (sala = ID do canal).
type LiveRoom struct {
	ChannelID    int64
	Participants []LiveParticipant
	Since        time.Time // a entrada mais antiga conhecida; zero se desconhecida
}

// LiveRooms lê do LiveKit as salas com gente e os participantes de cada uma (uma chamada de
// listagem mais uma por sala). Com a voz desligada devolve ErrDisabled. Quem chama deve manter
// um cache curto: o custo cresce com o número de salas.
func (s *Service) LiveRooms(ctx context.Context) ([]LiveRoom, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	rctx, cancel := remote(ctx)
	rooms, err := s.prov.ListRooms(rctx)
	cancel()
	if err != nil {
		return nil, err
	}
	var out []LiveRoom
	for _, r := range rooms {
		id, ok := parseID(r.Name)
		if !ok || r.Participants == 0 {
			continue
		}
		rctx, cancel := remote(ctx)
		parts, err := s.prov.ListParticipants(rctx, r.Name)
		cancel()
		if err != nil {
			return nil, err
		}
		joined := map[int64]time.Time{}
		for _, st := range s.store.ByChannel(id) {
			joined[st.UserID] = st.JoinedAt
		}
		room := LiveRoom{ChannelID: id}
		for _, p := range parts {
			uid, ok := parseID(p.Identity)
			if !ok {
				continue
			}
			lp := LiveParticipant{UserID: uid, Sources: p.Sources, Joined: joined[uid]}
			for _, src := range p.Sources {
				switch src {
				case SourceCamera:
					lp.Camera = true
				case SourceScreenShare:
					lp.Screen = true
				}
			}
			if !lp.Joined.IsZero() && (room.Since.IsZero() || lp.Joined.Before(room.Since)) {
				room.Since = lp.Joined
			}
			room.Participants = append(room.Participants, lp)
		}
		if len(room.Participants) > 0 {
			out = append(out, room)
		}
	}
	return out, nil
}
