// Package gateway é o gateway realtime (SPEC 5.3): a única parte do backend que conhece WebSocket.
// Os services só publicam no barramento `platform/events`; aqui os eventos viram frames, são
// entregues por tópico (`user:`, `guild:`, `channel:`) respeitando VIEW_CHANNEL e guardados em um
// buffer por sessão para o resume (RNF07).
package gateway

import (
	"encoding/json"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/guild"
)

// Op é o código de operação de um frame.
type Op int

const (
	OpDispatch       Op = 0  // servidor → cliente: evento (campo t) com sequência (campo s)
	OpHeartbeat      Op = 1  // cliente → servidor: d = último s recebido (ou null)
	OpIdentify       Op = 2  // cliente → servidor: abre uma sessão nova
	OpResume         Op = 3  // cliente → servidor: retoma a sessão {session_id, seq}
	OpInvalidSession Op = 9  // servidor → cliente: o resume falhou; faça IDENTIFY de novo
	OpHello          Op = 10 // servidor → cliente: primeiro frame, informa o heartbeat_interval
	OpAck            Op = 11 // servidor → cliente: resposta ao heartbeat
)

// Códigos de fechamento do WebSocket. Os 4xxx são do Spook; o cliente reconecta em todos,
// exceto onde indicado.
const (
	CloseGoingAway        = 1001 // encerramento do servidor: reconecte e faça resume
	CloseUnknown          = 4000 // frame inválido (JSON malformado)
	CloseInvalidOp        = 4001 // op desconhecido ou não permitido nesse estado
	CloseSessionTakenOver = 4002 // a sessão foi retomada por outra conexão
	CloseNotIdentified    = 4003 // op enviado antes do IDENTIFY/RESUME
	CloseAlreadyIdent     = 4005 // IDENTIFY/RESUME repetido
	CloseIdentifyTimeout  = 4006 // sem IDENTIFY/RESUME em 10 s
	CloseSlowConsumer     = 4008 // fila de envio cheia; a sessão é mantida: faça resume
	CloseHeartbeatTimeout = 4009 // sem heartbeat dentro de 1,5× o intervalo; a sessão é mantida
	CloseRateLimited      = 4029 // mais de 120 ops por minuto na conexão
)

// Frame é o envelope de toda mensagem: { "op", "t", "s", "d" }.
type Frame struct {
	Op Op              `json:"op"`
	T  *string         `json:"t"`
	S  *int64          `json:"s"`
	D  json.RawMessage `json:"d"`
}

// Nomes dos eventos que só o gateway conhece.
const (
	EventReady   = "READY"
	EventResumed = "RESUMED"

	// Emitidos a partir das fases 4–6; o contrato fica fixado aqui desde já.
	EventTypingStart      = "TYPING_START"
	EventPresenceUpdate   = "PRESENCE_UPDATE"
	EventVoiceStateUpdate = "VOICE_STATE_UPDATE"
	EventReadStateUpdate  = "READ_STATE_UPDATE"
)

// Hello é o d do op 10.
type Hello struct {
	HeartbeatInterval int64 `json:"heartbeat_interval" doc:"Milissegundos entre heartbeats"`
}

// Identify é o d do op 2. Não leva credenciais (a autenticação é no handshake).
type Identify struct {
	Client string `json:"client,omitempty" doc:"Opcional: web, desktop, bench…"`
}

// Resume é o d do op 3.
type Resume struct {
	SessionID string `json:"session_id"`
	Seq       int64  `json:"seq" doc:"Último s recebido"`
}

// Ready é o d do dispatch READY. Guilds usa o mesmo formato do GET /api/guilds (canais sem
// VIEW_CHANNEL vêm vazios).
type Ready struct {
	SessionID string                `json:"session_id"`
	User      ReadyUser             `json:"user"`
	Guilds    []guild.DetailPayload `json:"guilds" doc:"Lista de servidores completos (GET /api/guilds)"`
}

// ReadyUser é o usuário autenticado no READY.
type ReadyUser struct {
	ID string `json:"id"`
}

// Resumed é o d do dispatch RESUMED.
type Resumed struct {
	SessionID string `json:"session_id"`
	Replayed  int    `json:"replayed" doc:"Quantos eventos perdidos foram reenviados antes do RESUMED"`
}

// ---- Payloads dos eventos das fases 4–6 (contrato fixo, ainda não emitidos) ----

// TypingStart: alguém começou a digitar em um canal (Fase 4). Expira em 8 s sem novo evento.
type TypingStart struct {
	ChannelID string  `json:"channel_id"`
	GuildID   *string `json:"guild_id"`
	UserID    string  `json:"user_id"`
	Timestamp int64   `json:"timestamp" doc:"Unix, em segundos"`
}

// Status de presença (SPEC 7.6).
const (
	StatusOnline  = "online"
	StatusIdle    = "idle"
	StatusOffline = "offline"
)

// PresenceUpdate: mudança de status de um usuário (Fase 4).
type PresenceUpdate struct {
	UserID string `json:"user_id"`
	Status string `json:"status" doc:"online, idle ou offline"`
}

// VoiceStateUpdate: estado de voz de um usuário (Fase 5). ChannelID nulo = saiu da voz.
type VoiceStateUpdate struct {
	GuildID    *string `json:"guild_id"`
	ChannelID  *string `json:"channel_id"`
	UserID     string  `json:"user_id"`
	SelfMute   bool    `json:"self_mute"`
	SelfDeaf   bool    `json:"self_deaf"`
	SelfVideo  bool    `json:"self_video"`
	SelfScreen bool    `json:"self_screen"`
}

// ReadStateUpdate: o estado de leitura de um canal mudou (Fase 6); só vai ao próprio usuário.
type ReadStateUpdate struct {
	ChannelID         string `json:"channel_id"`
	LastReadMessageID string `json:"last_read_message_id"`
	MentionCount      int    `json:"mention_count"`
}

// Config reúne os tempos e limites do gateway (os testes usam valores menores).
type Config struct {
	HeartbeatInterval time.Duration // informado no HELLO (padrão 41 s, abaixo dos 100 s do Cloudflare)
	IdentifyTimeout   time.Duration // padrão 10 s
	ResumeWindow      time.Duration // quanto a sessão sobrevive sem socket (padrão 60 s)
	BufferSize        int           // eventos guardados por sessão para o resume (padrão 512)
	SendQueue         int           // eventos pendentes de envio antes de cortar o consumidor lento (padrão 256)
	WriteTimeout      time.Duration // padrão 10 s
	OpsPerMinute      int           // ops recebidas por conexão por minuto (padrão 120)
	AllowedOrigins    []string      // origens extras aceitas no handshake (ex.: tauri://localhost)
	Dev               bool          // aceita qualquer porta de localhost como origem
	TicketTTL         time.Duration // padrão 30 s
}

func (c Config) withDefaults() Config {
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&c.HeartbeatInterval, 41*time.Second)
	def(&c.IdentifyTimeout, 10*time.Second)
	def(&c.ResumeWindow, 60*time.Second)
	def(&c.WriteTimeout, 10*time.Second)
	def(&c.TicketTTL, 30*time.Second)
	if c.BufferSize <= 0 {
		c.BufferSize = 512
	}
	if c.SendQueue <= 0 {
		c.SendQueue = 256
	}
	if c.SendQueue > c.BufferSize {
		c.SendQueue = c.BufferSize
	}
	if c.OpsPerMinute <= 0 {
		c.OpsPerMinute = 120
	}
	return c
}

// heartbeatTimeout é o prazo sem heartbeat para derrubar a conexão (1,5× o intervalo).
func (c Config) heartbeatTimeout() time.Duration { return c.HeartbeatInterval * 3 / 2 }
