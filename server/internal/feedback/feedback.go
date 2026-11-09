// Package feedback implementa os chamados de feedback, sugestões e bugs (adicional fora do SPEC): o usuário abre
// um chamado pelas Configurações, acompanha a conversa e responde; o administrador trata a fila em /admin
// (responder, mudar o estado, escrever notas internas). Segue handler → service → store.
//
// Regras que não podem vazar: nota interna (kind "internal") nunca chega ao autor, e o autor nunca vê a
// identidade do administrador que respondeu. O aviso ao autor vai pelo barramento (TICKET_UPDATE, tópico
// user:<id>); só o gateway conhece o WebSocket.
package feedback

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// Limites de domínio.
const (
	TitleMin          = 3
	TitleMax          = 120
	BodyMax           = 4000
	MaxActivePerUser  = 20  // chamados em andamento (aberto, em análise ou respondido) por pessoa
	MaxPublicMessages = 200 // mensagens do autor e públicas do admin por chamado
	MaxInternalNotes  = 100 // notas internas por chamado
	DefaultPageSize   = 20
	MaxPageSize       = 50
	MaxQueryLen       = 100
)

// Kind é o tipo do chamado.
type Kind string

const (
	KindBug        Kind = "bug"
	KindSuggestion Kind = "suggestion"
	KindFeedback   Kind = "feedback"
)

func (k Kind) valid() bool { return k == KindBug || k == KindSuggestion || k == KindFeedback }

// Status é o estado do chamado.
type Status string

const (
	StatusOpen     Status = "open"
	StatusInReview Status = "in_review"
	StatusAnswered Status = "answered"
	StatusResolved Status = "resolved"
	StatusClosed   Status = "closed"
)

func (s Status) valid() bool {
	switch s {
	case StatusOpen, StatusInReview, StatusAnswered, StatusResolved, StatusClosed:
		return true
	}
	return false
}

// active diz se o chamado conta no limite por pessoa.
func (s Status) active() bool { return s == StatusOpen || s == StatusInReview || s == StatusAnswered }

// MessageKind é a origem de uma mensagem.
type MessageKind string

const (
	MsgUser     MessageKind = "user"     // do autor
	MsgAdmin    MessageKind = "admin"    // resposta pública do administrador
	MsgInternal MessageKind = "internal" // nota só dos administradores
)

// Sort é a ordenação da fila do admin.
type Sort string

const (
	SortActivity Sort = "activity" // atividade mais recente primeiro
	SortOldest   Sort = "oldest"   // mais antigos primeiro
)

var (
	ErrNotFound        = apperr.NotFound("chamado não encontrado")
	ErrTooManyActive   = apperr.Conflict("você já tem 20 chamados em andamento: aguarde respostas ou feche alguns antes de abrir outro")
	ErrClosed          = apperr.Conflict("este chamado está fechado: reabra-o para responder")
	ErrTooManyMessages = apperr.Conflict("este chamado atingiu o limite de 200 mensagens")
	ErrTooManyNotes    = apperr.Conflict("este chamado atingiu o limite de 100 notas internas")
	ErrBadTransition   = apperr.Conflict("essa mudança de estado não é possível a partir do estado atual")
	ErrInvalidKind     = apperr.Invalid("tipo inválido: use bug, suggestion ou feedback")
	ErrInvalidStatus   = apperr.Invalid("estado inválido")
	ErrInvalidTitle    = apperr.Invalid("o título deve ter entre 3 e 120 caracteres")
	ErrInvalidBody     = apperr.Invalid("a mensagem deve ter entre 1 e 4000 caracteres")
	ErrInvalidCursor   = apperr.Invalid("cursor inválido")
	ErrInvalidSort     = apperr.Invalid("ordenação inválida: use activity ou oldest")
)

// TicketContext é o contexto técnico que o app anexa ao chamado (opt-out no cliente). Só texto curto, sem dados pessoais.
type TicketContext struct {
	AppVersion string `json:"app_version,omitempty" maxLength:"32" doc:"Versão do app"`
	Client     string `json:"client,omitempty" maxLength:"16" doc:"web ou desktop"`
	OS         string `json:"os,omitempty" maxLength:"64" doc:"Sistema operacional"`
	Browser    string `json:"browser,omitempty" maxLength:"160" doc:"Navegador ou webview (user agent resumido)"`
	Route      string `json:"route,omitempty" maxLength:"200" doc:"Rota aberta no app quando o chamado foi criado"`
	Locale     string `json:"locale,omitempty" maxLength:"16" doc:"Idioma da interface"`
}

// Ticket é um chamado como o service o vê.
type Ticket struct {
	ID             int64
	AuthorID       int64
	Kind           Kind
	Status         Status
	Title          string
	Context        *TicketContext
	MessageCount   int
	UserUnread     bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
	LastActivityAt time.Time
}

// Author é a pessoa que abriu o chamado (visível só aos administradores).
type Author struct {
	ID          int64
	Username    string
	DisplayName string
	Email       string
}

// AdminTicket é um chamado com o autor.
type AdminTicket struct {
	Ticket
	Author Author
}

// Message é uma mensagem do chamado.
type Message struct {
	ID        int64
	TicketID  int64
	AuthorID  *int64
	Kind      MessageKind
	Body      string
	CreatedAt time.Time
	// Autor (preenchido só nas leituras do admin).
	AuthorUsername    string
	AuthorDisplayName string
}

// Cursor é a posição da última linha de uma página.
type Cursor struct {
	At time.Time // last_activity_at (ordenação por atividade); zero em "oldest"
	ID int64
}

// ---- payloads da API ----

// TicketPayload é um chamado na lista e no evento TICKET_UPDATE. Não expõe nada de interno.
type TicketPayload struct {
	ID             string    `json:"id" doc:"ID Snowflake (string)"`
	Kind           string    `json:"kind" enum:"bug,suggestion,feedback"`
	Status         string    `json:"status" enum:"open,in_review,answered,resolved,closed"`
	Title          string    `json:"title"`
	MessageCount   int       `json:"message_count" doc:"Mensagens visíveis ao autor (a abertura conta)"`
	Unread         bool      `json:"unread" doc:"A equipe respondeu e o autor ainda não abriu o chamado"`
	CreatedAt      time.Time `json:"created_at"`
	LastActivityAt time.Time `json:"last_activity_at"`
}

// TicketMessagePayload é uma mensagem para o autor: sem a identidade do administrador.
type TicketMessagePayload struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind" enum:"user,admin" doc:"user = o autor; admin = a equipe (sem identificar quem)"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}

// TicketDetail é o chamado com a conversa, para o autor.
type TicketDetail struct {
	TicketPayload
	Context  *TicketContext         `json:"context,omitempty"`
	Messages []TicketMessagePayload `json:"messages"`
}

// TicketPage é uma página de "meus chamados".
type TicketPage struct {
	Items      []TicketPayload `json:"items"`
	NextCursor *string         `json:"next_cursor" doc:"Passe em cursor para a próxima página. Nulo = fim"`
}

// TicketAuthorPayload é o autor visto pelo administrador.
type TicketAuthorPayload struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	Email       string `json:"email"`
}

// AdminTicketPayload é um linha da fila do administrador.
type AdminTicketPayload struct {
	TicketPayload
	Author TicketAuthorPayload `json:"author"`
}

// TicketAdminMessagePayload é uma mensagem para o administrador (inclui notas internas e o autor de cada uma).
type TicketAdminMessagePayload struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind" enum:"user,admin,internal"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
	Username  string    `json:"username,omitempty" doc:"Quem escreveu (vazio se a conta foi excluída)"`
}

// AdminTicketDetail é o chamado completo para o administrador.
type AdminTicketDetail struct {
	AdminTicketPayload
	Context  *TicketContext              `json:"context,omitempty"`
	Messages []TicketAdminMessagePayload `json:"messages"`
}

// AdminTicketPage é uma página da fila do administrador.
type AdminTicketPage struct {
	Items      []AdminTicketPayload `json:"items"`
	NextCursor *string              `json:"next_cursor" doc:"Passe em cursor para a próxima página. Nulo = fim"`
}

// TicketSummary são as contagens por estado (badge do menu do /admin).
type TicketSummary struct {
	Open     int64 `json:"open"`
	InReview int64 `json:"in_review"`
	Answered int64 `json:"answered"`
	Resolved int64 `json:"resolved"`
	Closed   int64 `json:"closed"`
	Total    int64 `json:"total"`
}

// TicketUpdatePayload é o dado do evento TICKET_UPDATE (tópico user:<id>): o chamado mudou.
type TicketUpdatePayload struct {
	TicketPayload
	ByAdmin bool `json:"by_admin" doc:"A mudança veio da equipe (o app avisa); false = ação do próprio autor em outra sessão"`
}

func payload(t Ticket) TicketPayload {
	return TicketPayload{
		ID: httpx.ID(t.ID), Kind: string(t.Kind), Status: string(t.Status), Title: t.Title,
		MessageCount: t.MessageCount, Unread: t.UserUnread, CreatedAt: t.CreatedAt, LastActivityAt: t.LastActivityAt,
	}
}
