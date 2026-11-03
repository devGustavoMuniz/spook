// Package mailflow cuida dos fluxos que dependem de e-mail: verificação do endereço, troca de e-mail com
// confirmação no endereço novo e recuperação de senha. Tokens são de uso único, com prazo, e só o hash
// SHA-256 fica no banco; o token em claro existe no link do e-mail e no corpo do POST que o consome.
package mailflow

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
)

// Tipos de token (coluna email_tokens.kind).
const (
	KindVerify        = "verify"
	KindEmailChange   = "email_change"
	KindPasswordReset = "password_reset"
)

// Prazos de validade.
const (
	VerifyTTL      = 24 * time.Hour
	EmailChangeTTL = 24 * time.Hour
	ResetTTL       = 30 * time.Minute
)

var (
	// ErrTokenInvalid: o token não existe (ou não corresponde mais à conta).
	ErrTokenInvalid = errors.New("link inválido")
	// ErrTokenExpired: o token existe, mas expirou ou já foi usado.
	ErrTokenExpired = errors.New("link expirado ou já usado")
	// ErrDisabled: os fluxos por e-mail estão desligados neste servidor (modo degradado).
	ErrDisabled = errors.New("e-mail indisponível neste servidor")
	// ErrAlreadyVerified: o e-mail da conta já foi confirmado.
	ErrAlreadyVerified = errors.New("e-mail já verificado")
	// ErrEmailTaken: outro usuário já usa o endereço.
	ErrEmailTaken = errors.New("e-mail já cadastrado")
)

// Token é um token consumido com sucesso.
type Token struct {
	ID     int64
	UserID int64
	Kind   string
	Email  string
}

// NewToken gera um token aleatório de 256 bits (base64url) e o hash que vai ao banco.
func NewToken() (raw string, hash []byte, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, fmt.Errorf("gerar token: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(b)
	return raw, HashToken(raw), nil
}

// HashToken devolve o SHA-256 do token (o que se grava e se procura).
func HashToken(raw string) []byte {
	sum := sha256.Sum256([]byte(raw))
	return sum[:]
}

var nowFunc = time.Now
