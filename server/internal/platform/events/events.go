// Package events é o barramento interno em memória. Os services publicam eventos de domínio;
// só o gateway (Fase 3) os converte em mensagens WebSocket.
package events

import (
	"log/slog"
	"sync"
	"time"
)

// Tipos de evento (SPEC 5.3).
const (
	GuildCreate       = "GUILD_CREATE"
	GuildUpdate       = "GUILD_UPDATE"
	GuildDelete       = "GUILD_DELETE"
	GuildMemberAdd    = "GUILD_MEMBER_ADD"
	GuildMemberRemove = "GUILD_MEMBER_REMOVE"
	GuildMemberUpdate = "GUILD_MEMBER_UPDATE"
	ChannelCreate     = "CHANNEL_CREATE"
	ChannelUpdate     = "CHANNEL_UPDATE"
	ChannelDelete     = "CHANNEL_DELETE"
	RoleCreate        = "ROLE_CREATE"
	RoleUpdate        = "ROLE_UPDATE"
	RoleDelete        = "ROLE_DELETE"
	MessageCreate     = "MESSAGE_CREATE"
	MessageUpdate     = "MESSAGE_UPDATE"
	MessageDelete     = "MESSAGE_DELETE"
	TypingStart       = "TYPING_START"
	PresenceUpdate    = "PRESENCE_UPDATE"
	VoiceStateUpdate  = "VOICE_STATE_UPDATE"
	ReadStateUpdate   = "READ_STATE_UPDATE"
	// UserUpdate: o perfil público de um usuário mudou (nome de exibição, avatar, bio, pronomes, banner). Vai ao
	// próprio usuário (user:<id>, todas as sessões), aos servidores dele (guild:<id>) e a quem divide DM ou amizade
	// com ele (user:<par>). Data = user.UpdatePayload.
	UserUpdate = "USER_UPDATE"
	// EntitlementUpdate: o plano (Nitro/Nitro+) da própria pessoa mudou (concedido, revogado, resgatado ou vencido).
	// Vai só a ela (user:<id>, todas as sessões). Data = entitlement.UpdatePayload. Quem vê o perfil dela recebe o
	// plano novo em USER_UPDATE.
	EntitlementUpdate = "ENTITLEMENT_UPDATE"
	// ChannelOverwritesUpdate é INTERNO (nunca vai ao cliente): os overwrites de um canal mudaram e o gateway
	// e a voz reavaliam quem vê o canal. Data = o canal (ChannelPayload).
	ChannelOverwritesUpdate = "CHANNEL_OVERWRITES_UPDATE"
	// PresenceSelfUpdate: a preferência de status/status personalizado do próprio usuário mudou (user:<id>).
	PresenceSelfUpdate = "PRESENCE_SELF_UPDATE"
	// NotificationSettingsUpdate: silenciar/nível de notificação mudou (user:<id>, sincroniza sessões).
	NotificationSettingsUpdate = "NOTIFICATION_SETTINGS_UPDATE"
	// Social (tópico user:<id>, só ao usuário envolvido): amizades, pedidos e bloqueios.
	RelationshipAdd    = "RELATIONSHIP_ADD"    // novo relacionamento (pedido enviado/recebido, bloqueio)
	RelationshipUpdate = "RELATIONSHIP_UPDATE" // pedido recebido virou amizade
	TicketUpdate       = "TICKET_UPDATE"       // chamado de feedback mudou (tópico user:<autor>)
	RelationshipRemove = "RELATIONSHIP_REMOVE" // amizade desfeita, pedido cancelado/recusado ou desbloqueio
	// Chamada em DM com toque (tópico user:<id> dos participantes).
	CallRing   = "CALL_RING"   // chamada recebida (só quem deve tocar)
	CallUpdate = "CALL_UPDATE" // o estado da chamada mudou (atendida, recusada por alguém...)
	CallEnd    = "CALL_END"    // a chamada acabou (cancelada, sem resposta, recusada por todos, encerrada)
)

// Event é um fato ocorrido no domínio. Topics diz quem deve recebê-lo
// (`user:<id>`, `guild:<id>`, `channel:<id>`); Data é o payload exportado da feature.
type Event struct {
	Type      string
	GuildID   int64
	ChannelID int64
	Topics    []string
	Data      any
	// At é o instante da publicação (o Bus preenche se estiver zerado); o gateway mede
	// a latência publicação → escrita no socket a partir dele.
	At time.Time
}

// Publisher é o que os services precisam do barramento.
type Publisher interface {
	Publish(Event)
}

// Discard é um Publisher que descarta tudo (usado em testes e quando não há assinantes).
type Discard struct{}

func (Discard) Publish(Event) {}

const defaultQueue = 256

type subscriber struct {
	ch   chan Event
	done chan struct{}
}

// Bus entrega cada evento, de forma assíncrona, a todos os assinantes. Cada assinante tem uma
// fila limitada e uma goroutine própria; se a fila encher o evento é descartado para aquele
// assinante (assinante lento nunca bloqueia quem publica).
type Bus struct {
	mu    sync.RWMutex
	subs  map[*subscriber]struct{}
	queue int
}

// NewBus cria um barramento; queue <= 0 usa o padrão (256 eventos por assinante).
func NewBus(queue int) *Bus {
	if queue <= 0 {
		queue = defaultQueue
	}
	return &Bus{subs: map[*subscriber]struct{}{}, queue: queue}
}

// Subscribe registra fn para receber os eventos publicados daqui em diante, em ordem.
// O cancel encerra a assinatura e espera a goroutine terminar o evento em andamento.
func (b *Bus) Subscribe(fn func(Event)) (cancel func()) {
	s := &subscriber{ch: make(chan Event, b.queue), done: make(chan struct{})}
	b.mu.Lock()
	b.subs[s] = struct{}{}
	b.mu.Unlock()

	go func() {
		defer close(s.done)
		for ev := range s.ch {
			fn(ev)
		}
	}()

	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subs, s)
			close(s.ch) // sob o lock: Publish nunca envia em canal fechado
			b.mu.Unlock()
			<-s.done
		})
	}
}

// Publish nunca bloqueia: assinante com a fila cheia perde o evento.
func (b *Bus) Publish(ev Event) {
	if ev.At.IsZero() {
		ev.At = time.Now()
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for s := range b.subs {
		select {
		case s.ch <- ev:
		default:
			slog.Warn("evento descartado: fila do assinante cheia", "type", ev.Type)
		}
	}
}
