package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/user"
)

// DesktopCodeTTL é a validade do código de uso único do handoff do desktop.
const DesktopCodeTTL = 60 * time.Second

var (
	// ErrInvalidCode: código inexistente, expirado, já usado ou verificador que não bate com o desafio.
	ErrInvalidCode      = errors.New("código inválido ou expirado")
	ErrInvalidChallenge = errors.New("code_challenge inválido")
)

// Verificador PKCE (RFC 7636): 43 a 128 caracteres [A-Za-z0-9-._~]. O desafio é base64url(sha256(verificador)),
// sempre 43 caracteres.
var (
	verifierRe  = regexp.MustCompile(`^[A-Za-z0-9\-._~]{43,128}$`)
	challengeRe = regexp.MustCompile(`^[A-Za-z0-9\-_]{43}$`)
)

// PKCEChallenge calcula o code_challenge S256 de um verificador.
func PKCEChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// ValidPKCEChallenge diz se s tem o formato de um desafio S256.
func ValidPKCEChallenge(s string) bool { return challengeRe.MatchString(s) }

// DesktopAuthorize gera o código de uso único (60 s) que o navegador entrega ao app por `spook://auth?code=`.
// Só o hash do código é guardado.
func (s *Service) DesktopAuthorize(ctx context.Context, userID int64, challenge string) (string, time.Time, error) {
	if !ValidPKCEChallenge(challenge) {
		return "", time.Time{}, ErrInvalidChallenge
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, fmt.Errorf("gerar código: %w", err)
	}
	code := base64.RawURLEncoding.EncodeToString(raw)
	exp := s.now().Add(DesktopCodeTTL)
	if err := s.store.InsertDesktopCode(ctx, hashToken(code), userID, challenge, exp); err != nil {
		return "", time.Time{}, err
	}
	return code, exp, nil
}

// DesktopExchange troca o código (+ verificador PKCE) por uma sessão Bearer. O código é consumido antes de
// conferir o verificador: tentativa errada queima o código (não dá para adivinhar o verificador).
func (s *Service) DesktopExchange(ctx context.Context, code, verifier string, userAgent *string) (user.User, string, error) {
	if code == "" || !verifierRe.MatchString(verifier) {
		return user.User{}, "", ErrInvalidCode
	}
	uid, challenge, err := s.store.ConsumeDesktopCode(ctx, hashToken(code))
	if err != nil {
		return user.User{}, "", err
	}
	if subtle.ConstantTimeCompare([]byte(PKCEChallenge(verifier)), []byte(challenge)) != 1 {
		return user.User{}, "", ErrInvalidCode
	}
	u, err := s.users.Get(ctx, uid)
	if err != nil {
		return user.User{}, "", err
	}
	tok, err := s.newSession(ctx, uid, userAgent)
	return u, tok, err
}
