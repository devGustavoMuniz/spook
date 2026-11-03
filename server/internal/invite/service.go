package invite

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/limits"
)

var tracer = otel.Tracer("spook/invite")

const (
	CodeLength   = 8
	codeAlphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789" // sem caracteres ambíguos (0/O, 1/l/I)
	MaxMaxUses   = 1_000_000
	MaxExpiresIn = 30 * 24 * time.Hour
	codeAttempts = 5
)

// ErrCodeTaken é devolvido pelo store quando o código sorteado já existe.
var ErrCodeTaken = errors.New("código de convite já existe")

// Store é o que o service precisa do banco.
type Store interface {
	Create(ctx context.Context, i Invite) (Invite, error) // ErrCodeTaken
	Get(ctx context.Context, code string) (Invite, error) // ErrNotFound
	List(ctx context.Context, guildID int64) ([]Invite, error)
	// Count devolve os convites ainda válidos do servidor (limite por servidor).
	Count(ctx context.Context, guildID int64) (int, error)
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
	audit  Auditor
	joined Joiner
	lim    limits.Limits
}

// Joiner é avisado depois que alguém entra no servidor por um convite (a mensagem de sistema "fulano entrou").
// Falha dele nunca desfaz a entrada.
type Joiner interface {
	MemberJoined(ctx context.Context, guildID, userID int64) error
}

// SetJoiner liga o aviso de entrada; SetLimits, os limites de domínio configuráveis (LIMIT_*).
func (s *Service) SetJoiner(j Joiner)        { s.joined = j }
func (s *Service) SetLimits(l limits.Limits) { s.lim = l.Normalize() }

// Auditor grava o registro de auditoria (audit.Service; pode ser nil).
type Auditor interface {
	Record(ctx context.Context, e audit.Entry)
}

// SetAudit liga o registro de auditoria.
func (s *Service) SetAudit(a Auditor) { s.audit = a }

func (s *Service) record(ctx context.Context, e audit.Entry) {
	if s.audit != nil {
		s.audit.Record(ctx, e)
	}
}

func NewService(store Store, access Access, guilds Guilds, icons Icons) *Service {
	return &Service{store: store, access: access, guilds: guilds, icons: icons, now: time.Now, lim: limits.Default()}
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
	if in.MaxUses != nil && (*in.MaxUses < 1 || *in.MaxUses > MaxMaxUses) {
		return Invite{}, apperr.Invalid("max_uses deve ser de 1 a 1000000")
	}
	if n, err := s.store.Count(ctx, guildID); err != nil {
		return Invite{}, err
	} else if n >= s.lim.InvitesPerGuild {
		return Invite{}, apperr.Conflict(limits.InvitesPerGuildMsg(s.lim.InvitesPerGuild))
	}
	inv := Invite{GuildID: guildID, CreatorID: userID, MaxUses: in.MaxUses}
	if in.ExpiresIn != nil {
		if *in.ExpiresIn < time.Second || *in.ExpiresIn > MaxExpiresIn {
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
		if err == nil {
			ch := map[string]any{"target_name": created.Code}
			if created.MaxUses != nil {
				ch["max_uses"] = *created.MaxUses
			}
			if created.ExpiresAt != nil {
				ch["expires_at"] = created.ExpiresAt
			}
			s.record(ctx, audit.Entry{GuildID: guildID, ActorID: userID, Action: audit.InviteCreate, TargetType: audit.TargetInvite, Changes: ch})
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
	d, err := s.guilds.PublishJoined(ctx, res.GuildID, userID)
	if err != nil {
		return guild.Detail{}, err
	}
	if s.joined != nil {
		if err := s.joined.MemberJoined(ctx, res.GuildID, userID); err != nil {
			slog.Warn("mensagem de entrada não enviada", "guild", res.GuildID, "user", userID, "err", err)
		}
	}
	return d, nil
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
	if err := s.store.Delete(ctx, code); err != nil {
		return err
	}
	s.record(ctx, audit.Entry{
		GuildID: inv.GuildID, ActorID: userID, Action: audit.InviteRevoke, TargetType: audit.TargetInvite,
		Changes: map[string]any{"target_name": code, "creator_id": httpx.ID(inv.CreatorID)},
	})
	return nil
}
