// Package livekit é o adaptador da porta voice.Provider sobre o LiveKit: tokens e verificação de
// webhook com github.com/livekit/protocol e a API de administração via twirp (RoomService),
// sem o server-sdk-go.
package livekit

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
	lk "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"github.com/twitchtv/twirp"

	"github.com/devGustavoMuniz/spook/server/internal/voice"
)

// Config são os dados de conexão.
type Config struct {
	PublicURL   string // entregue ao cliente
	InternalURL string // API server-to-server
	APIKey      string
	APISecret   string
	HTTPClient  *http.Client // opcional
}

type Provider struct {
	cfg   Config
	keys  auth.KeyProvider
	rooms lk.RoomService
}

var _ voice.Provider = (*Provider)(nil)

// New cria o adaptador. Nenhuma chamada de rede acontece aqui.
func New(cfg Config) *Provider {
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 5 * time.Second}
	}
	return &Provider{
		cfg:   cfg,
		keys:  auth.NewSimpleKeyProvider(cfg.APIKey, cfg.APISecret),
		rooms: lk.NewRoomServiceProtobufClient(strings.TrimRight(cfg.InternalURL, "/"), hc),
	}
}

func (p *Provider) PublicURL() string { return p.cfg.PublicURL }

var sources = map[voice.Source]lk.TrackSource{
	voice.SourceMicrophone:       lk.TrackSource_MICROPHONE,
	voice.SourceCamera:           lk.TrackSource_CAMERA,
	voice.SourceScreenShare:      lk.TrackSource_SCREEN_SHARE,
	voice.SourceScreenShareAudio: lk.TrackSource_SCREEN_SHARE_AUDIO,
}

func toLK(g voice.Grants) []lk.TrackSource {
	out := make([]lk.TrackSource, 0, len(g.Publish))
	for _, s := range g.Publish {
		if ls, ok := sources[s]; ok {
			out = append(out, ls)
		}
	}
	return out
}

func fromLK(s lk.TrackSource) (voice.Source, bool) {
	for k, v := range sources {
		if v == s {
			return k, true
		}
	}
	return "", false
}

func (p *Provider) IssueToken(req voice.TokenRequest) (string, error) {
	t := true
	grant := &auth.VideoGrant{RoomJoin: true, Room: req.Room, CanSubscribe: &t}
	if req.Grants.CanPublish() {
		grant.CanPublish = &t
		grant.SetCanPublishSources(toLK(req.Grants))
	} else {
		f := false
		grant.CanPublish = &f
	}
	return auth.NewAccessToken(p.cfg.APIKey, p.cfg.APISecret).
		SetIdentity(req.Identity).SetName(req.Name).SetValidFor(req.TTL).SetVideoGrant(grant).ToJWT()
}

// adminCtx anexa um token de administração da sala (roomAdmin/roomList) à chamada twirp.
func (p *Provider) adminCtx(ctx context.Context, room string) (context.Context, error) {
	grant := &auth.VideoGrant{RoomAdmin: true, Room: room}
	if room == "" {
		grant = &auth.VideoGrant{RoomList: true}
	}
	jwt, err := auth.NewAccessToken(p.cfg.APIKey, p.cfg.APISecret).SetVideoGrant(grant).SetValidFor(time.Minute).ToJWT()
	if err != nil {
		return nil, err
	}
	h := http.Header{}
	h.Set("Authorization", "Bearer "+jwt)
	return twirp.WithHTTPRequestHeaders(ctx, h)
}

// notFound diz se o erro twirp significa "sala/participante não existe".
func notFound(err error) bool {
	var te twirp.Error
	return errors.As(err, &te) && te.Code() == twirp.NotFound
}

func (p *Provider) RemoveParticipant(ctx context.Context, room, identity string) error {
	ctx, err := p.adminCtx(ctx, room)
	if err != nil {
		return err
	}
	_, err = p.rooms.RemoveParticipant(ctx, &lk.RoomParticipantIdentity{Room: room, Identity: identity})
	if notFound(err) {
		return nil
	}
	return err
}

func (p *Provider) UpdatePermissions(ctx context.Context, room, identity string, g voice.Grants) error {
	ctx, err := p.adminCtx(ctx, room)
	if err != nil {
		return err
	}
	_, err = p.rooms.UpdateParticipant(ctx, &lk.UpdateParticipantRequest{
		Room: room, Identity: identity,
		Permission: &lk.ParticipantPermission{
			CanSubscribe: true, CanPublish: g.CanPublish(), CanPublishSources: toLK(g),
		},
	})
	if notFound(err) {
		return nil
	}
	return err
}

func (p *Provider) MuteTrack(ctx context.Context, room, identity, trackSID string) error {
	ctx, err := p.adminCtx(ctx, room)
	if err != nil {
		return err
	}
	_, err = p.rooms.MutePublishedTrack(ctx, &lk.MuteRoomTrackRequest{Room: room, Identity: identity, TrackSid: trackSID, Muted: true})
	if notFound(err) {
		return nil
	}
	return err
}

func (p *Provider) ListRooms(ctx context.Context) ([]voice.Room, error) {
	ctx, err := p.adminCtx(ctx, "")
	if err != nil {
		return nil, err
	}
	res, err := p.rooms.ListRooms(ctx, &lk.ListRoomsRequest{})
	if err != nil {
		return nil, err
	}
	out := make([]voice.Room, 0, len(res.Rooms))
	for _, r := range res.Rooms {
		out = append(out, voice.Room{Name: r.Name, Participants: int(r.NumParticipants)})
	}
	return out, nil
}

func (p *Provider) ListParticipants(ctx context.Context, room string) ([]voice.Participant, error) {
	ctx, err := p.adminCtx(ctx, room)
	if err != nil {
		return nil, err
	}
	res, err := p.rooms.ListParticipants(ctx, &lk.ListParticipantsRequest{Room: room})
	if notFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]voice.Participant, 0, len(res.Participants))
	for _, pi := range res.Participants {
		out = append(out, voice.Participant{Identity: pi.Identity, SID: pi.Sid, Sources: trackSources(pi.Tracks)})
	}
	return out, nil
}

func trackSources(tracks []*lk.TrackInfo) []voice.Source {
	var out []voice.Source
	for _, t := range tracks {
		if s, ok := fromLK(t.Source); ok {
			out = append(out, s)
		}
	}
	return out
}

// VerifyWebhook valida o header Authorization (JWT assinado com o segredo da API, com o hash
// SHA-256 do corpo) via livekit/protocol e converte o evento.
func (p *Provider) VerifyWebhook(authorization string, body []byte) (voice.RoomEvent, bool, error) {
	r, err := http.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	if err != nil {
		return voice.RoomEvent{}, false, err
	}
	r.Header.Set("Authorization", authorization)
	ev, err := webhook.ReceiveWebhookEvent(r, p.keys)
	if err != nil {
		return voice.RoomEvent{}, false, errors.Join(voice.ErrInvalidSignature, err)
	}
	out := voice.RoomEvent{ID: ev.Id, Type: ev.Event}
	if ev.Room != nil {
		out.Room = ev.Room.Name
	}
	if pi := ev.Participant; pi != nil {
		out.Identity, out.SID = pi.Identity, pi.Sid
		out.Tracks = trackSources(pi.Tracks)
	}
	if t := ev.Track; t != nil {
		out.Source, _ = fromLK(t.Source)
		out.TrackSID, out.TrackWidth, out.TrackHeight = t.Sid, int(t.Width), int(t.Height)
	}
	switch ev.Event {
	case voice.EventParticipantJoined, voice.EventParticipantLeft, voice.EventTrackPublished,
		voice.EventTrackUnpublished, voice.EventRoomFinished:
		return out, true, nil
	}
	return out, false, nil
}
