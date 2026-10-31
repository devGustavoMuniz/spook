package invite

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"

	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

var tracer = otel.Tracer("spook/invite")

const (
	CodeLength   = 8
	codeAlphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789" // sem caracteres ambíguos (0/O, 1/l/I)
	maxMaxUses   = 1_000_000
	maxExpiresIn = 30 * 24 * time.Hour
	codeAttempts = 5
)

// ErrCodeTaken é devolvido pelo store quando o código sorteado já existe.
var ErrCodeTaken = errors.New("código de convite já existe")

// Store é o que o service precisa do banco.
type Store interface {
	Create(ctx context.Context, i Invite) (Invite, error) // ErrCodeTaken
	Get(ctx context.Context, code string) (Invite, error) // ErrNotFound
	List(ctx context.Context, guildID int64) ([]Invite, error)
	Delete(ctx context.Context, code string) error
	Preview(ctx context.Context, code string) (Preview, error) // ErrNotFound
	// Redeem entra no servidor numa transação: quem já é membro não consome uso; senão
	// valida o limite de servidores (guild.ErrTooManyGuilds) e consome um uso de forma atômica
	// (ErrGone se expirado ou esgotado).
	Redeem(ctx context.Context, code string, userID int64) (RedeemResult, error)
}

// Access é o que invite precisa do servidor para checar permissões.
type Access interface {
	Member(ctx context.Context, guildID, userID int64) (perm.Member, error)
}

// Guilds é o que invite precisa do servidor depois da entrada.
type Guilds interface {
	PublishJoined(ctx context.Context, guildID, userID int64) (guild.Detail, error)
	Get(ctx context.Context, userID, guildID int64) (guild.Detail, error)
}

// Icons resolve a chave do ícone do servidor em URL de leitura.
type Icons interface {
	IconURL(ctx context.Context, key *string) string
}

type Service struct {
	store  Store
	access Access
	guilds Guilds
	icons  Icons
	now    func() time.Time
}

func NewService(store Store, access Access, guilds Guilds, icons Icons) *Service {
	return &Service{store: store, access: access, guilds: guilds, icons: icons, now: time.Now}
}

func newCode() (string, error) {
	b := make([]byte, CodeLength)
	for i := range b {
		for { // amostragem por rejeição: sem viés de módulo
			var r [1]byte
			if _, err := rand.Read(r[:]); err != nil {
				return "", fmt.Errorf("sortear código: %w", err)
			}
			if int(r[0]) < 256-256%len(codeAlphabet) {
				b[i] = codeAlphabet[int(r[0])%len(codeAlphabet)]
				break
			}
		}
	}
	return string(b), nil
}

func (s *Service) member(ctx context.Context, guildID, userID int64) (perm.Member, error) {
	m, err := s.access.Member(ctx, guildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return perm.Member{}, guild.ErrNotFound
	}
	return m, err
}

type CreateParams struct {
	MaxUses   *int32
	ExpiresIn *time.Duration
}

func (s *Service) Create(ctx context.Context, userID, guildID int64, in CreateParams) (Invite, error) {
	ctx, span := tracer.Start(ctx, "invite.Create")
	defer span.End()
	m, err := s.member(ctx, guildID, userID)
	if err != nil {
		return Invite{}, err
	}
	if !m.Has(perm.CreateInvite) {
		return Invite{}, ErrForbidden
	}
	if in.MaxUses != nil && (*in.MaxUses < 1 || *in.MaxUses > maxMaxUses) {
		return Invite{}, apperr.Invalid("max_uses deve ser de 1 a 1000000")
	}
	inv := Invite{GuildID: guildID, CreatorID: userID, MaxUses: in.MaxUses}
	if in.ExpiresIn != nil {
		if *in.ExpiresIn < time.Second || *in.ExpiresIn > maxExpiresIn {
			return Invite{}, apperr.Invalid("expires_in deve ser de 1 segundo a 30 dias")
		}
		t := s.now().Add(*in.ExpiresIn)
		inv.ExpiresAt = &t
	}
	for range codeAttempts {
		if inv.Code, err = newCode(); err != nil {
			return Invite{}, err
		}
		created, err := s.store.Create(ctx, inv)
		if errors.Is(err, ErrCodeTaken) {
			continue
		}
		return created, err
	}
	return Invite{}, errors.New("não foi possível gerar um código único")
}

// List lista os convites do servidor; exige MANAGE_GUILD.
func (s *Service) List(ctx context.Context, userID, guildID int64) ([]Invite, error) {
	m, err := s.member(ctx, guildID, userID)
	if err != nil {
		return nil, err
	}
	if !m.Has(perm.ManageGuild) {
		return nil, ErrForbidden
	}
	return s.store.List(ctx, guildID)
}

// Peek mostra o servidor do convite antes de entrar; convite expirado ou esgotado dá ErrGone.
func (s *Service) Peek(ctx context.Context, code string) (Preview, string, error) {
	ctx, span := tracer.Start(ctx, "invite.Peek")
	defer span.End()
	p, err := s.store.Preview(ctx, code)
	if err != nil {
		return Preview{}, "", err
	}
	if !p.Valid(s.now()) {
		return Preview{}, "", ErrGone
	}
	return p, s.icons.IconURL(ctx, p.GuildIconKey), nil
}

// Join entra no servidor pelo convite e devolve o servidor completo.
func (s *Service) Join(ctx context.Context, userID int64, code string) (guild.Detail, error) {
	ctx, span := tracer.Start(ctx, "invite.Join")
	defer span.End()
	res, err := s.store.Redeem(ctx, code, userID)
	if err != nil {
		return guild.Detail{}, err
	}
	if !res.Joined {
		return s.guilds.Get(ctx, userID, res.GuildID)
	}
	return s.guilds.PublishJoined(ctx, res.GuildID, userID)
}

// Revoke apaga o convite; o criador ou quem tem MANAGE_GUILD.
func (s *Service) Revoke(ctx context.Context, userID int64, code string) error {
	ctx, span := tracer.Start(ctx, "invite.Revoke")
	defer span.End()
	inv, err := s.store.Get(ctx, code)
	if err != nil {
		return err
	}
	m, err := s.member(ctx, inv.GuildID, userID)
	if err != nil {
		return ErrNotFound
	}
	if inv.CreatorID != userID && !m.Has(perm.ManageGuild) {
		return ErrForbidden
	}
	return s.store.Delete(ctx, code)
}
