package account

import (
	"context"
	"log/slog"
	"strconv"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"

	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

var tracer = otel.Tracer("spook/account")

// Store é o que o service precisa do banco.
type Store interface {
	Delete(ctx context.Context, userID int64, enqueue EnqueueFunc) (Result, error)
}

// Passwords confere a senha (o app adapta o auth.Service).
type Passwords interface {
	CheckPassword(ctx context.Context, userID int64, password string) (bool, error)
}

// Groups atualiza a lista de participantes de DMs em grupo para quem ficou.
type Groups interface {
	PublishUpdated(ctx context.Context, channelID int64)
}

type Deps struct {
	Store     Store
	Passwords Passwords
	Pub       events.Publisher
	Enqueue   EnqueueFunc // nil = sem job de arquivos (storage desligado)
	// Revoke derruba as conexões do gateway do usuário (keepKey vazio = todas).
	Revoke func(userID int64, keepKey string)
	// LeaveVoice tira o usuário da chamada em andamento, se houver.
	LeaveVoice func(ctx context.Context, userID int64) error
	Groups     Groups
}

type Service struct{ d Deps }

func NewService(d Deps) *Service {
	if d.Pub == nil {
		d.Pub = events.Discard{}
	}
	return &Service{d: d}
}

// Delete exclui a conta de userID depois de conferir a senha. Erros de negócio: ErrWrongPassword,
// *OwnsGuildsError.
func (s *Service) Delete(ctx context.Context, userID int64, password string) error {
	ctx, span := tracer.Start(ctx, "account.Delete")
	defer span.End()
	span.SetAttributes(attribute.Int64("user.id", userID))

	ok, err := s.d.Passwords.CheckPassword(ctx, userID, password)
	if err != nil {
		return err
	}
	if !ok {
		return ErrWrongPassword
	}
	res, err := s.d.Store.Delete(ctx, userID, s.d.Enqueue)
	if err != nil {
		return err
	}
	slog.Info("conta excluída", "user", userID, "servidores", len(res.GuildIDs), "arquivos", len(res.FileKeys))

	if s.d.LeaveVoice != nil {
		if err := s.d.LeaveVoice(ctx, userID); err != nil {
			slog.Warn("sair da chamada ao excluir conta", "user", userID, "err", err)
		}
	}
	// Quem ficou nos servidores vê o membro sair; o gateway do próprio usuário é derrubado por inteiro.
	for _, gid := range res.GuildIDs {
		s.d.Pub.Publish(events.Event{
			Type: events.GuildMemberRemove, GuildID: gid, Topics: []string{"guild:" + strconv.FormatInt(gid, 10)},
			Data: memberRemove{GuildID: strconv.FormatInt(gid, 10), UserID: strconv.FormatInt(userID, 10)},
		})
	}
	if s.d.Groups != nil {
		for _, cid := range res.GroupChannels {
			s.d.Groups.PublishUpdated(ctx, cid)
		}
	}
	if s.d.Revoke != nil {
		s.d.Revoke(userID, "")
	}
	return nil
}

type memberRemove struct {
	GuildID string `json:"guild_id"`
	UserID  string `json:"user_id"`
}
