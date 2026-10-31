// Package presence mantém o status online/ausente/offline dos usuários (RF08.1, SPEC 7.6), só em
// memória. O gateway avisa quando uma sessão conecta, cai ou muda de idle (interface
// gateway.Presence, implementada por Service); as transições viram PRESENCE_UPDATE no barramento,
// entregue a quem compartilha servidor (guild:<id>) ou DM (user:<par>) com o usuário.
package presence

import "time"

// Status de presença (SPEC 7.6).
const (
	StatusOnline  = "online"
	StatusIdle    = "idle"
	StatusOffline = "offline"
)

// UpdatePayload é o dado do evento PRESENCE_UPDATE e de cada item de `presences` no READY.
type UpdatePayload struct {
	UserID string `json:"user_id"`
	Status string `json:"status" doc:"online, idle ou offline"`
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
}

func (c Config) withDefaults() Config {
	if c.OfflineGrace <= 0 {
		c.OfflineGrace = DefaultOfflineGrace
	}
	if c.Clock == nil {
		c.Clock = realClock{}
	}
	if c.Shards <= 0 {
		c.Shards = 4
	}
	return c
}
