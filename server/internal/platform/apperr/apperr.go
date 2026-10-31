// Package apperr define os erros de negócio compartilhados pelos services. É puro (sem HTTP):
// a camada handler os traduz para status (ver platform/httpx).
package apperr

import (
	"errors"
	"time"
)

type Kind int

const (
	KindNotFound    Kind = iota + 1 // 404: não existe ou o usuário não pode vê-lo
	KindForbidden                   // 403: existe e é visível, mas falta permissão
	KindInvalid                     // 422: dados inválidos para a regra de negócio
	KindConflict                    // 409: conflita com o estado atual
	KindGone                        // 410: existiu, mas não vale mais (convite expirado)
	KindRateLimited                 // 429
)

type Error struct {
	Kind       Kind
	Msg        string
	RetryAfter time.Duration // só em KindRateLimited
}

func (e *Error) Error() string { return e.Msg }

func NotFound(msg string) *Error  { return &Error{Kind: KindNotFound, Msg: msg} }
func Forbidden(msg string) *Error { return &Error{Kind: KindForbidden, Msg: msg} }
func Invalid(msg string) *Error   { return &Error{Kind: KindInvalid, Msg: msg} }
func Conflict(msg string) *Error  { return &Error{Kind: KindConflict, Msg: msg} }
func Gone(msg string) *Error      { return &Error{Kind: KindGone, Msg: msg} }

func RateLimited(msg string, retryAfter time.Duration) *Error {
	return &Error{Kind: KindRateLimited, Msg: msg, RetryAfter: retryAfter}
}

// As devolve o *Error dentro de err, se houver.
func As(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// IsKind diz se err é um erro de negócio do tipo k.
func IsKind(err error, k Kind) bool {
	e, ok := As(err)
	return ok && e.Kind == k
}
