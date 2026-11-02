// Package httpx traduz os erros de negócio (apperr) para respostas HTTP do huma.
package httpx

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
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
	case apperr.KindUnavailable:
		return huma.NewError(http.StatusServiceUnavailable, e.Msg)
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

// Take consome uma vaga do limitador para key (ex.: "senha:<usuário>"); sem limitador não limita.
// Estourou: 429 com Retry-After.
func Take(l *ratelimit.Limiter, key string) error {
	if l == nil {
		return nil
	}
	ok, retry := l.Take(key)
	if ok {
		return nil
	}
	return Err(apperr.RateLimited("muitas tentativas; aguarde um pouco e tente de novo", retry))
}

// ProblemError é um erro huma com campos extras além do padrão (ex.: `code` e `guilds`), para o cliente
// tomar decisões sem interpretar o texto.
type ProblemError struct {
	Status int
	Detail string
	Code   string
	Extra  map[string]any
}

func (e *ProblemError) Error() string  { return e.Detail }
func (e *ProblemError) GetStatus() int { return e.Status }

func (e *ProblemError) MarshalJSON() ([]byte, error) {
	m := map[string]any{"title": http.StatusText(e.Status), "status": e.Status, "detail": e.Detail}
	if e.Code != "" {
		m["code"] = e.Code
	}
	for k, v := range e.Extra {
		m[k] = v
	}
	return json.Marshal(m)
}
