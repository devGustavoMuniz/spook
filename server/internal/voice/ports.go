package voice

import (
	"context"
	"errors"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/plan"
)

// ErrInvalidSignature indica um webhook que não veio do LiveKit (assinatura ausente ou inválida).
var ErrInvalidSignature = errors.New("assinatura do webhook inválida")

// Tipos de evento do webhook que o backend usa.
const (
	EventParticipantJoined = "participant_joined"
	EventParticipantLeft   = "participant_left"
	EventTrackPublished    = "track_published"
	EventTrackUnpublished  = "track_unpublished"
	EventRoomFinished      = "room_finished"
)

// RoomEvent é um webhook do LiveKit já verificado, no vocabulário do domínio.
type RoomEvent struct {
	ID       string // ID único do evento (deduplicação)
	Type     string
	Room     string
	Identity string
	SID      string // SID do participante
	Source   Source // track_*: origem da mídia
	// track_published: a faixa e o tamanho informado pelo cliente ao publicá-la (vídeo; 0 = desconhecido). O
	// webhook do LiveKit não traz a taxa de quadros.
	TrackSID    string
	TrackWidth  int
	TrackHeight int
	Tracks      []Source // participant_joined: mídias já publicadas
}

// Participant é um participante visto no LiveKit.
type Participant struct {
	Identity string
	SID      string
	Sources  []Source // mídias publicadas
}

// Room é uma sala ativa no LiveKit.
type Room struct {
	Name         string
	Participants int
}

// TokenRequest descreve o token a emitir: uma sala só, expiração curta.
type TokenRequest struct {
	Room     string
	Identity string
	Name     string
	TTL      time.Duration
	Grants   Grants
}

// Provider é a porta para o LiveKit (ou um falso, nos testes).
type Provider interface {
	// PublicURL é a URL de sinalização entregue ao cliente.
	PublicURL() string
	// IssueToken assina o token de acesso (local, sem rede).
	IssueToken(req TokenRequest) (string, error)
	// RemoveParticipant tira o participante da sala. Participante/sala inexistente não é erro.
	RemoveParticipant(ctx context.Context, room, identity string) error
	// UpdatePermissions troca o que o participante pode publicar. Inexistente não é erro.
	UpdatePermissions(ctx context.Context, room, identity string, g Grants) error
	// MuteTrack silencia uma faixa publicada (o servidor para de repassá-la). Faixa/sala inexistente não é erro.
	MuteTrack(ctx context.Context, room, identity, trackSID string) error
	ListRooms(ctx context.Context) ([]Room, error)
	ListParticipants(ctx context.Context, room string) ([]Participant, error)
	// VerifyWebhook valida a assinatura (header Authorization + hash do corpo) e interpreta o evento.
	// Assinatura inválida devolve ErrInvalidSignature. ok=false: evento que o backend ignora.
	VerifyWebhook(authorization string, body []byte) (ev RoomEvent, ok bool, err error)
}

// StateStore guarda o estado de voz e as intenções pendentes. A implementação precisa ser segura
// para uso concorrente; a serialização por usuário é feita pelo service.
type StateStore interface {
	Get(userID int64) (State, bool)
	Put(State)
	Delete(userID int64)
	ByChannel(channelID int64) []State
	ByGuild(guildID int64) []State
	ByChannels(channelIDs []int64) []State
	ByGuilds(guildIDs []int64) []State
	Channels() []int64 // canais com ao menos um participante
	CountByKind() (guild, dm int)

	SetPending(Pending)
	GetPending(userID int64, now time.Time) (Pending, bool) // expirado = ausente
	ClearPending(userID int64)
}

// Access é a porta de permissões, implementada no app com guild, dm e perm.
type Access interface {
	// Channel autoriza o usuário no canal. Erros de negócio: apperr.NotFound (não vê o canal ou
	// não é membro/participante) e apperr.Forbidden (membro sem VIEW_CHANNEL). Para canais de
	// servidor sem CONNECT NÃO devolve erro: CanConnect=false (quem decide é a voz).
	Channel(ctx context.Context, userID, channelID int64) (ChannelAccess, error)
	// ViewableChannels devolve os canais do servidor que o usuário vê (permissão efetiva de cada canal);
	// não-membro: apperr.NotFound; sem ver nenhum canal: apperr.Forbidden.
	ViewableChannels(ctx context.Context, userID, guildID int64) (map[int64]struct{}, error)
	// Moderate autoriza o ator a desconectar o alvo da voz do canal (DISCONNECT_MEMBERS + hierarquia) e devolve o
	// servidor do canal. apperr.NotFound (canal/membro), apperr.Forbidden, apperr.Invalid (DM) e 429.
	Moderate(ctx context.Context, actorID, channelID, targetID int64) (guildID int64, err error)
}

// Auditor grava o registro de auditoria (audit.Service; opcional).
type Auditor interface {
	Record(ctx context.Context, e audit.Entry)
}

// Plans diz o plano efetivo de quem entra na voz (entitlement.Service). Opcional: nulo = sem limites de plano
// (o token devolve os do plano grátis e nada é imposto na faixa publicada).
type Plans interface {
	Tier(ctx context.Context, userID int64) (plan.Tier, error)
}

// Users resolve o nome de exibição do participante.
type Users interface {
	Username(ctx context.Context, userID int64) (string, error)
}
