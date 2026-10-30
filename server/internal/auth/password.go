package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Parâmetros Argon2id recomendados pela OWASP (m=19 MiB, t=2, p=1).
const (
	argonTime    = 2
	argonMemory  = 19 * 1024
	argonThreads = 1
	argonKeyLen  = 32
	saltLen      = 16
)

var errBadHash = errors.New("hash de senha em formato inválido")

// Hasher calcula e verifica senhas. O semáforo limita quantos hashes rodam ao mesmo tempo
// (cada um usa ~19 MiB), protegendo a RAM do backend sob rajadas de login.
type Hasher struct{ sem chan struct{} }

func NewHasher(maxConcurrent int) *Hasher { return &Hasher{sem: make(chan struct{}, maxConcurrent)} }

func (h *Hasher) acquire(ctx context.Context) (release func(), err error) {
	select {
	case h.sem <- struct{}{}:
		return func() { <-h.sem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (h *Hasher) Hash(ctx context.Context, password string) (string, error) {
	release, err := h.acquire(ctx)
	if err != nil {
		return "", err
	}
	defer release()

	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("gerar salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// Verify compara a senha com o hash PHC em tempo constante.
func (h *Hasher) Verify(ctx context.Context, password, encoded string) (bool, error) {
	p := strings.Split(encoded, "$")
	if len(p) != 6 || p[1] != "argon2id" {
		return false, errBadHash
	}
	var version int
	var memory, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(p[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errBadHash
	}
	if _, err := fmt.Sscanf(p[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false, errBadHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(p[4])
	if err != nil {
		return false, errBadHash
	}
	want, err := base64.RawStdEncoding.DecodeString(p[5])
	if err != nil {
		return false, errBadHash
	}

	release, err := h.acquire(ctx)
	if err != nil {
		return false, err
	}
	defer release()
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
