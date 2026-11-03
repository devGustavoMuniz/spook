// Package secret reúne o que depende da chave do servidor (SPOOK_SECRET_KEY): assinar valores curtos (estado
// OAuth) e cifrar tokens que passam por jobs, para o token em claro nunca ficar gravado no banco.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// Box guarda duas chaves derivadas da chave mestra (uma para assinar, outra para cifrar).
type Box struct {
	sign []byte
	aead cipher.AEAD
}

// New deriva as chaves de master. Vazio gera uma chave aleatória (válida só neste processo); o segundo
// retorno diz se a chave é efêmera.
func New(master string) (*Box, bool, error) {
	ephemeral := master == ""
	if ephemeral {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return nil, false, fmt.Errorf("gerar chave: %w", err)
		}
		master = base64.RawStdEncoding.EncodeToString(raw)
	}
	derive := func(label string) []byte {
		m := hmac.New(sha256.New, []byte(master))
		m.Write([]byte("spook/" + label))
		return m.Sum(nil)
	}
	block, err := aes.NewCipher(derive("seal"))
	if err != nil {
		return nil, false, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, false, err
	}
	return &Box{sign: derive("sign"), aead: aead}, ephemeral, nil
}

// Sign devolve "payload.assinatura" (payload em base64url). A comparação na leitura é em tempo constante.
func (b *Box) Sign(payload []byte) string {
	p := base64.RawURLEncoding.EncodeToString(payload)
	return p + "." + b.mac(p)
}

var ErrInvalid = errors.New("valor assinado inválido")

// Verify confere a assinatura e devolve o payload.
func (b *Box) Verify(signed string) ([]byte, error) {
	i := strings.LastIndexByte(signed, '.')
	if i < 0 {
		return nil, ErrInvalid
	}
	p, sig := signed[:i], signed[i+1:]
	if !hmac.Equal([]byte(sig), []byte(b.mac(p))) {
		return nil, ErrInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return nil, ErrInvalid
	}
	return raw, nil
}

func (b *Box) mac(p string) string {
	m := hmac.New(sha256.New, b.sign)
	m.Write([]byte(p))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// Seal cifra (AES-GCM) um texto curto; Open o desfaz.
func (b *Box) Seal(plain string) (string, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b.aead.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (b *Box) Open(sealed string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil || len(raw) < b.aead.NonceSize() {
		return "", ErrInvalid
	}
	n := b.aead.NonceSize()
	out, err := b.aead.Open(nil, raw[:n], raw[n:], nil)
	if err != nil {
		return "", ErrInvalid
	}
	return string(out), nil
}
