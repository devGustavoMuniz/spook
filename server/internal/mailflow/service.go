package mailflow

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/mailer"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/platform/secret"
	"github.com/devGustavoMuniz/spook/server/internal/user"
)

var tracer = otel.Tracer("spook/mailflow")

// Store é o que o service precisa do banco.
type Store interface {
	CreateToken(ctx context.Context, id, userID int64, kind, email string, hash []byte, exp time.Time) error
	Consume(ctx context.Context, hash []byte) (Token, error)
	SetPendingEmail(ctx context.Context, userID int64, email *string) error
	MarkVerified(ctx context.Context, userID int64) error
	ApplyEmailChange(ctx context.Context, userID int64, email string) error
	EmailExists(ctx context.Context, email string) (bool, error)
	TokenState
}

// Users é o que o service precisa do pacote user.
type Users interface {
	Get(ctx context.Context, id int64) (user.User, error)
	ByEmail(ctx context.Context, email string) (user.User, error)
}

// Passwords é o que o service precisa do pacote auth.
type Passwords interface {
	ValidateNewPassword(pw string) error
	ResetPassword(ctx context.Context, userID int64, next string) error
}

type IDGenerator interface{ Next() int64 }

type Deps struct {
	Store     Store
	Users     Users
	Passwords Passwords
	Queue     Queue // nil = envia direto, sem fila
	Deliver   *Deliverer
	Box       *secret.Box
	IDs       IDGenerator
	// Enabled liga os fluxos. Desligado (modo degradado), nada é enviado e a troca de e-mail é direta.
	Enabled bool
	// Recipient limita os e-mails por destinatário (nil = sem limite).
	Recipient *ratelimit.Limiter
	// ForgotMinDuration é o piso do tempo de resposta do "esqueci a senha" (atraso quase constante, para não
	// revelar se a conta existe). Zero = sem piso (testes).
	ForgotMinDuration time.Duration
	Now               func() time.Time
}

type Service struct{ d Deps }

func NewService(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	return &Service{d: d}
}

// Enabled diz se os fluxos por e-mail estão ligados.
func (s *Service) Enabled() bool { return s.d.Enabled }

// issue cria o token e agenda o e-mail. O token em claro sai só por aqui (cifrado no job).
func (s *Service) issue(ctx context.Context, tpl mailer.Template, kind string, ttl time.Duration, u user.User, email, other string) error {
	if s.d.Recipient != nil {
		if ok, retry := s.d.Recipient.Take("mail:" + strings.ToLower(email)); !ok {
			return apperr.RateLimited("muitos e-mails para este endereço; aguarde um pouco", retry)
		}
	}
	raw, hash, err := NewToken()
	if err != nil {
		return err
	}
	id := s.d.IDs.Next()
	if err := s.d.Store.CreateToken(ctx, id, u.ID, kind, email, hash, s.d.Now().Add(ttl)); err != nil {
		return err
	}
	sealed, err := s.d.Box.Seal(raw)
	if err != nil {
		return fmt.Errorf("cifrar token: %w", err)
	}
	return s.send(ctx, SendArgs{Template: string(tpl), To: email, Username: u.Username, Other: other, TokenID: id, SealedToken: sealed})
}

// notify manda um aviso sem token (ex.: ao endereço antigo). Falhas só viram log: não bloqueiam o fluxo.
func (s *Service) notify(ctx context.Context, tpl mailer.Template, to, other string) {
	if err := s.send(ctx, SendArgs{Template: string(tpl), To: to, Other: other}); err != nil {
		slog.Warn("aviso por e-mail não enviado", "to", mailer.Mask(to), "err", err)
	}
}

func (s *Service) send(ctx context.Context, a SendArgs) error {
	if s.d.Queue != nil {
		return s.d.Queue.Enqueue(ctx, a)
	}
	return s.d.Deliver.Deliver(ctx, a)
}

// OnRegistered envia a verificação logo depois do cadastro (best-effort; sem e-mail ligado não faz nada).
func (s *Service) OnRegistered(ctx context.Context, u user.User) {
	if !s.d.Enabled || u.EmailVerifiedAt != nil {
		return
	}
	if err := s.issue(ctx, mailer.TemplateVerify, KindVerify, VerifyTTL, u, u.Email, ""); err != nil {
		slog.Warn("e-mail de verificação não enviado", "user", u.ID, "err", err)
	}
}

// Resend reenvia a verificação do e-mail atual de userID.
func (s *Service) Resend(ctx context.Context, userID int64) error {
	ctx, span := tracer.Start(ctx, "mailflow.Resend")
	defer span.End()
	if !s.d.Enabled {
		return ErrDisabled
	}
	u, err := s.d.Users.Get(ctx, userID)
	if err != nil {
		return err
	}
	if u.EmailVerifiedAt != nil {
		return ErrAlreadyVerified
	}
	return s.issue(ctx, mailer.TemplateVerify, KindVerify, VerifyTTL, u, u.Email, "")
}

// VerifyResult diz o que o token fez.
type VerifyResult struct {
	Changed bool   // true: era uma troca de e-mail
	Email   string // endereço confirmado
}

// Verify consome um token de verificação ou de troca de e-mail.
func (s *Service) Verify(ctx context.Context, rawToken string) (VerifyResult, error) {
	ctx, span := tracer.Start(ctx, "mailflow.Verify")
	defer span.End()
	t, err := s.d.Store.Consume(ctx, HashToken(rawToken))
	if err != nil {
		return VerifyResult{}, err
	}
	span.SetAttributes(attribute.String("token.kind", t.Kind), attribute.Int64("user.id", t.UserID))
	u, err := s.d.Users.Get(ctx, t.UserID)
	if err != nil {
		if errors.Is(err, user.ErrNotFound) {
			return VerifyResult{}, ErrTokenInvalid
		}
		return VerifyResult{}, err
	}
	if u.DeletedAt != nil {
		return VerifyResult{}, ErrTokenInvalid
	}
	switch t.Kind {
	case KindVerify:
		if !strings.EqualFold(u.Email, t.Email) {
			return VerifyResult{}, ErrTokenInvalid // o endereço mudou depois do pedido
		}
		if err := s.d.Store.MarkVerified(ctx, u.ID); err != nil {
			return VerifyResult{}, err
		}
		return VerifyResult{Email: u.Email}, nil
	case KindEmailChange:
		if u.PendingEmail == nil || !strings.EqualFold(*u.PendingEmail, t.Email) {
			return VerifyResult{}, ErrTokenInvalid // pedido substituído ou cancelado
		}
		old := u.Email
		if err := s.d.Store.ApplyEmailChange(ctx, u.ID, t.Email); err != nil {
			return VerifyResult{}, err
		}
		s.notify(ctx, mailer.TemplateEmailChanged, old, t.Email)
		return VerifyResult{Changed: true, Email: t.Email}, nil
	default:
		return VerifyResult{}, ErrTokenInvalid
	}
}

// Begin implementa user.EmailChangeVerifier: com e-mail ligado, grava o pedido (pending_email + token), manda
// o link ao endereço NOVO e avisa o antigo; a conta só muda em Verify. Desligado: apply=true (troca direta).
func (s *Service) Begin(ctx context.Context, userID int64, newEmail string) (bool, error) {
	ctx, span := tracer.Start(ctx, "mailflow.BeginEmailChange")
	defer span.End()
	if !s.d.Enabled {
		return true, nil
	}
	taken, err := s.d.Store.EmailExists(ctx, newEmail)
	if err != nil {
		return false, err
	}
	if taken {
		return false, user.ErrEmailTaken
	}
	u, err := s.d.Users.Get(ctx, userID)
	if err != nil {
		return false, err
	}
	if err := s.issue(ctx, mailer.TemplateEmailChange, KindEmailChange, EmailChangeTTL, u, newEmail, u.Email); err != nil {
		return false, err
	}
	if err := s.d.Store.SetPendingEmail(ctx, userID, &newEmail); err != nil {
		return false, err
	}
	s.notify(ctx, mailer.TemplateEmailChangeNotice, u.Email, newEmail)
	return false, nil
}

// Forgot inicia a recuperação de senha. Nunca revela se o e-mail tem conta: o resultado é sempre o mesmo e a
// duração tem um piso. Só erros de infraestrutura chegam ao chamador (que também os esconde do cliente).
func (s *Service) Forgot(ctx context.Context, email string) {
	start := s.d.Now()
	ctx, span := tracer.Start(ctx, "mailflow.Forgot")
	defer span.End()
	defer func() {
		if rest := s.d.ForgotMinDuration - s.d.Now().Sub(start); rest > 0 {
			select {
			case <-time.After(rest):
			case <-ctx.Done():
			}
		}
	}()
	if !s.d.Enabled {
		slog.Warn("recuperação de senha por e-mail pedida, mas o e-mail está desligado; use `spook admin reset-password <username>`")
		return
	}
	u, err := s.d.Users.ByEmail(ctx, strings.TrimSpace(email))
	if err != nil {
		if !errors.Is(err, user.ErrNotFound) {
			slog.Error("recuperar senha: buscar conta", "err", err)
		}
		return
	}
	if err := s.issue(ctx, mailer.TemplatePasswordReset, KindPasswordReset, ResetTTL, u, u.Email, ""); err != nil {
		if !apperr.IsKind(err, apperr.KindRateLimited) {
			slog.Error("recuperar senha: enviar e-mail", "err", err)
		}
	}
}

// Reset consome o token de recuperação e define a senha nova (encerrando todas as sessões). A senha é validada
// ANTES de gastar o token: uma senha fraca não queima o link.
func (s *Service) Reset(ctx context.Context, rawToken, newPassword string) error {
	ctx, span := tracer.Start(ctx, "mailflow.Reset")
	defer span.End()
	if err := s.d.Passwords.ValidateNewPassword(newPassword); err != nil {
		return err
	}
	t, err := s.d.Store.Consume(ctx, HashToken(rawToken))
	if err != nil {
		return err
	}
	if t.Kind != KindPasswordReset {
		return ErrTokenInvalid
	}
	u, err := s.d.Users.Get(ctx, t.UserID)
	if err != nil || u.DeletedAt != nil || !strings.EqualFold(u.Email, t.Email) {
		if err != nil && !errors.Is(err, user.ErrNotFound) {
			return err
		}
		return ErrTokenInvalid
	}
	if err := s.d.Passwords.ResetPassword(ctx, t.UserID, newPassword); err != nil {
		return err
	}
	// Quem recebeu o link no e-mail provou controlar o endereço.
	if err := s.d.Store.MarkVerified(ctx, t.UserID); err != nil {
		slog.Warn("marcar e-mail verificado após redefinição", "err", err)
	}
	slog.Info("senha redefinida por e-mail", "user", t.UserID)
	return nil
}
