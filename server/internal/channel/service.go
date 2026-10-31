package channel

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"go.opentelemetry.io/otel"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

var tracer = otel.Tracer("spook/channel")

// Store é o que o service precisa do banco.
type Store interface {
	Create(ctx context.Context, c Channel) (Channel, error)
	Get(ctx context.Context, id int64) (Channel, error) // ErrNotFound
	ListByGuild(ctx context.Context, guildID int64) ([]Channel, error)
	ListByGuilds(ctx context.Context, guildIDs []int64) (map[int64][]Channel, error)
	NextPosition(ctx context.Context, guildID int64) (int32, error)
	Update(ctx context.Context, id int64, name string, position int32) (Channel, error)
	UpdatePlacements(ctx context.Context, guildID int64, ps []Placement) error
	Delete(ctx context.Context, id int64) error
}

// Access é o que channel precisa do servidor: o membro com as permissões efetivas.
// Devolve perm.ErrNotMember se o usuário não pertence ao servidor.
type Access interface {
	Member(ctx context.Context, guildID, userID int64) (perm.Member, error)
}

// DMs é o que channel precisa das DMs (implementada pelo dm.Service): quem participa de uma DM
// e o renomear de uma DM em grupo.
type DMs interface {
	IsRecipient(ctx context.Context, channelID, userID int64) (bool, error)
	Rename(ctx context.Context, userID, channelID int64, name string) (Channel, error)
}

type IDGenerator interface{ Next() int64 }

type Service struct {
	store  Store
	access Access
	ids    IDGenerator
	pub    events.Publisher
	dms    DMs
}

// SetDMs liga o suporte a DMs (feito na montagem; sem isso, DMs são "canais inexistentes").
func (s *Service) SetDMs(d DMs) { s.dms = d }

func NewService(store Store, access Access, ids IDGenerator, pub events.Publisher) *Service {
	return &Service{store: store, access: access, ids: ids, pub: pub}
}

// ListByGuild e ListByGuilds são de uso interno (sem checagem de acesso): quem chama já autorizou.
func (s *Service) ListByGuild(ctx context.Context, guildID int64) ([]Channel, error) {
	return s.store.ListByGuild(ctx, guildID)
}

func (s *Service) ListByGuilds(ctx context.Context, guildIDs []int64) (map[int64][]Channel, error) {
	return s.store.ListByGuilds(ctx, guildIDs)
}

// List devolve os canais do servidor, ordenados, para quem é membro e pode ver canais.
func (s *Service) List(ctx context.Context, userID, guildID int64) ([]Channel, error) {
	m, err := s.access.Member(ctx, guildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return nil, apperr.NotFound("servidor não encontrado")
	}
	if err != nil {
		return nil, err
	}
	if !m.Has(perm.ViewChannel) {
		return nil, ErrForbidden
	}
	return s.store.ListByGuild(ctx, guildID)
}

// Authorize devolve o canal se o usuário pode acessá-lo. Canal de servidor: membro com as
// permissões need (VIEW_CHANNEL é sempre exigida); não-membro e canal inexistente dão
// ErrNotFound, membro sem permissão dá ErrForbidden. DM: basta ser participante (sem cargos;
// need é ignorada, o membro devolvido é vazio); quem não participa recebe ErrNotFound.
// Usado pelas mensagens e pelo "digitando".
func (s *Service) Authorize(ctx context.Context, userID, channelID int64, need perm.Perm) (Channel, perm.Member, error) {
	ch, err := s.store.Get(ctx, channelID)
	if err != nil {
		return Channel{}, perm.Member{}, err
	}
	if ch.GuildID == nil {
		if !ch.IsDM() || s.dms == nil {
			return Channel{}, perm.Member{}, ErrNotFound
		}
		ok, err := s.dms.IsRecipient(ctx, channelID, userID)
		if err != nil {
			return Channel{}, perm.Member{}, err
		}
		if !ok {
			return Channel{}, perm.Member{}, ErrNotFound
		}
		return ch, perm.Member{}, nil
	}
	m, err := s.access.Member(ctx, *ch.GuildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return Channel{}, perm.Member{}, ErrNotFound
	}
	if err != nil {
		return Channel{}, perm.Member{}, err
	}
	if !m.Has(perm.ViewChannel | need) {
		return Channel{}, perm.Member{}, ErrForbidden
	}
	return ch, m, nil
}

// manage exige MANAGE_CHANNELS no servidor; não-membro vê o servidor como inexistente.
func (s *Service) manage(ctx context.Context, userID, guildID int64) error {
	m, err := s.access.Member(ctx, guildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return apperr.NotFound("servidor não encontrado")
	}
	if err != nil {
		return err
	}
	if !m.Has(perm.ManageChannels) {
		return ErrForbidden
	}
	return nil
}

type CreateParams struct {
	Type     Type
	Name     string
	ParentID *int64
	Position *int32
}

func (s *Service) Create(ctx context.Context, userID, guildID int64, in CreateParams) (Channel, error) {
	ctx, span := tracer.Start(ctx, "channel.Create")
	defer span.End()
	if err := s.manage(ctx, userID, guildID); err != nil {
		return Channel{}, err
	}
	if in.Type != TypeText && in.Type != TypeVoice && in.Type != TypeCategory {
		return Channel{}, apperr.Invalid("tipo de canal inválido: use 0 (texto), 1 (voz) ou 2 (categoria)")
	}
	name, ok := httpx.Name(in.Name, 1, 100)
	if !ok {
		return Channel{}, apperr.Invalid("o nome do canal deve ter de 1 a 100 caracteres")
	}
	if in.Position != nil && *in.Position < 0 {
		return Channel{}, apperr.Invalid("a posição não pode ser negativa")
	}
	all, err := s.store.ListByGuild(ctx, guildID)
	if err != nil {
		return Channel{}, err
	}
	if in.ParentID != nil {
		if in.Type == TypeCategory {
			return Channel{}, apperr.Invalid("uma categoria não pode estar dentro de outra")
		}
		if err := checkParent(all, *in.ParentID); err != nil {
			return Channel{}, err
		}
	}
	var pos int32
	if in.Position != nil {
		pos = *in.Position
	} else if pos, err = s.store.NextPosition(ctx, guildID); err != nil {
		return Channel{}, err
	}
	c, err := s.store.Create(ctx, Channel{
		ID: s.ids.Next(), Type: in.Type, GuildID: &guildID, ParentID: in.ParentID, Name: name, Position: pos,
	})
	if err != nil {
		return Channel{}, err
	}
	s.publish(events.ChannelCreate, c)
	return c, nil
}

// checkParent exige que parentID seja uma categoria do mesmo servidor.
func checkParent(guildChannels []Channel, parentID int64) error {
	for _, c := range guildChannels {
		if c.ID == parentID {
			if c.Type != TypeCategory {
				return apperr.Invalid("só uma categoria pode ser pai de canais")
			}
			return nil
		}
	}
	return apperr.Invalid("categoria não encontrada neste servidor")
}

type UpdateParams struct {
	Name     *string
	Position *int32
}

func (s *Service) Update(ctx context.Context, userID, channelID int64, in UpdateParams) (Channel, error) {
	ctx, span := tracer.Start(ctx, "channel.Update")
	defer span.End()
	if c, err := s.store.Get(ctx, channelID); err == nil && c.GuildID == nil {
		return s.updateDM(ctx, userID, c, in)
	}
	cur, err := s.guildChannel(ctx, userID, channelID)
	if err != nil {
		return Channel{}, err
	}
	name, pos := cur.Name, cur.Position
	if in.Name != nil {
		n, ok := httpx.Name(*in.Name, 1, 100)
		if !ok {
			return Channel{}, apperr.Invalid("o nome do canal deve ter de 1 a 100 caracteres")
		}
		name = n
	}
	if in.Position != nil {
		if *in.Position < 0 {
			return Channel{}, apperr.Invalid("a posição não pode ser negativa")
		}
		pos = *in.Position
	}
	c, err := s.store.Update(ctx, channelID, name, pos)
	if err != nil {
		return Channel{}, err
	}
	s.publish(events.ChannelUpdate, c)
	return c, nil
}

// updateDM trata o PATCH de uma DM: só a DM em grupo tem nome, e só o dono o altera.
func (s *Service) updateDM(ctx context.Context, userID int64, c Channel, in UpdateParams) (Channel, error) {
	if s.dms == nil || !c.IsDM() {
		return Channel{}, ErrNotFound
	}
	ok, err := s.dms.IsRecipient(ctx, c.ID, userID)
	if err != nil {
		return Channel{}, err
	}
	if !ok {
		return Channel{}, ErrNotFound
	}
	if c.Type != TypeGroupDM {
		return Channel{}, apperr.Invalid("DMs 1:1 não têm nome nem posição")
	}
	if in.Position != nil {
		return Channel{}, apperr.Invalid("a posição não se aplica a DMs")
	}
	if in.Name == nil {
		return Channel{}, apperr.Invalid("informe o novo nome da DM em grupo")
	}
	return s.dms.Rename(ctx, userID, c.ID, *in.Name)
}

func (s *Service) Delete(ctx context.Context, userID, channelID int64) error {
	ctx, span := tracer.Start(ctx, "channel.Delete")
	defer span.End()
	cur, err := s.guildChannel(ctx, userID, channelID)
	if err != nil {
		return err
	}
	var children []Channel
	if cur.Type == TypeCategory {
		all, err := s.store.ListByGuild(ctx, *cur.GuildID)
		if err != nil {
			return err
		}
		for _, c := range all {
			if c.ParentID != nil && *c.ParentID == cur.ID {
				c.ParentID = nil // o banco solta os filhos da categoria excluída
				children = append(children, c)
			}
		}
	}
	if err := s.store.Delete(ctx, channelID); err != nil {
		return err
	}
	s.publish(events.ChannelDelete, cur)
	for _, c := range children {
		s.publish(events.ChannelUpdate, c)
	}
	return nil
}

// guildChannel carrega um canal de servidor e exige MANAGE_CHANNELS nele.
func (s *Service) guildChannel(ctx context.Context, userID, channelID int64) (Channel, error) {
	c, err := s.store.Get(ctx, channelID)
	if err != nil {
		return Channel{}, err
	}
	if c.GuildID == nil {
		return Channel{}, ErrNotFound
	}
	if err := s.manage(ctx, userID, *c.GuildID); err != nil {
		if apperr.IsKind(err, apperr.KindNotFound) {
			return Channel{}, ErrNotFound
		}
		return Channel{}, err
	}
	return c, nil
}

// Placement é o novo lugar de um canal: posição e categoria (nil = fora de categoria).
type Placement struct {
	ID       int64
	Position int32
	ParentID *int64
}

// Reorder aplica posições e categorias em lote e devolve os canais do servidor já ordenados.
func (s *Service) Reorder(ctx context.Context, userID, guildID int64, ps []Placement) ([]Channel, error) {
	ctx, span := tracer.Start(ctx, "channel.Reorder")
	defer span.End()
	if err := s.manage(ctx, userID, guildID); err != nil {
		return nil, err
	}
	all, err := s.store.ListByGuild(ctx, guildID)
	if err != nil {
		return nil, err
	}
	byID := make(map[int64]Channel, len(all))
	for _, c := range all {
		byID[c.ID] = c
	}
	seen := map[int64]bool{}
	for _, p := range ps {
		c, ok := byID[p.ID]
		switch {
		case !ok:
			return nil, apperr.Invalid(fmt.Sprintf("canal %d não pertence a este servidor", p.ID))
		case seen[p.ID]:
			return nil, apperr.Invalid(fmt.Sprintf("canal %d repetido", p.ID))
		case p.Position < 0:
			return nil, apperr.Invalid("a posição não pode ser negativa")
		case p.ParentID != nil && c.Type == TypeCategory:
			return nil, apperr.Invalid("uma categoria não pode estar dentro de outra")
		}
		seen[p.ID] = true
		if p.ParentID != nil {
			if err := checkParent(all, *p.ParentID); err != nil {
				return nil, err
			}
		}
	}
	if len(ps) > 0 {
		if err := s.store.UpdatePlacements(ctx, guildID, ps); err != nil {
			return nil, err
		}
	}
	out, err := s.store.ListByGuild(ctx, guildID)
	if err != nil {
		return nil, err
	}
	for _, c := range out {
		if seen[c.ID] {
			s.publish(events.ChannelUpdate, c)
		}
	}
	return out, nil
}

func (s *Service) publish(typ string, c Channel) {
	var guildID int64
	if c.GuildID != nil {
		guildID = *c.GuildID
	}
	s.pub.Publish(events.Event{
		Type: typ, GuildID: guildID, ChannelID: c.ID,
		Topics: []string{"guild:" + strconv.FormatInt(guildID, 10)}, Data: c.Payload(),
	})
}
