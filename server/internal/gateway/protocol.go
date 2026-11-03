// Package gateway é o gateway realtime (SPEC 5.3): a única parte do backend que conhece WebSocket.
// Os services só publicam no barramento `platform/events`; aqui os eventos viram frames, são
// entregues por tópico (`user:`, `guild:`, `channel:`) respeitando VIEW_CHANNEL e guardados em um
// buffer por sessão para o resume (RNF07).
package gateway

import (
	"encoding/json"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/dmcall"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/notification"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
	"github.com/devGustavoMuniz/spook/server/internal/relationship"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
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
	OpPresence       Op = 12 // cliente → servidor: muda o status da sessão ({status: online|idle}), Fase 4
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

	// Emitidos pelas features (Fase 4: typing e presence); os nomes ficam fixados aqui.
	EventTypingStart      = events.TypingStart
	EventPresenceUpdate   = events.PresenceUpdate
	EventVoiceStateUpdate = "VOICE_STATE_UPDATE"
	EventReadStateUpdate  = events.ReadStateUpdate
	// Adicionais: a preferência de status do próprio usuário e os silêncios/níveis de notificação (tópico user:<id>).
	EventPresenceSelfUpdate         = events.PresenceSelfUpdate
	EventNotificationSettingsUpdate = events.NotificationSettingsUpdate
	// Social (tópico user:<id>): amizades, bloqueios e chamadas de DM.
	EventRelationshipAdd    = events.RelationshipAdd
	EventRelationshipUpdate = events.RelationshipUpdate
	EventRelationshipRemove = events.RelationshipRemove
	EventCallRing           = events.CallRing
	EventCallUpdate         = events.CallUpdate
	EventCallEnd            = events.CallEnd
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

// SetPresence é o d do op 12 (cliente → servidor): o status desta sessão. O cliente manda "idle"
// depois de 10 min sem interação e "online" quando o usuário volta.
type SetPresence struct {
	Status string `json:"status" doc:"online ou idle"`
}

// Ready é o d do dispatch READY. Guilds usa o mesmo formato do GET /api/guilds (canais sem
// VIEW_CHANNEL vêm vazios); PrivateChannels, o do GET /api/users/@me/channels (DMs com
// participantes); Presences, os usuários não-offline que compartilham servidor ou DM com quem
// conectou.
type Ready struct {
	SessionID            string                          `json:"session_id"`
	User                 ReadyUser                       `json:"user"`
	Guilds               []guild.DetailPayload           `json:"guilds" doc:"Lista de servidores completos (GET /api/guilds)"`
	PrivateChannels      []channel.ChannelPayload        `json:"private_channels" doc:"DMs com participantes, da atividade mais recente para a mais antiga"`
	Presences            []presence.UpdatePayload        `json:"presences" doc:"Snapshot de presença (só online e idle)"`
	VoiceStates          []voice.StatePayload            `json:"voice_states" doc:"Quem está em voz agora nos servidores que o usuário vê e nas DMs dele"`
	ReadStates           []notification.ReadStatePayload `json:"read_states" doc:"Canais com não lidas ou menções (mesmo formato de GET /api/users/@me/read-states); canal ausente = zero"`
	SelfPresence         presence.SelfPayload            `json:"self_presence" doc:"Preferência de status do próprio usuário (online, dnd ou invisible) e status personalizado"`
	NotificationSettings []notification.SettingPayload   `json:"notification_settings" doc:"Silêncios e níveis de notificação que diferem do padrão (GET /api/users/@me/notification-settings)"`
	Relationships        relationship.RelationshipsReady `json:"relationships" doc:"Resumo das amizades: contagens, IDs de todos os bloqueados e até 200 pedidos e amigos (o resto: GET /api/users/me/relationships)"`
	Calls                []dmcall.Call                   `json:"calls" doc:"Chamadas de DM tocando para você agora (quem recarregou no meio do toque)"`
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

// ---- Payloads dos eventos das fases 5–6  ----
// TYPING_START e PRESENCE_UPDATE (Fase 4) têm os payloads em typing.StartPayload e presence.UpdatePayload.

// VoiceStateUpdate: estado de voz de um usuário (Fase 5). channel_id nulo = saiu da voz. O tipo
// e a emissão ficam em internal/voice.
type VoiceStateUpdate = voice.StatePayload

// ReadStateUpdate: o estado de leitura de um canal mudou (Fase 6); só vai ao próprio usuário (tópico
// user:<id>, todas as sessões). O tipo e a emissão ficam em internal/notification.
type ReadStateUpdate = notification.UpdatePayload

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
