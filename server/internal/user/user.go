// Package user cuida das contas de usuário: dados, perfil (bio, pronomes, avatar e banner) e e-mail.
package user

import (
	"errors"
	"time"
)

type User struct {
	ID          int64
	Email       string
	Username    string
	DisplayName *string
	AvatarKey   *string
	Bio         *string
	Pronouns    *string
	BannerKey   *string
	BannerColor *int32
	CreatedAt   time.Time
	IsAdmin     bool
	// EmailVerifiedAt é nulo enquanto o e-mail não foi verificado (contas antigas entram assim).
	EmailVerifiedAt *time.Time
	// PendingEmail é o endereço novo aguardando confirmação (troca de e-mail com verificação).
	PendingEmail *string
	// HasPassword é falso nas contas criadas por login social que ainda não definiram senha.
	HasPassword bool
	// DeletedAt é preenchido quando a conta foi excluída (a linha vira o marcador "Usuário removido").
	DeletedAt *time.Time
}

var (
	ErrNotFound         = errors.New("usuário não encontrado")
	ErrEmailTaken       = errors.New("e-mail já cadastrado")
	ErrUsernameTaken    = errors.New("nome de usuário já em uso")
	ErrInvalidAvatar    = errors.New("avatar inválido")
	ErrInvalidBanner    = errors.New("banner inválido")
	ErrInvalidProfile   = errors.New("perfil inválido")
	ErrInvalidEmail     = errors.New("e-mail inválido")
	ErrReservedUsername = errors.New("nome de usuário reservado")
	// ErrNitroRequired: GIF e imagens animadas (WebP/APNG) em avatar e banner são do Nitro; a API responde 403 com
	// `code: nitro_required`.
	ErrNitroRequired = errors.New("imagem animada requer Nitro")
	// ErrEmailVerificationPending: um EmailChangeVerifier assumiu a troca (confirmação no endereço novo).
	ErrEmailVerificationPending = errors.New("troca de e-mail aguardando verificação")
)
