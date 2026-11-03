// Package dmcall cuida do toque das chamadas de voz em DM (adicional "Social"): quem liga faz as outras pessoas
// da conversa tocarem por até 45 s; elas atendem (recebem o token de voz), recusam ou deixam expirar. O estado é só
// memória (como o da voz) e o áudio continua sendo do pacote voice: aqui ficam o "tocando", os avisos pelo gateway
// (CALL_RING, CALL_UPDATE, CALL_END) e as regras de quem NÃO deve ouvir o toque (bloqueio, Não perturbar, DM silenciada).
package dmcall

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// RingDuration é quanto a chamada toca antes de contar como perdida.
const RingDuration = 45 * time.Second

// State é o estado da chamada.
type State string

const (
	StateRinging State = "ringing"
	StateActive  State = "active" // alguém atendeu ou entrou na sala
)

// Motivos de fim ou de mudança.
const (
	ReasonCancelled = "cancelled" // quem ligou desistiu
	ReasonMissed    = "missed"    // ninguém atendeu em 45 s
	ReasonDeclined  = "declined"  // recusada
	ReasonAnswered  = "answered"  // atendida
	ReasonEnded     = "ended"     // todos saíram da sala
)

var (
	ErrNoCall       = apperr.NotFound("essa chamada já acabou")
	ErrAlreadyCall  = apperr.Conflict("já existe uma chamada tocando nesta conversa")
	ErrCallActive   = apperr.Conflict("já há uma chamada em andamento nesta conversa: entre na sala")
	ErrCallerAction = apperr.Invalid("você iniciou esta chamada: use cancelar")
	ErrNotCaller    = apperr.Forbidden("só quem iniciou a chamada pode cancelá-la")
	ErrBlockedByMe  = apperr.Forbidden("você bloqueou esta pessoa: desbloqueie para ligar")
	ErrNoOneToRing  = apperr.Invalid("não há mais ninguém nesta conversa para chamar")
)

// CallCaller é quem está ligando.
type CallCaller struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

// Call é a chamada na API e nos eventos CALL_RING, CALL_UPDATE e CALL_END.
type Call struct {
	ChannelID   string      `json:"channel_id"`
	State       string      `json:"state" enum:"ringing,active,ended"`
	StartedBy   string      `json:"started_by"`
	StartedAt   time.Time   `json:"started_at"`
	ExpiresAt   *time.Time  `json:"expires_at,omitempty" doc:"Quando o toque para (só enquanto toca)"`
	Caller      *CallCaller `json:"caller,omitempty" doc:"Quem está ligando (CALL_RING)"`
	ChannelName string      `json:"channel_name,omitempty" doc:"Nome da DM em grupo, se tiver"`
	Group       bool        `json:"group" doc:"A chamada é numa DM em grupo"`
	Reason      string      `json:"reason,omitempty" enum:"cancelled,missed,declined,answered,ended" doc:"CALL_UPDATE e CALL_END: o que aconteceu"`
	UserID      *string     `json:"user_id,omitempty" doc:"CALL_UPDATE: quem atendeu ou recusou"`
}
