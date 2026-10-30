// Package user cuida das contas de usuário: cadastro de dados, perfil e avatar.
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
	CreatedAt   time.Time
}

var (
	ErrNotFound      = errors.New("usuário não encontrado")
	ErrEmailTaken    = errors.New("e-mail já cadastrado")
	ErrUsernameTaken = errors.New("nome de usuário já em uso")
	ErrInvalidAvatar = errors.New("avatar inválido")
)
