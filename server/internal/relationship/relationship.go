// Package relationship cuida das amizades e dos bloqueios (SPEC 7.4, adicional "Social"): pedidos de amizade,
// lista de relacionamentos, bloquear/desbloquear e "convidar amigo para um servidor pela DM". Também responde
// às outras features (dm, message, notification, presence, dmcall) quem é amigo e quem bloqueou quem, por
// interfaces definidas por elas.
package relationship

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// Limites de domínio (SPEC 7.4).
const (
	MaxFriends          = 1000 // amigos aceitos por pessoa
	MaxPendingOutgoing  = 200  // pedidos enviados e ainda sem resposta
	MaxBlocks           = 500  // pessoas bloqueadas (todas vão como ID no READY)
	DefaultPageSize     = 100
	MaxPageSize         = 200
	MaxReadyItems       = 200 // amigos e pedidos que o READY carrega; o resto vem por REST
	MaxUsernameInputLen = 64
)

// Kind é o tipo de relacionamento do ponto de vista de quem consulta.
type Kind string

const (
	KindNone     Kind = "none"
	KindFriend   Kind = "friend"
	KindIncoming Kind = "incoming" // a outra pessoa pediu amizade a você
	KindOutgoing Kind = "outgoing" // você pediu amizade a ela
	KindBlocked  Kind = "blocked"  // você bloqueou a pessoa
)

func (k Kind) valid() bool {
	switch k {
	case KindFriend, KindIncoming, KindOutgoing, KindBlocked:
		return true
	}
	return false
}

var (
	ErrUserNotFound    = apperr.NotFound("usuário não encontrado")
	ErrRequestNotFound = apperr.NotFound("pedido de amizade não encontrado")
	ErrSelf            = apperr.Invalid("você não pode fazer isso consigo mesmo")
	ErrBlockedByMe     = apperr.Conflict("você bloqueou esta pessoa: desbloqueie para enviar um pedido")
	ErrTooManyFriends  = apperr.Conflict("o limite de 1000 amigos foi atingido por você ou pela outra pessoa")
	ErrTooManyPending  = apperr.Conflict("você já tem 200 pedidos de amizade pendentes: cancele alguns antes de enviar outros")
	ErrTooManyBlocks   = apperr.Conflict("você atingiu o limite de 500 pessoas bloqueadas")
	ErrInvalidKind     = apperr.Invalid("type inválido: use friend, incoming, outgoing ou blocked")
	ErrNotFriend       = apperr.Forbidden("só é possível convidar amigos por aqui")
	ErrAlreadyMember   = apperr.Conflict("essa pessoa já está no servidor")
	ErrNoPublicURL     = apperr.Unavailable("convites por mensagem indisponíveis: PUBLIC_URL não está configurada")
)

// RelationshipUser é a pessoa do outro lado do relacionamento.
type RelationshipUser struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	Plan        string `json:"plan,omitempty" enum:"free,nitro,nitro_plus" doc:"Plano (Grátis, Nitro ou Nitro+). Ausente = free"`
}

// Relationship é um relacionamento na API, no READY e nos eventos RELATIONSHIP_ADD/UPDATE.
type Relationship struct {
	User  RelationshipUser `json:"user"`
	Type  string           `json:"type" enum:"friend,incoming,outgoing,blocked" doc:"friend (amigo), incoming (pedido recebido), outgoing (pedido enviado) ou blocked (você bloqueou)"`
	Since time.Time        `json:"since" doc:"Desde quando: aceite da amizade, envio do pedido ou bloqueio"`
}

// RelationshipRemoved é o dado do evento RELATIONSHIP_REMOVE.
type RelationshipRemoved struct {
	UserID string `json:"user_id"`
}

// RelationshipsReady é o resumo que vai no READY: contagens, os IDs de todos os bloqueados (o cliente oculta as
// mensagens deles) e uma lista limitada de pedidos e amigos (o resto vem por GET /api/users/me/relationships).
type RelationshipsReady struct {
	FriendCount   int            `json:"friend_count"`
	IncomingCount int            `json:"incoming_count"`
	OutgoingCount int            `json:"outgoing_count"`
	BlockedIDs    []string       `json:"blocked_ids" doc:"IDs de todas as pessoas que você bloqueou"`
	Items         []Relationship `json:"items" doc:"Pedidos recebidos, enviados e amigos, até 200 (campo truncated indica se há mais)"`
	Truncated     bool           `json:"truncated"`
}

// RelationshipState é o relacionamento com uma pessoa específica (GET /api/users/{id}/relationship).
type RelationshipState struct {
	UserID string     `json:"user_id"`
	Type   string     `json:"type" enum:"none,friend,incoming,outgoing,blocked"`
	Since  *time.Time `json:"since,omitempty"`
}

// RelationshipPage é uma página de relacionamentos.
type RelationshipPage struct {
	Items     []Relationship `json:"items"`
	NextAfter *string        `json:"next_after" doc:"ID da última pessoa da página; passe em after para a próxima. Nulo = fim"`
}

// Row é um relacionamento lido do banco.
type Row struct {
	OtherID     int64
	Kind        Kind
	Since       time.Time
	Username    string
	DisplayName *string
	AvatarKey   *string
	Plan        string // free, nitro ou nitro_plus
}

// Counts são as contagens por tipo.
type Counts struct{ Friends, Incoming, Outgoing, Blocked int }

// Outcome é o resultado de um pedido de amizade.
type Outcome int

const (
	OutcomeCreated       Outcome = iota // pedido novo
	OutcomeAccepted                     // havia pedido inverso: virou amizade
	OutcomePending                      // já existia um pedido seu
	OutcomeAlreadyFriend                // já eram amigos
	OutcomeBlockedByMe                  // você bloqueou a pessoa
	OutcomeBlockedByThem                // a pessoa bloqueou você (nada é gravado)
)

// RemoveResult descreve o que um DELETE removeu.
type RemoveResult struct {
	Removed     bool
	WasAccepted bool
	RequestedBy int64
}

func idStr(id int64) string { return httpx.ID(id) }
