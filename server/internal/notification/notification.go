// Package notification cuida das não lidas e menções (RF11.1) e do Web Push (RF11.3, RNF04).
//
// A feature assina MESSAGE_CREATE no barramento de eventos: avança a leitura do autor, soma menções
// (e as DMs) para os outros, avisa as demais sessões (READ_STATE_UPDATE) e enfileira o push de quem
// está sem sessão de gateway. O pacote message não a importa: a resolução de @username no envio chega
// por uma interface (message.Mentions) que o Service implementa.
package notification

import (
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

const (
	// MaxUnread é o teto de unread_count por canal (e da soma por servidor): 100 significa "100 ou mais" (UI "99+").
	MaxUnread = 100
	// MaxMentions é o máximo de usuários mencionados por mensagem.
	MaxMentions = 20
	// MaxSubscriptions é o máximo de inscrições de push por usuário (um navegador/dispositivo cada).
	MaxSubscriptions = 10
)

var (
	ErrPushDisabled   = apperr.Unavailable("notificações push não estão configuradas neste servidor")
	ErrTooManySubs    = apperr.Conflict("limite de 10 dispositivos com notificações push; remova um antes de adicionar outro")
	ErrNotReadable    = apperr.Invalid("só canais de texto e DMs têm estado de leitura")
	errInvalidKeys    = apperr.Invalid("chaves da inscrição de push inválidas")
	errInvalidMessage = apperr.Invalid("message_id inválido")
)

// ReadState é o estado de leitura de um canal acessível ao usuário.
type ReadState struct {
	ChannelID int64
	GuildID   *int64 // nil nas DMs
	// LastRead é o último ID lido; sem linha em read_states vale a base (entrada no servidor, ou a criação da DM).
	LastRead int64
	Mentions int
	Unread   int // 0..MaxUnread
}

// ReadStatePayload é um canal em GET /users/@me/read-states e em READY.read_states.
type ReadStatePayload struct {
	ChannelID         string `json:"channel_id"`
	GuildID           string `json:"guild_id,omitempty" doc:"Omitido em DMs"`
	LastReadMessageID string `json:"last_read_message_id" doc:"Último ID lido; sem leitura registrada, a base (entrada no servidor ou criação da DM)"`
	MentionCount      int    `json:"mention_count"`
	UnreadCount       int    `json:"unread_count" doc:"Mensagens não lidas de outros usuários, limitado a 100 (100 = 100 ou mais; a UI mostra 99+)"`
}

// GuildReadStatePayload é o agregado de um servidor (soma dos canais que o usuário vê).
type GuildReadStatePayload struct {
	GuildID      string `json:"guild_id"`
	UnreadCount  int    `json:"unread_count" doc:"Soma dos canais, limitada a 100 (100 = 100 ou mais)"`
	MentionCount int    `json:"mention_count"`
}

// UpdatePayload é o dado do evento READ_STATE_UPDATE (tópico user:<id>) e a resposta do ack.
type UpdatePayload struct {
	ChannelID         string `json:"channel_id"`
	LastReadMessageID string `json:"last_read_message_id"`
	MentionCount      int    `json:"mention_count"`
}

// Payload converte para o formato da API.
func (r ReadState) Payload() ReadStatePayload {
	p := ReadStatePayload{
		ChannelID: httpx.ID(r.ChannelID), LastReadMessageID: httpx.ID(r.LastRead),
		MentionCount: r.Mentions, UnreadCount: r.Unread,
	}
	if r.GuildID != nil {
		p.GuildID = httpx.ID(*r.GuildID)
	}
	return p
}

// Active diz se o canal tem algo a mostrar (não lidas ou menções): só esses vão no READY.
func (r ReadState) Active() bool { return r.Unread > 0 || r.Mentions > 0 }

// Summarize agrega os canais por servidor (DMs ficam de fora). A soma de não lidas é limitada a MaxUnread.
func Summarize(states []ReadState) []GuildReadStatePayload {
	type agg struct{ unread, mentions int }
	byGuild := map[int64]*agg{}
	var order []int64
	for _, s := range states {
		if s.GuildID == nil {
			continue
		}
		a := byGuild[*s.GuildID]
		if a == nil {
			a = &agg{}
			byGuild[*s.GuildID] = a
			order = append(order, *s.GuildID)
		}
		a.unread += s.Unread
		a.mentions += s.Mentions
	}
	out := make([]GuildReadStatePayload, 0, len(order))
	for _, gid := range order {
		a := byGuild[gid]
		out = append(out, GuildReadStatePayload{GuildID: httpx.ID(gid), UnreadCount: min(a.unread, MaxUnread), MentionCount: a.mentions})
	}
	return out
}

// Payloads converte uma lista; keepAll=false mantém só os canais com não lidas ou menções.
func Payloads(states []ReadState, keepAll bool) []ReadStatePayload {
	out := make([]ReadStatePayload, 0, len(states))
	for _, s := range states {
		if keepAll || s.Active() {
			out = append(out, s.Payload())
		}
	}
	return out
}
