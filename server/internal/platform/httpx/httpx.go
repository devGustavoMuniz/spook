// Package httpx traduz os erros de negócio (apperr) para respostas HTTP do huma.
package httpx

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// Err converte err em um erro huma; erros desconhecidos seguem como estão (500).
func Err(err error) error {
	e, ok := apperr.As(err)
	if !ok {
		return err
	}
	switch e.Kind {
	case apperr.KindNotFound:
		return huma.Error404NotFound(e.Msg)
	case apperr.KindForbidden:
		return huma.Error403Forbidden(e.Msg)
	case apperr.KindInvalid:
		return huma.Error422UnprocessableEntity(e.Msg)
	case apperr.KindConflict:
		return huma.Error409Conflict(e.Msg)
	case apperr.KindGone:
		return huma.NewError(http.StatusGone, e.Msg)
	case apperr.KindRateLimited:
		secs := int((e.RetryAfter + 999_999_999) / 1_000_000_000) // arredonda para cima
		if secs < 1 {
			secs = 1
		}
		return huma.ErrorWithHeaders(huma.NewError(http.StatusTooManyRequests, e.Msg),
			http.Header{"Retry-After": []string{strconv.Itoa(secs)}})
	}
	return err
}

// ParseID converte um ID Snowflake vindo da URL ou do corpo (string); 0 e negativos são inválidos.
func ParseID(s string) (int64, bool) {
	id, err := strconv.ParseInt(s, 10, 64)
	return id, err == nil && id > 0
}

// ID formata um ID Snowflake para o JSON.
func ID(id int64) string { return strconv.FormatInt(id, 10) }

// IDPtr formata um ID opcional.
func IDPtr(id *int64) *string {
	if id == nil {
		return nil
	}
	s := ID(*id)
	return &s
}

// IDs formata uma lista de IDs.
func IDs(ids []int64) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = ID(id)
	}
	return out
}

// BadID é a resposta para um ID malformado na URL: tratado como inexistente.
func BadID(what string) error { return huma.Error404NotFound(what + " não encontrado") }

// Runes conta caracteres (runes), não bytes.
func Runes(s string) int { return utf8.RuneCountInString(s) }

// Name aplica TrimSpace e valida o tamanho em runes.
func Name(s string, min, max int) (string, bool) {
	s = strings.TrimSpace(s)
	n := Runes(s)
	return s, n >= min && n <= max
}
