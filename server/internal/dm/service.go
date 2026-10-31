package dm

import (
	"context"
	"slices"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

var tracer = otel.Tracer("spook/dm")

// Store é o que o service precisa do banco.
type Store interface {
	// SharingGuild devolve, dos candidatos, quem compartilha pelo menos um servidor com userID.
	SharingGuild(ctx context.Context, userID int64, candidates []int64) ([]int64, error)
	// OpenPair devolve a DM 1:1 do par (a < b), criando-a com newID se não existir. A reserva do
	// par é atômica: criações simultâneas resultam em um só canal (created só é true para quem venceu).
	OpenPair(ctx context.Context, a, b, newID int64) (ch channel.Channel, created bool, err error)
	CreateGroup(ctx context.Context, id, owner int64, recipients []int64) (channel.Channel, error)
	Get(ctx context.Context, id int64) (channel.Channel, error) // channel.ErrNotFound; sem participantes
	Recipients(ctx context.Context, channelIDs []int64) (map[int64][]channel.Recipient, error)
	ListByUser(ctx context.Context, userID int64) ([]channel.Channel, error) // sem participantes
	// AddRecipient insere o participante respeitando o limite sob lock; added é false se já estava.
	AddRecipient(ctx context.Context, channelID, userID int64, max int) (added bool, err error)
	RemoveRecipient(ctx context.Context, channelID, userID int64) (removed bool, err error)
	Rename(ctx context.Context, id int64, name string) (channel.Channel, error)
	IsRecipient(ctx context.Context, channelID, userID int64) (bool, error)
}

// Limiter limita a criação de DMs por usuário.
type Limiter interface {
	Take(key string) (ok bool, retryAfter time.Duration)
}

type Avatars interface {
	AvatarURLForKey(ctx context.Context, key *string) string
}

type IDGenerator interface{ Next() int64 }

type Service struct {
	store   Store
	ids     IDGenerator
	pub     events.Publisher
	avatars Avatars
	limiter Limiter
	created metric.Int64Counter
}

func NewService(store Store, ids IDGenerator, pub events.Publisher, avatars Avatars, limiter Limiter) *Service {
	s := &Service{store: store, ids: ids, pub: pub, avatars: avatars, limiter: limiter}
	s.created, _ = otel.Meter("spook/dm").Int64Counter("spook.dm.created",
		metric.WithDescription("DMs criadas (1:1 e em grupo)"))
	return s
}

// IsRecipient diz se o usuário participa da DM (usado por channel.Service.Authorize).
func (s *Service) IsRecipient(ctx context.Context, channelID, userID int64) (bool, error) {
	return s.store.IsRecipient(ctx, channelID, userID)
}

// fill carrega os participantes (com URL de avatar) nos canais, em lote.
func (s *Service) fill(ctx context.Context, chs []channel.Channel) error {
	if len(chs) == 0 {
		return nil
	}
	ids := make([]int64, len(chs))
	for i, c := range chs {
		ids[i] = c.ID
	}
	rs, err := s.store.Recipients(ctx, ids)
	if err != nil {
		return err
	}
	urls := map[int64]string{}
	for i := range chs {
		list := rs[chs[i].ID]
		for j := range list {
			u, ok := urls[list[j].ID]
			if !ok {
				u = s.avatars.AvatarURLForKey(ctx, list[j].AvatarKey)
				urls[list[j].ID] = u
			}
			list[j].AvatarURL = u
		}
		chs[i].Recipients = list
	}
	return nil
}

func (s *Service) one(ctx context.Context, c channel.Channel) (channel.Channel, error) {
	cs := []channel.Channel{c}
	if err := s.fill(ctx, cs); err != nil {
		return channel.Channel{}, err
	}
	return cs[0], nil
}

// List devolve as DMs do usuário com os participantes, da atividade mais recente para a mais antiga.
func (s *Service) List(ctx context.Context, userID int64) ([]channel.Channel, error) {
	ctx, span := tracer.Start(ctx, "dm.List")
	defer span.End()
	cs, err := s.store.ListByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if err := s.fill(ctx, cs); err != nil {
		return nil, err
	}
	return cs, nil
}

func (s *Service) takeCreate(userID int64) error {
	if ok, wait := s.limiter.Take("dm:" + strconv.FormatInt(userID, 10)); !ok {
		return apperr.RateLimited("você está abrindo DMs rápido demais", wait)
	}
	return nil
}

// requireSharing exige que todos os candidatos compartilhem um servidor com userID.
func (s *Service) requireSharing(ctx context.Context, userID int64, candidates []int64) error {
	ok, err := s.store.SharingGuild(ctx, userID, candidates)
	if err != nil {
		return err
	}
	for _, c := range candidates {
		if !slices.Contains(ok, c) {
			return ErrNoSharedGuild
		}
	}
	return nil
}

// Open abre (ou devolve, se já existe) a DM 1:1 entre userID e recipientID. created diz se o canal
// foi criado agora (201) ou já existia (200).
func (s *Service) Open(ctx context.Context, userID, recipientID int64) (ch channel.Channel, created bool, err error) {
	ctx, span := tracer.Start(ctx, "dm.Open")
	defer span.End()
	if err := s.takeCreate(userID); err != nil {
		return channel.Channel{}, false, err
	}
	if userID == recipientID {
		return channel.Channel{}, false, ErrSelf
	}
	if err := s.requireSharing(ctx, userID, []int64{recipientID}); err != nil {
		return channel.Channel{}, false, err
	}
	a, b := userID, recipientID
	if a > b {
		a, b = b, a
	}
	ch, created, err = s.store.OpenPair(ctx, a, b, s.ids.Next())
	if err != nil {
		return channel.Channel{}, false, err
	}
	span.SetAttributes(attribute.Bool("created", created))
	if ch, err = s.one(ctx, ch); err != nil {
		return channel.Channel{}, false, err
	}
	if created {
		s.created.Add(ctx, 1, metric.WithAttributes(attribute.String("kind", "dm")))
		s.publish(events.ChannelCreate, ch, participantIDs(ch)...)
	}
	return ch, created, nil
}

// CreateGroup cria uma DM em grupo; quem cria é o dono. Cada convidado precisa compartilhar um
// servidor com o dono. O total (dono + convidados) vai até MaxParticipants.
func (s *Service) CreateGroup(ctx context.Context, userID int64, recipientIDs []int64) (channel.Channel, error) {
	ctx, span := tracer.Start(ctx, "dm.CreateGroup")
	defer span.End()
	if err := s.takeCreate(userID); err != nil {
		return channel.Channel{}, err
	}
	uniq := make([]int64, 0, len(recipientIDs))
	for _, id := range recipientIDs {
		if id == userID {
			return channel.Channel{}, apperr.Invalid("o dono já participa da DM em grupo: não o inclua em recipient_ids")
		}
		if !slices.Contains(uniq, id) {
			uniq = append(uniq, id)
		}
	}
	if len(uniq) == 0 {
		return channel.Channel{}, apperr.Invalid("informe pelo menos um participante")
	}
	if len(uniq)+1 > MaxParticipants {
		return channel.Channel{}, apperr.Invalid("a DM em grupo tem no máximo 10 participantes, contando você")
	}
	if err := s.requireSharing(ctx, userID, uniq); err != nil {
		return channel.Channel{}, err
	}
	ch, err := s.store.CreateGroup(ctx, s.ids.Next(), userID, append([]int64{userID}, uniq...))
	if err != nil {
		return channel.Channel{}, err
	}
	if ch, err = s.one(ctx, ch); err != nil {
		return channel.Channel{}, err
	}
	s.created.Add(ctx, 1, metric.WithAttributes(attribute.String("kind", "group")))
	s.publish(events.ChannelCreate, ch, participantIDs(ch)...)
	return ch, nil
}

// group carrega a DM e confere que o usuário participa (senão ErrNotFound).
func (s *Service) load(ctx context.Context, userID, channelID int64) (channel.Channel, error) {
	c, err := s.store.Get(ctx, channelID)
	if err != nil {
		return channel.Channel{}, err
	}
	if !c.IsDM() {
		return channel.Channel{}, ErrNotFound
	}
	ok, err := s.store.IsRecipient(ctx, channelID, userID)
	if err != nil {
		return channel.Channel{}, err
	}
	if !ok {
		return channel.Channel{}, ErrNotFound
	}
	return c, nil
}

func isOwner(c channel.Channel, userID int64) bool { return c.OwnerID != nil && *c.OwnerID == userID }

// AddRecipient adiciona targetID à DM em grupo; só o dono. Adicionar quem já participa é um no-op.
func (s *Service) AddRecipient(ctx context.Context, userID, channelID, targetID int64) (channel.Channel, error) {
	ctx, span := tracer.Start(ctx, "dm.AddRecipient")
	defer span.End()
	c, err := s.load(ctx, userID, channelID)
	if err != nil {
		return channel.Channel{}, err
	}
	if c.Type != channel.TypeGroupDM {
		return channel.Channel{}, ErrNotAGroup
	}
	if !isOwner(c, userID) {
		return channel.Channel{}, ErrOnlyOwner
	}
	if err := s.requireSharing(ctx, userID, []int64{targetID}); err != nil {
		return channel.Channel{}, err
	}
	added, err := s.store.AddRecipient(ctx, channelID, targetID, MaxParticipants)
	if err != nil {
		return channel.Channel{}, err
	}
	c, err = s.one(ctx, c)
	if err != nil {
		return channel.Channel{}, err
	}
	if added {
		// O novo participante recebe o canal (o gateway o assina); os demais, a lista nova.
		s.publish(events.ChannelCreate, c, targetID)
		s.publish(events.ChannelUpdate, c, without(participantIDs(c), targetID)...)
	}
	return c, nil
}

// RemoveRecipient remove targetID da DM em grupo: o dono remove qualquer participante (menos
// ele mesmo) e cada participante pode sair (targetID == userID). O dono não sai.
func (s *Service) RemoveRecipient(ctx context.Context, userID, channelID, targetID int64) error {
	ctx, span := tracer.Start(ctx, "dm.RemoveRecipient")
	defer span.End()
	c, err := s.load(ctx, userID, channelID)
	if err != nil {
		return err
	}
	if c.Type != channel.TypeGroupDM {
		return ErrNotAGroup
	}
	if isOwner(c, targetID) {
		return ErrOwnerStays
	}
	if targetID != userID && !isOwner(c, userID) {
		return ErrOnlyOwner
	}
	removed, err := s.store.RemoveRecipient(ctx, channelID, targetID)
	if err != nil {
		return err
	}
	if !removed {
		return apperr.NotFound("participante não encontrado")
	}
	c, err = s.one(ctx, c)
	if err != nil {
		return err
	}
	// Quem saiu perde o canal (o gateway cancela a assinatura); os demais recebem a lista nova.
	s.publish(events.ChannelDelete, c, targetID)
	s.publish(events.ChannelUpdate, c, participantIDs(c)...)
	return nil
}

// Rename renomeia a DM em grupo; só o dono.
func (s *Service) Rename(ctx context.Context, userID, channelID int64, name string) (channel.Channel, error) {
	ctx, span := tracer.Start(ctx, "dm.Rename")
	defer span.End()
	c, err := s.load(ctx, userID, channelID)
	if err != nil {
		return channel.Channel{}, err
	}
	if c.Type != channel.TypeGroupDM {
		return channel.Channel{}, apperr.Invalid("DMs 1:1 não têm nome")
	}
	if !isOwner(c, userID) {
		return channel.Channel{}, ErrOnlyOwner
	}
	n, ok := httpx.Name(name, 1, 100)
	if !ok {
		return channel.Channel{}, apperr.Invalid("o nome da DM deve ter de 1 a 100 caracteres")
	}
	c, err = s.store.Rename(ctx, channelID, n)
	if err != nil {
		return channel.Channel{}, err
	}
	if c, err = s.one(ctx, c); err != nil {
		return channel.Channel{}, err
	}
	s.publish(events.ChannelUpdate, c, participantIDs(c)...)
	return c, nil
}

func participantIDs(c channel.Channel) []int64 {
	ids := make([]int64, len(c.Recipients))
	for i, r := range c.Recipients {
		ids[i] = r.ID
	}
	return ids
}

func without(ids []int64, id int64) []int64 {
	out := make([]int64, 0, len(ids))
	for _, i := range ids {
		if i != id {
			out = append(out, i)
		}
	}
	return out
}

// publish entrega o evento no tópico user:<id> de cada destinatário.
func (s *Service) publish(typ string, c channel.Channel, users ...int64) {
	if len(users) == 0 {
		return
	}
	topics := make([]string, len(users))
	for i, u := range users {
		topics[i] = "user:" + strconv.FormatInt(u, 10)
	}
	s.pub.Publish(events.Event{Type: typ, ChannelID: c.ID, Topics: topics, Data: c.Payload()})
}
