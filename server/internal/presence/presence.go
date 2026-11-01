// Package presence mantém o status online/ausente/offline dos usuários (RF08.1, SPEC 7.6), só em
// memória. O gateway avisa quando uma sessão conecta, cai ou muda de idle (interface
// gateway.Presence, implementada por Service); as transições viram PRESENCE_UPDATE no barramento,
// entregue a quem compartilha servidor (guild:<id>) ou DM (user:<par>) com o usuário.
package presence

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// Status de presença (SPEC 7.6). O que os outros veem é online, idle, dnd ou offline.
const (
	StatusOnline  = "online"
	StatusIdle    = "idle"
	StatusDND     = "dnd"
	StatusOffline = "offline"
)

// Preferências de status escolhidas pela pessoa (status_pref). "Invisível" nunca é publicado: para os
// outros a pessoa aparece offline; só ela (e as sessões dela) sabe, por PRESENCE_SELF_UPDATE.
const (
	PrefOnline    = "online"
	PrefDND       = "dnd"
	PrefInvisible = "invisible"
)

// Limites do status personalizado.
const (
	MaxCustomTextRunes  = 128
	MaxCustomEmojiRunes = 32
	// MaxCustomTTL é o maior prazo aceito para a expiração ("hoje" cabe em 24 h; sobra folga para fusos).
	MaxCustomTTL = 48 * time.Hour
)

var (
	ErrInvalidPref   = apperr.Invalid("preferência de status inválida: use online, dnd ou invisible")
	ErrInvalidCustom = apperr.Invalid("status personalizado inválido: informe texto (até 128 caracteres) e/ou emoji, com expiração futura de até 48 h")
)

// CustomStatus é o status personalizado (texto e/ou emoji). ExpiresAt nulo = não expira; vencido, o
// servidor o trata como inexistente (ver Service).
type CustomStatus struct {
	Text      string     `json:"text,omitempty" maxLength:"128"`
	Emoji     string     `json:"emoji,omitempty" maxLength:"32"`
	ExpiresAt *time.Time `json:"expires_at,omitempty" doc:"Instante em que o status some sozinho; ausente = não expira"`
}

// UpdatePayload é o dado do evento PRESENCE_UPDATE e de cada item de `presences` no READY.
type UpdatePayload struct {
	UserID       string        `json:"user_id"`
	Status       string        `json:"status" doc:"online, idle, dnd ou offline"`
	CustomStatus *CustomStatus `json:"custom_status,omitempty" doc:"Status personalizado vigente (ausente = nenhum)"`
}

// SelfPayload é a preferência da própria pessoa: vai no READY (self_presence), na resposta do
// PATCH /users/@me/presence e no evento PRESENCE_SELF_UPDATE (tópico user:<id>, sincroniza as abas).
type SelfPayload struct {
	StatusPref   string        `json:"status_pref" enum:"online,dnd,invisible"`
	CustomStatus *CustomStatus `json:"custom_status,omitempty"`
}

// Prefs é o que fica no banco.
type Prefs struct {
	Pref   string
	Custom *CustomStatus
}

// DefaultOfflineGrace é a tolerância antes de declarar offline quem perdeu a última sessão
// (evita oscilação em reconexões rápidas).
const DefaultOfflineGrace = 15 * time.Second

// Timer e Clock existem para os testes controlarem o tempo.
type Timer interface{ Stop() bool }

type Clock interface {
	AfterFunc(d time.Duration, f func()) Timer
}

type realClock struct{}

func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// Config reúne os tempos do serviço (os testes usam valores curtos ou um relógio falso).
type Config struct {
	// OfflineGrace é quanto esperar, depois que a última sessão cai, antes de publicar offline
	// (padrão 15 s). Reconectar dentro do prazo não gera evento.
	OfflineGrace time.Duration
	Clock        Clock // padrão: relógio real
	Shards       int   // filas de publicação (ordem preservada por usuário); padrão 4
	// Now é o relógio da expiração do status personalizado; padrão time.Now.
	Now func() time.Time
}

func (c Config) withDefaults() Config {
	if c.OfflineGrace <= 0 {
		c.OfflineGrace = DefaultOfflineGrace
	}
	if c.Clock == nil {
		c.Clock = realClock{}
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Shards <= 0 {
		c.Shards = 4
	}
	return c
}
