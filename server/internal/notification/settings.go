package notification

import (
	"context"
	"strconv"
	"time"

	"go.opentelemetry.io/otel/attribute"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

// Silenciar e nível de notificação (adicional fora do SPEC; ver SPEC 5.5).
//
// Herança do nível: canal (ou DM) -> servidor -> padrão (servidor: "mentions"; DM: "all"). O silêncio vale
// se o canal OU o servidor estiverem silenciados. Silenciar e nível só afetam avisos (push, toast, som,
// notificação nativa): as contagens de não lidas e menções seguem iguais.

// Escopos das configurações.
const (
	ScopeGuild   = "guild"
	ScopeChannel = "channel" // inclui DMs e DMs em grupo
)

// Níveis de notificação.
const (
	LevelAll      = "all"
	LevelMentions = "mentions"
	LevelNone     = "none"
)

var (
	errInvalidScope   = apperr.Invalid("escopo inválido: use guild ou channel")
	errInvalidLevel   = apperr.Invalid("nível inválido: use all, mentions ou none")
	errInvalidMute    = apperr.Invalid("muted_until exige muted=true e um instante futuro")
	errSettingTarget  = apperr.NotFound("servidor ou canal não encontrado")
	errInvalidSetting = apperr.Invalid("id de destino inválido")
)

// Setting é a configuração de um alvo. Muted sem MutedUntil = "até reativar".
type Setting struct {
	Scope      string
	TargetID   int64
	Muted      bool
	MutedUntil *time.Time
	Level      *string
}

// ActiveMute diz se o silêncio vale em now (vencido deixa de valer sem precisar de job).
func (s Setting) ActiveMute(now time.Time) bool {
	return s.Muted && (s.MutedUntil == nil || now.Before(*s.MutedUntil))
}

// SettingPayload é uma configuração na API, no READY e em NOTIFICATION_SETTINGS_UPDATE. Voltar ao padrão
// (DELETE) publica muted=false e level nulo.
type SettingPayload struct {
	Scope      string     `json:"scope" enum:"guild,channel" doc:"guild, ou channel (canal de servidor, DM ou DM em grupo)"`
	TargetID   string     `json:"target_id"`
	Muted      bool       `json:"muted" doc:"Silenciado (vale até muted_until; sem muted_until, até reativar)"`
	MutedUntil *time.Time `json:"muted_until" nullable:"true" doc:"Fim do silêncio; nulo com muted=true = até reativar"`
	Level      *string    `json:"level" nullable:"true" enum:"all,mentions,none" doc:"Nível de notificação; nulo = herda (canal -> servidor -> padrão)"`
}

func (s Setting) payload(now time.Time) SettingPayload {
	p := SettingPayload{Scope: s.Scope, TargetID: strconv.FormatInt(s.TargetID, 10), Level: s.Level}
	if s.ActiveMute(now) {
		p.Muted, p.MutedUntil = true, s.MutedUntil
	}
	return p
}

// DefaultLevel é o nível quando nem o canal nem o servidor definem um.
func DefaultLevel(isGuild bool) string {
	if isGuild {
		return LevelMentions
	}
	return LevelAll
}

// Allows diz se uma mensagem avisa: silenciado nunca avisa; "all" avisa sempre; "mentions" só com menção
// direta; "none" nunca. (@everyone e @here não existem neste projeto: são só usernames, então não há o
// que suprimir além da menção direta.)
func Allows(muted bool, level string, mention bool) bool {
	if muted {
		return false
	}
	switch level {
	case LevelAll:
		return true
	case LevelMentions:
		return mention
	default:
		return false
	}
}

// Resolve calcula o silêncio e o nível efetivos a partir das configurações do canal e do servidor (nulas = padrão).
func Resolve(now time.Time, channel, guild *Setting, isGuild bool) (muted bool, level string) {
	level = DefaultLevel(isGuild)
	if guild != nil {
		muted = guild.ActiveMute(now)
		if guild.Level != nil {
			level = *guild.Level
		}
	}
	if channel != nil {
		muted = muted || channel.ActiveMute(now)
		if channel.Level != nil {
			level = *channel.Level
		}
	}
	return muted, level
}

// NotifyFilter reúne o que decide o aviso de um destinatário.
type NotifyFilter struct {
	UserID  int64
	DND     bool     // status_pref = dnd
	Channel *Setting // nulo = sem configuração
	Guild   *Setting
}

// SettingInput é o corpo do PUT.
type SettingInput struct {
	Muted      bool
	MutedUntil *time.Time
	Level      *string
}

// ListSettings devolve as configurações do usuário que diferem do padrão (silêncios vencidos sem nível somem).
func (s *Service) ListSettings(ctx context.Context, userID int64) ([]SettingPayload, error) {
	ctx, span := tracer.Start(ctx, "notification.ListSettings")
	defer span.End()
	rows, err := s.Store.ListSettings(ctx, userID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	out := make([]SettingPayload, 0, len(rows))
	for _, r := range rows {
		if p := r.payload(now); p.Muted || p.Level != nil {
			out = append(out, p)
		}
	}
	span.SetAttributes(attribute.Int("settings", len(out)))
	return out, nil
}

// ReadySettings são as configurações do READY (mesma lista do GET).
func (s *Service) ReadySettings(ctx context.Context, userID int64) ([]SettingPayload, error) {
	return s.ListSettings(ctx, userID)
}

func (s *Service) authorizeTarget(ctx context.Context, userID int64, scope string, target int64) error {
	switch scope {
	case ScopeGuild:
		ok, err := s.Store.IsGuildMember(ctx, target, userID)
		if err != nil {
			return err
		}
		if !ok {
			return errSettingTarget
		}
	case ScopeChannel:
		if _, _, err := s.Channels.Authorize(ctx, userID, target, 0); err != nil {
			return err
		}
	default:
		return errInvalidScope
	}
	return nil
}

// PutSetting grava (ou substitui) a configuração do alvo e avisa as sessões do usuário. Sem silêncio e sem
// nível equivale a voltar ao padrão (a linha é apagada).
func (s *Service) PutSetting(ctx context.Context, userID int64, scope string, target int64, in SettingInput) (SettingPayload, error) {
	ctx, span := tracer.Start(ctx, "notification.PutSetting")
	defer span.End()
	span.SetAttributes(attribute.String("scope", scope), attribute.Bool("muted", in.Muted))
	if scope != ScopeGuild && scope != ScopeChannel {
		return SettingPayload{}, errInvalidScope
	}
	if target <= 0 {
		return SettingPayload{}, errInvalidSetting
	}
	if in.Level != nil && *in.Level != LevelAll && *in.Level != LevelMentions && *in.Level != LevelNone {
		return SettingPayload{}, errInvalidLevel
	}
	now := time.Now()
	if in.MutedUntil != nil && (!in.Muted || !in.MutedUntil.After(now)) {
		return SettingPayload{}, errInvalidMute
	}
	if err := s.authorizeTarget(ctx, userID, scope, target); err != nil {
		return SettingPayload{}, err
	}
	set := Setting{Scope: scope, TargetID: target, Muted: in.Muted, MutedUntil: in.MutedUntil, Level: in.Level}
	if !in.Muted && in.Level == nil {
		return s.resetSetting(ctx, userID, scope, target)
	}
	if err := s.Store.UpsertSetting(ctx, userID, set); err != nil {
		return SettingPayload{}, err
	}
	p := set.payload(now)
	s.publishSetting(userID, p)
	return p, nil
}

// DeleteSetting volta o alvo ao padrão (idempotente). Não exige acesso ao alvo: sair do servidor não
// pode impedir de limpar a configuração.
func (s *Service) DeleteSetting(ctx context.Context, userID int64, scope string, target int64) error {
	ctx, span := tracer.Start(ctx, "notification.DeleteSetting")
	defer span.End()
	if scope != ScopeGuild && scope != ScopeChannel {
		return errInvalidScope
	}
	if target <= 0 {
		return errInvalidSetting
	}
	_, err := s.resetSetting(ctx, userID, scope, target)
	return err
}

func (s *Service) resetSetting(ctx context.Context, userID int64, scope string, target int64) (SettingPayload, error) {
	if err := s.Store.DeleteSetting(ctx, userID, scope, target); err != nil {
		return SettingPayload{}, err
	}
	p := SettingPayload{Scope: scope, TargetID: strconv.FormatInt(target, 10)}
	s.publishSetting(userID, p)
	return p, nil
}

func (s *Service) publishSetting(userID int64, p SettingPayload) {
	s.Pub.Publish(events.Event{Type: events.NotificationSettingsUpdate, Topics: []string{userTopic(userID)}, Data: p})
}

// notifiable filtra os destinatários do push pelo que a pessoa configurou: DND (não perturbar) e silêncio
// bloqueiam tudo; o nível decide entre tudo, só menções e nada. mentioned diz quem foi citado na mensagem.
func (s *Service) notifiable(ctx context.Context, recipients []int64, channelID int64, guildID *int64, mentioned map[int64]bool) ([]int64, error) {
	filters, err := s.Store.NotifyFilters(ctx, recipients, channelID, guildID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	out := make([]int64, 0, len(filters))
	for _, f := range filters {
		if f.DND {
			continue
		}
		muted, level := Resolve(now, f.Channel, f.Guild, guildID != nil)
		if Allows(muted, level, mentioned[f.UserID]) {
			out = append(out, f.UserID)
		}
	}
	return out, nil
}
