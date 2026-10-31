package httpx

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

func TestErrMapsKindsToStatus(t *testing.T) {
	tests := []struct {
		err  error
		want int
	}{
		{apperr.NotFound("x"), 404},
		{apperr.Forbidden("x"), 403},
		{apperr.Invalid("x"), 422},
		{apperr.Conflict("x"), 409},
		{apperr.Gone("x"), 410},
		{apperr.Unavailable("x"), 503},
		{apperr.RateLimited("x", time.Second), 429},
		{fmt.Errorf("embrulhado: %w", apperr.NotFound("x")), 404},
	}
	for _, tt := range tests {
		var se huma.StatusError
		if !errors.As(Err(tt.err), &se) || se.GetStatus() != tt.want {
			t.Errorf("%v -> %v, quer %d", tt.err, Err(tt.err), tt.want)
		}
	}
	plain := errors.New("falha interna")
	if !errors.Is(Err(plain), plain) {
		t.Fatal("erro desconhecido deve seguir como está (500)")
	}
	if Err(nil) != nil {
		t.Fatal("nil deve continuar nil")
	}
}

func TestRateLimitedCarriesRetryAfterRoundedUp(t *testing.T) {
	var he huma.HeadersError
	if !errors.As(Err(apperr.RateLimited("devagar", 1200*time.Millisecond)), &he) {
		t.Fatal("429 deve carregar headers")
	}
	if got := he.GetHeaders().Get("Retry-After"); got != "2" {
		t.Fatalf("Retry-After = %q, quer 2", got)
	}
}

func TestParseIDAndName(t *testing.T) {
	for in, ok := range map[string]bool{"123": true, "0": false, "-5": false, "abc": false, "": false} {
		if _, got := ParseID(in); got != ok {
			t.Errorf("ParseID(%q) = %v", in, got)
		}
	}
	if n, ok := Name("  olá  ", 2, 5); !ok || n != "olá" {
		t.Fatalf("Name: %q %v", n, ok)
	}
	if _, ok := Name("ééééé é", 1, 5); ok {
		t.Fatal("deveria contar runes: 7 > 5")
	}
	if _, ok := Name("ééééé", 1, 5); !ok {
		t.Fatal("5 runes cabem em 5")
	}
}
