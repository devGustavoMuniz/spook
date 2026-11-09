package user

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

// Audience diz quem enxerga o perfil de um usuário: os servidores dele e quem divide DM ou amizade com ele.
// É definida aqui, por quem consome; o store de presença já responde isso (mesma pergunta, mesma consulta).
type Audience interface {
	Audience(ctx context.Context, userID int64) (guildIDs, peers []int64, err error)
}

// UpdatePayload é o dado do evento USER_UPDATE: a parte pública do perfil (nada de e-mail ou flags de conta).
// As URLs de imagem são assinadas na hora; a chave do objeto muda a cada upload, então a URL nunca repete.
type UpdatePayload struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	Bio         string `json:"bio,omitempty"`
	Pronouns    string `json:"pronouns,omitempty"`
	BannerURL   string `json:"banner_url,omitempty"`
	BannerColor *int32 `json:"banner_color,omitempty"`
	// Plan é o plano da pessoa (free, nitro ou nitro_plus), sempre presente: o cliente troca o selo e a animação
	// do avatar/banner por ele. Fonte e validade não vão a terceiros.
	Plan string `json:"plan" enum:"free,nitro,nitro_plus"`
}

// WithEvents liga a publicação de USER_UPDATE (pub e aud nulos desligam).
func (s *Service) WithEvents(pub events.Publisher, aud Audience) *Service {
	s.pub, s.aud = pub, aud
	return s
}

// Payload monta o USER_UPDATE do usuário.
func (s *Service) Payload(ctx context.Context, u User) UpdatePayload {
	p := UpdatePayload{
		ID: strconv.FormatInt(u.ID, 10), Username: u.Username, AvatarURL: s.AvatarURL(ctx, u),
		BannerURL: s.AvatarURLForKey(ctx, u.BannerKey), BannerColor: u.BannerColor, Plan: s.PlanOf(ctx, u.ID),
	}
	if u.DisplayName != nil {
		p.DisplayName = *u.DisplayName
	}
	if u.Bio != nil {
		p.Bio = *u.Bio
	}
	if u.Pronouns != nil {
		p.Pronouns = *u.Pronouns
	}
	return p
}

// publishUpdate avisa quem vê o usuário. Falha ao calcular o público não desfaz a edição: quem não receber
// o evento vê o perfil novo na próxima carga (o log registra).
func (s *Service) publishUpdate(ctx context.Context, u User) {
	if s.pub == nil || s.aud == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	guilds, peers, err := s.aud.Audience(ctx, u.ID)
	if err != nil {
		slog.Warn("user: não foi possível calcular quem vê o perfil", "user", u.ID, "err", err)
		return
	}
	topics := make([]string, 0, 1+len(guilds)+len(peers))
	topics = append(topics, "user:"+strconv.FormatInt(u.ID, 10)) // minhas outras sessões
	for _, g := range guilds {
		topics = append(topics, "guild:"+strconv.FormatInt(g, 10))
	}
	for _, p := range peers {
		topics = append(topics, "user:"+strconv.FormatInt(p, 10))
	}
	s.pub.Publish(events.Event{Type: events.UserUpdate, Topics: topics, Data: s.Payload(ctx, u)})
}
