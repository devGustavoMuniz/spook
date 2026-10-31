package auth

import (
	"context"
	"testing"
)

// Custo do hash de senha (Argon2id, m=19 MiB, t=2, p=1). Comparação com o bcrypt do antrax: bench/scripts/hash-cost.php.
// Uso: go test -run '^$' -bench . -benchtime 20x ./internal/auth

func BenchmarkHash(b *testing.B) {
	h := NewHasher(1)
	ctx := context.Background()
	for b.Loop() {
		if _, err := h.Hash(ctx, "senha-de-teste-123"); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkVerify(b *testing.B) {
	h := NewHasher(1)
	ctx := context.Background()
	enc, err := h.Hash(ctx, "senha-de-teste-123")
	if err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for b.Loop() {
		if ok, err := h.Verify(ctx, "senha-de-teste-123", enc); err != nil || !ok {
			b.Fatalf("verify: ok=%v err=%v", ok, err)
		}
	}
}
