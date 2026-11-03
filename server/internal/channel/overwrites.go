package channel

import (
	"context"
	"errors"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// Permissões por canal (overwrites). Regras:
//   - editar exige MANAGE_CHANNELS no servidor e VIEW_CHANNEL efetivo no canal (dono e ADMINISTRATOR passam);
//   - só bits de perm.ChannelScoped; allow e deny não se sobrepõem;
//   - o alvo precisa estar abaixo do editor na hierarquia (o @everyone não tem hierarquia); o dono do servidor
//     não é alvo (ele ignora overwrites);
//   - o editor só pode PERMITIR o que ele mesmo tem no canal (negar é livre dentro da hierarquia).

var errBadOverwrite = apperr.Invalid("permissões de canal inválidas: use só as permissões de canal (ver, enviar mensagens, gerenciar mensagens, anexos, conectar, falar, vídeo), sem repetir a mesma em permitir e negar")

// OverwriteView é um overwrite com o nome do alvo (para o editor).
type OverwriteView struct {
	perm.Overwrite
}

// OverwritePayload é um overwrite na API.
type OverwritePayload struct {
	Type     string `json:"type" enum:"role,member" doc:"role (o @everyone tem o ID do servidor) ou member"`
	TargetID string `json:"target_id"`
	Allow    int64  `json:"allow" doc:"Permissões permitidas (bitflags de canal)"`
	Deny     int64  `json:"deny" doc:"Permissões negadas (bitflags de canal)"`
}

func (o OverwriteView) Payload() OverwritePayload {
	return OverwritePayload{Type: string(o.Type), TargetID: httpx.ID(o.TargetID), Allow: int64(o.Allow), Deny: int64(o.Deny)}
}

// guildChannelFor carrega o canal de servidor para editar overwrites, devolvendo o canal e o editor já com a
// permissão efetiva nele.
func (s *Service) guildChannelFor(ctx context.Context, userID, channelID int64) (Channel, perm.Member, []perm.Overwrite, error) {
	ch, err := s.store.Get(ctx, channelID)
	if err != nil {
		return Channel{}, perm.Member{}, nil, err
	}
	if ch.GuildID == nil {
		return Channel{}, perm.Member{}, nil, ErrNotFound
	}
	m, err := s.access.Member(ctx, *ch.GuildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return Channel{}, perm.Member{}, nil, ErrNotFound
	}
	if err != nil {
		return Channel{}, perm.Member{}, nil, err
	}
	ows, err := s.store.Overwrites(ctx, channelID)
	if err != nil {
		return Channel{}, perm.Member{}, nil, err
	}
	eff := m.InChannel(ows)
	if !eff.Has(perm.ViewChannel) {
		return Channel{}, perm.Member{}, nil, ErrNotFound // não vê o canal: ele "não existe" para a pessoa
	}
	if !m.Has(perm.ManageChannels) {
		return Channel{}, perm.Member{}, nil, ErrForbidden
	}
	return ch, eff, ows, nil
}

// Overwrites lista os overwrites do canal (MANAGE_CHANNELS).
func (s *Service) Overwrites(ctx context.Context, userID, channelID int64) ([]OverwriteView, error) {
	ctx, span := tracer.Start(ctx, "channel.Overwrites")
	defer span.End()
	_, _, ows, err := s.guildChannelFor(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	out := make([]OverwriteView, len(ows))
	for i, o := range ows {
		out[i] = OverwriteView{o}
	}
	return out, nil
}

// SetOverwrite cria ou troca o overwrite de um alvo. allow=deny=0 remove (herda tudo).
func (s *Service) SetOverwrite(ctx context.Context, userID, channelID int64, t perm.TargetType, targetID int64, allow, deny perm.Perm) (OverwriteView, error) {
	ctx, span := tracer.Start(ctx, "channel.SetOverwrite")
	defer span.End()
	if t != perm.TargetRole && t != perm.TargetMember {
		return OverwriteView{}, apperr.Invalid("tipo de alvo inválido: use role ou member")
	}
	if !allow.Valid() || !deny.Valid() || (allow|deny)&^perm.ChannelScoped != 0 || allow&deny != 0 {
		return OverwriteView{}, errBadOverwrite
	}
	ch, actor, ows, err := s.guildChannelFor(ctx, userID, channelID)
	if err != nil {
		return OverwriteView{}, err
	}
	if err := s.take(userID); err != nil {
		return OverwriteView{}, err
	}
	target, err := s.access.OverwriteTarget(ctx, *ch.GuildID, t, targetID)
	if err != nil {
		return OverwriteView{}, err
	}
	if target.IsOwner {
		return OverwriteView{}, apperr.Invalid("o dono do servidor ignora as permissões por canal")
	}
	var old perm.Overwrite
	for _, o := range ows {
		if o.Type == t && o.TargetID == targetID {
			old = o
		}
	}
	if !actor.CanEditOverwrite(target.Everyone, target.Rank, old.Allow, allow) {
		return OverwriteView{}, apperr.Forbidden("você só pode editar permissões de cargos e membros abaixo do seu cargo mais alto e só pode permitir o que você mesmo tem neste canal")
	}
	o := perm.Overwrite{Type: t, TargetID: targetID, Allow: allow, Deny: deny}
	if err := s.store.SetOverwrite(ctx, channelID, o); err != nil {
		return OverwriteView{}, err
	}
	s.publishOverwrites(ch)
	act := audit.OverwriteUpdate
	if allow == 0 && deny == 0 {
		act = audit.OverwriteDelete
	}
	s.record(ctx, audit.Entry{
		GuildID: *ch.GuildID, ActorID: userID, Action: act, TargetType: audit.TargetChannel, TargetID: ch.ID,
		Changes: map[string]any{
			"target_name": ch.Name, "overwrite_type": string(t), "overwrite_target": httpx.ID(targetID), "overwrite_target_name": target.Name,
			"allow": map[string]any{"from": int64(old.Allow), "to": int64(allow)},
			"deny":  map[string]any{"from": int64(old.Deny), "to": int64(deny)},
		},
	})
	return OverwriteView{o}, nil
}

// DeleteOverwrite remove o overwrite de um alvo (idempotente).
func (s *Service) DeleteOverwrite(ctx context.Context, userID, channelID int64, t perm.TargetType, targetID int64) error {
	_, err := s.SetOverwrite(ctx, userID, channelID, t, targetID, 0, 0)
	return err
}

// MyPermissions devolve as permissões efetivas do usuário no canal (membro que não vê o canal: NotFound).
func (s *Service) MyPermissions(ctx context.Context, userID, channelID int64) (perm.Perm, error) {
	ch, m, err := s.Authorize(ctx, userID, channelID, 0)
	if err != nil {
		return 0, err
	}
	if ch.IsDM() {
		return perm.ViewChannel | perm.SendMessages | perm.AttachFiles | perm.Connect | perm.Speak | perm.Video, nil
	}
	return m.Perms, nil
}

// publishOverwrites avisa (evento interno) que quem vê o canal pode ter mudado: o gateway e a voz reavaliam.
func (s *Service) publishOverwrites(c Channel) {
	s.pub.Publish(events.Event{
		Type: events.ChannelOverwritesUpdate, GuildID: *c.GuildID, ChannelID: c.ID,
		Topics: []string{"guild:" + httpx.ID(*c.GuildID)}, Data: c.Payload(),
	})
}
