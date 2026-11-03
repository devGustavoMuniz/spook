package guild

import (
	"context"
	"errors"
	"strings"
	"unicode"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// Moderação (adicional): banir/desbanir, apelido por servidor e mute de voz. Toda ação é autorizada aqui:
// permissão do cargo + hierarquia (dono > cargos por posição; ninguém age sobre quem tem cargo igual ou
// superior; o dono nunca é alvo). Administrador do painel /admin NÃO é moderador: o painel não passa por aqui.

// Ban bane targetID (membro ou não), com motivo opcional. Exige BAN_MEMBERS; se for membro, hierarquia. O membro
// é removido na mesma transação; as conexões dele deixam de receber o servidor (GUILD_DELETE) e a voz o derruba.
func (s *Service) Ban(ctx context.Context, actorID, guildID, targetID int64, reason string) error {
	ctx, span := tracer.Start(ctx, "guild.Ban")
	defer span.End()
	actor, err := s.require(ctx, guildID, actorID, perm.BanMembers)
	if err != nil {
		return err
	}
	if actorID == targetID {
		return ErrSelfModeration
	}
	reason = strings.TrimSpace(reason)
	if httpx.Runes(reason) > MaxBanReasonRunes {
		return apperr.Invalid("o motivo deve ter até 512 caracteres")
	}
	target, err := s.Member(ctx, guildID, targetID)
	switch {
	case err == nil:
		if !actor.CanModerate(perm.BanMembers, target) {
			return apperr.Forbidden("você não pode banir este membro")
		}
	case errors.Is(err, perm.ErrNotMember):
		ok, uerr := s.store.UserExists(ctx, targetID)
		if uerr != nil {
			return uerr
		}
		if !ok {
			return apperr.NotFound("usuário não encontrado")
		}
		if owner, gerr := s.store.Get(ctx, guildID); gerr != nil {
			return gerr
		} else if owner.OwnerID == targetID {
			return apperr.Forbidden("o dono do servidor não pode ser banido")
		}
	default:
		return err
	}
	if err := s.take(actorID); err != nil {
		return err
	}
	name := s.memberName(ctx, guildID, targetID)
	var r *string
	if reason != "" {
		r = &reason
	}
	wasMember, err := s.store.Ban(ctx, guildID, targetID, actorID, r)
	if err != nil {
		return err
	}
	if wasMember {
		s.publishRemoved(guildID, targetID)
	}
	if name == "" {
		name = s.banName(ctx, guildID, targetID)
	}
	s.record(ctx, audit.Entry{
		GuildID: guildID, ActorID: actorID, Action: audit.MemberBan, TargetType: audit.TargetMember, TargetID: targetID,
		Reason: reason, Changes: map[string]any{"target_name": name, "was_member": wasMember},
	})
	return nil
}

// banName é o username de quem está banido (o nome legível para a auditoria quando não há mais membro).
func (s *Service) banName(ctx context.Context, guildID, userID int64) string {
	b, err := s.store.Bans(ctx, guildID, userID-1, 1)
	if err == nil && len(b) > 0 && b[0].UserID == userID {
		return b[0].Username
	}
	return ""
}

// Unban desfaz o banimento (BAN_MEMBERS). A pessoa não volta sozinha: precisa de um convite novo.
func (s *Service) Unban(ctx context.Context, actorID, guildID, targetID int64) error {
	ctx, span := tracer.Start(ctx, "guild.Unban")
	defer span.End()
	if _, err := s.require(ctx, guildID, actorID, perm.BanMembers); err != nil {
		return err
	}
	if err := s.take(actorID); err != nil {
		return err
	}
	name := s.banName(ctx, guildID, targetID)
	if err := s.store.Unban(ctx, guildID, targetID); err != nil {
		return err
	}
	s.record(ctx, audit.Entry{
		GuildID: guildID, ActorID: actorID, Action: audit.MemberUnban, TargetType: audit.TargetMember, TargetID: targetID,
		Changes: map[string]any{"target_name": name},
	})
	return nil
}

// Bans lista os banimentos do servidor por ID de usuário, com cursor `after` (BAN_MEMBERS).
func (s *Service) Bans(ctx context.Context, userID, guildID, after int64, limit int) ([]Ban, error) {
	ctx, span := tracer.Start(ctx, "guild.Bans")
	defer span.End()
	if _, err := s.require(ctx, guildID, userID, perm.BanMembers); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > maxPageSize {
		limit = 100
	}
	bans, err := s.store.Bans(ctx, guildID, after, limit)
	if err != nil {
		return nil, err
	}
	for i := range bans {
		bans[i].AvatarURL = s.avatars.AvatarURLForKey(ctx, bans[i].AvatarKey)
	}
	return bans, nil
}

// SetNickname muda o apelido no servidor. O próprio membro precisa de CHANGE_NICKNAME (ou MANAGE_NICKNAMES);
// o de outro exige MANAGE_NICKNAMES + hierarquia. nick vazio remove o apelido (volta ao nome de exibição).
func (s *Service) SetNickname(ctx context.Context, actorID, guildID, targetID int64, nick string) (Member, error) {
	ctx, span := tracer.Start(ctx, "guild.SetNickname")
	defer span.End()
	actor, err := s.member(ctx, guildID, actorID)
	if err != nil {
		return Member{}, err
	}
	nick = strings.TrimSpace(nick)
	var value *string
	if nick != "" {
		if n := httpx.Runes(nick); n < 1 || n > MaxNickRunes || strings.IndexFunc(nick, unicode.IsControl) >= 0 {
			return Member{}, apperr.Invalid("o apelido deve ter de 1 a 32 caracteres, sem caracteres de controle")
		}
		value = &nick
	}
	self := actorID == targetID
	if self {
		if !actor.Has(perm.ChangeNickname) && !actor.Has(perm.ManageNicknames) {
			return Member{}, ErrForbidden
		}
	} else {
		if !actor.Has(perm.ManageNicknames) {
			return Member{}, ErrForbidden
		}
		target, err := s.Member(ctx, guildID, targetID)
		if errors.Is(err, perm.ErrNotMember) {
			return Member{}, ErrMemberNotFound
		}
		if err != nil {
			return Member{}, err
		}
		if !actor.CanModerate(perm.ManageNicknames, target) {
			return Member{}, apperr.Forbidden("você não pode mudar o apelido deste membro")
		}
	}
	if err := s.take(actorID); err != nil {
		return Member{}, err
	}
	old, err := s.store.Member(ctx, guildID, targetID)
	if err != nil {
		return Member{}, err
	}
	if err := s.store.SetNickname(ctx, guildID, targetID, value); err != nil {
		return Member{}, err
	}
	m, err := s.store.Member(ctx, guildID, targetID)
	if err != nil {
		return Member{}, err
	}
	m.AvatarURL, m.BannerURL = s.avatars.AvatarURLForKey(ctx, m.AvatarKey), s.avatars.AvatarURLForKey(ctx, m.BannerKey)
	s.publish(events.GuildMemberUpdate, guildID, m.Payload())
	if !self {
		s.record(ctx, audit.Entry{
			GuildID: guildID, ActorID: actorID, Action: audit.MemberNick, TargetType: audit.TargetMember, TargetID: targetID,
			Changes: map[string]any{"target_name": displayName(m), "nickname": map[string]any{"from": old.Nickname, "to": m.Nickname}},
		})
	}
	return m, nil
}

// SetVoiceMuted liga ou desliga o mute de voz imposto por moderador (MUTE_MEMBERS + hierarquia). É persistente:
// vale também na próxima vez que a pessoa entrar. A voz reavalia a sala ao receber GUILD_MEMBER_UPDATE.
func (s *Service) SetVoiceMuted(ctx context.Context, actorID, guildID, targetID int64, muted bool) (Member, error) {
	ctx, span := tracer.Start(ctx, "guild.SetVoiceMuted")
	defer span.End()
	actor, err := s.require(ctx, guildID, actorID, perm.MuteMembers)
	if err != nil {
		return Member{}, err
	}
	if actorID == targetID {
		return Member{}, ErrSelfModeration
	}
	target, err := s.Member(ctx, guildID, targetID)
	if errors.Is(err, perm.ErrNotMember) {
		return Member{}, ErrMemberNotFound
	}
	if err != nil {
		return Member{}, err
	}
	if !actor.CanModerate(perm.MuteMembers, target) {
		return Member{}, apperr.Forbidden("você não pode mutar este membro")
	}
	if err := s.take(actorID); err != nil {
		return Member{}, err
	}
	if err := s.store.SetVoiceMuted(ctx, guildID, targetID, muted); err != nil {
		return Member{}, err
	}
	m, err := s.store.Member(ctx, guildID, targetID)
	if err != nil {
		return Member{}, err
	}
	m.AvatarURL, m.BannerURL = s.avatars.AvatarURLForKey(ctx, m.AvatarKey), s.avatars.AvatarURLForKey(ctx, m.BannerKey)
	s.publish(events.GuildMemberUpdate, guildID, m.Payload())
	act := audit.VoiceMute
	if !muted {
		act = audit.VoiceUnmute
	}
	s.record(ctx, audit.Entry{
		GuildID: guildID, ActorID: actorID, Action: act, TargetType: audit.TargetMember, TargetID: targetID,
		Changes: map[string]any{"target_name": displayName(m)},
	})
	return m, nil
}

// CanModerateVoice diz se o ator pode agir sobre o alvo na voz (usado pelo voice para desconectar): exige a
// permissão need e a hierarquia. ErrNotFound/ErrMemberNotFound conforme o caso.
func (s *Service) CanModerateVoice(ctx context.Context, actorID, guildID, targetID int64, need perm.Perm) error {
	actor, err := s.require(ctx, guildID, actorID, need)
	if err != nil {
		return err
	}
	if actorID == targetID {
		return ErrSelfModeration
	}
	target, err := s.Member(ctx, guildID, targetID)
	if errors.Is(err, perm.ErrNotMember) {
		return ErrMemberNotFound
	}
	if err != nil {
		return err
	}
	if !actor.CanModerate(need, target) {
		return apperr.Forbidden("você não pode fazer isso com este membro")
	}
	if err := s.take(actorID); err != nil {
		return err
	}
	return nil
}

// RecordVoiceDisconnect grava a desconexão forçada na auditoria (chamada pelo voice via app).
func (s *Service) RecordVoiceDisconnect(ctx context.Context, actorID, guildID, targetID, channelID int64) {
	s.record(ctx, audit.Entry{
		GuildID: guildID, ActorID: actorID, Action: audit.VoiceDisconnect, TargetType: audit.TargetMember, TargetID: targetID,
		Changes: map[string]any{"target_name": s.memberName(ctx, guildID, targetID), "channel_id": httpx.ID(channelID)},
	})
}
