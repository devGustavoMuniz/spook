package auth

import (
	"context"
	"strings"
	"testing"
)

func TestHashAndVerify(t *testing.T) {
	h := NewHasher(2)
	ctx := context.Background()
	enc, err := h.Hash(ctx, "senha-correta")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(enc, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("formato PHC inesperado: %s", enc)
	}
	if ok, err := h.Verify(ctx, "senha-correta", enc); err != nil || !ok {
		t.Fatalf("senha correta deveria validar: ok=%v err=%v", ok, err)
	}
	if ok, _ := h.Verify(ctx, "outra", enc); ok {
		t.Fatal("senha errada não deveria validar")
	}
	enc2, _ := h.Hash(ctx, "senha-correta")
	if enc == enc2 {
		t.Fatal("o salt deveria ser aleatório")
	}
}

func TestVerifyRejectsMalformedHash(t *testing.T) {
	h := NewHasher(1)
	for _, bad := range []string{"", "abc", "$argon2i$v=19$m=1,t=1,p=1$AAAA$AAAA", "$argon2id$v=19$m=x$AAAA$AAAA"} {
		if _, err := h.Verify(context.Background(), "x", bad); err == nil {
			t.Fatalf("esperava erro para %q", bad)
		}
	}
}

func TestHashRespectsContextWhenSaturated(t *testing.T) {
	h := NewHasher(1)
	h.sem <- struct{}{} // ocupa o único slot
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.Hash(ctx, "x"); err == nil {
		t.Fatal("esperava erro de contexto com o semáforo cheio")
	}
}
