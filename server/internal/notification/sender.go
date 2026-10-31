package notification

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/SherClockHolmes/webpush-go"
)

const (
	// PushTTL é quanto o serviço de push guarda a notificação se o dispositivo estiver inalcançável.
	PushTTL = time.Hour
	// sendTimeout é o prazo total de um envio (conexão, TLS e resposta).
	sendTimeout = 10 * time.Second
)

// PushConfig reúne as chaves VAPID (RFC 8292). Sem as três o push fica desligado.
type PushConfig struct {
	PublicKey  string
	PrivateKey string
	Subject    string // mailto: ou https: de contato do operador
}

func (c PushConfig) Enabled() bool { return c.PublicKey != "" && c.PrivateKey != "" && c.Subject != "" }

// Sender entrega uma notificação já montada (JSON) a uma inscrição.
type Sender interface {
	// Send devolve o status HTTP do serviço de push. err != nil: falha antes de uma resposta
	// (rede, timeout, destino bloqueado → ErrBlockedAddress).
	Send(ctx context.Context, sub Subscription, payload []byte) (status int, err error)
}

// WebPushSender envia com webpush-go (cifra aes128gcm + VAPID) por um cliente HTTP seguro.
type WebPushSender struct {
	cfg    PushConfig
	client webpush.HTTPClient
}

// NewWebPushSender valida as chaves e monta o cliente. client nulo usa o cliente anti-SSRF da política.
func NewWebPushSender(cfg PushConfig, policy EndpointPolicy, client webpush.HTTPClient) (*WebPushSender, error) {
	if err := validateVAPID(cfg); err != nil {
		return nil, err
	}
	if client == nil {
		client = NewHTTPClient(policy, sendTimeout)
	}
	return &WebPushSender{cfg: cfg, client: client}, nil
}

func validateVAPID(cfg PushConfig) error {
	pub, err := decodeKey(cfg.PublicKey)
	if err != nil || len(pub) != 65 || pub[0] != 4 {
		return errors.New("VAPID_PUBLIC_KEY inválida (esperado: ponto P-256 não comprimido em base64url)")
	}
	if priv, err := decodeKey(cfg.PrivateKey); err != nil || len(priv) != 32 {
		return errors.New("VAPID_PRIVATE_KEY inválida (esperado: 32 bytes em base64url)")
	}
	return nil
}

func (s *WebPushSender) Send(ctx context.Context, sub Subscription, payload []byte) (int, error) {
	resp, err := webpush.SendNotificationWithContext(ctx, payload,
		&webpush.Subscription{Endpoint: sub.Endpoint, Keys: webpush.Keys{Auth: sub.Auth, P256dh: sub.P256dh}},
		&webpush.Options{
			HTTPClient: s.client, Subscriber: s.cfg.Subject, VAPIDPublicKey: s.cfg.PublicKey, VAPIDPrivateKey: s.cfg.PrivateKey,
			TTL: int(PushTTL / time.Second), Urgency: webpush.UrgencyHigh,
		})
	if err != nil {
		return 0, fmt.Errorf("enviar push: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)) // reaproveita a conexão
	return resp.StatusCode, nil
}

// decodeKey aceita base64url ou padrão, com ou sem "=" (o navegador manda base64url sem padding).
func decodeKey(k string) ([]byte, error) {
	k = strings.TrimRight(k, "=")
	if b, err := base64.RawURLEncoding.DecodeString(k); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(k)
}

// validateSubscriptionKeys confere os tamanhos das chaves da inscrição (P-256 não comprimido e segredo de 16 bytes).
func validateSubscriptionKeys(p256dh, auth string) error {
	dh, err := decodeKey(p256dh)
	if err != nil || len(dh) != 65 || dh[0] != 4 {
		return errInvalidKeys
	}
	if a, err := decodeKey(auth); err != nil || len(a) != 16 {
		return errInvalidKeys
	}
	return nil
}

// httpOutcome classifica a resposta do serviço de push.
type httpOutcome int

const (
	outcomeSent   httpOutcome = iota // 2xx
	outcomeGone                      // 404/410: a inscrição não existe mais
	outcomeRetry                     // 429/5xx/outros transitórios
	outcomeReject                    // 4xx definitivo (payload ou VAPID recusados): não adianta repetir
)

func classify(status int) httpOutcome {
	switch {
	case status >= 200 && status < 300:
		return outcomeSent
	case status == http.StatusNotFound || status == http.StatusGone:
		return outcomeGone
	case status == http.StatusTooManyRequests || status >= 500 || status == http.StatusRequestTimeout:
		return outcomeRetry
	default:
		return outcomeReject
	}
}
