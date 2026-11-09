// Package entitlement implementa as concessões de plano (Nitro e Nitro+, adicional fora do SPEC): o administrador
// concede um plano por prazo (ou permanente) e gera códigos de resgate; a pessoa resgata o código e consulta o
// próprio plano. O plano efetivo é o maior entre as concessões não revogadas e não vencidas (internal/plan).
// Segue handler → service → store. Pagamento fica para outra tarefa (source "payment" já existe no modelo).
//
// Regras que não podem vazar: o texto de um código só existe na resposta que o gerou (no banco fica só o hash);
// a fonte e a validade do plano só aparecem para a própria pessoa (GET /api/me/plan) e para o administrador, nunca
// para terceiros (UserPublic.plan leva só o plano). Os avisos vão pelo barramento (ENTITLEMENT_UPDATE no tópico
// user:<id> e USER_UPDATE para quem vê o perfil); só o gateway conhece o WebSocket.
package entitlement

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// Limites de domínio.
const (
	MaxDays         = 3650 // 10 anos
	MaxCodeBatch    = 100  // códigos por pedido
	MaxCodeValidity = 365  // validade do próprio código, em dias
	AdminPageSize   = 25
	expireBatch     = 200
)

// Source diz de onde veio a concessão.
type Source string

const (
	SourceAdmin   Source = "admin"
	SourceCode    Source = "code"
	SourcePayment Source = "payment"
)

var (
	ErrUserNotFound  = apperr.NotFound("usuário não encontrado")
	ErrGrantNotFound = apperr.NotFound("concessão não encontrada")
	ErrNoActive      = apperr.NotFound("esta pessoa não tem plano ativo")
	ErrCodeInvalid   = apperr.NotFound("código de resgate inválido")
	ErrCodeUsed      = apperr.Conflict("este código já foi usado")
	ErrCodeExpired   = apperr.Gone("este código expirou")
	ErrInvalidTier   = apperr.Invalid("plano inválido: use nitro ou nitro_plus")
	ErrInvalidDays   = apperr.Invalid("prazo inválido: use de 1 a 3650 dias, ou deixe vazio para permanente")
	ErrInvalidQty    = apperr.Invalid("quantidade inválida: use de 1 a 100 códigos")
	ErrInvalidFilter = apperr.Invalid("filtro inválido")
)

// Grant é uma concessão de plano.
type Grant struct {
	ID           int64
	UserID       int64
	Tier         plan.Tier
	Source       Source
	ExpiresAt    *time.Time // nulo = permanente
	GrantedBy    *int64
	RedeemCodeID *int64
	RevokedAt    *time.Time
	CreatedAt    time.Time
}

// Plan converte a concessão no tipo do cálculo de plano.
func (g Grant) Plan() plan.Entitlement {
	return plan.Entitlement{Tier: g.Tier, Source: string(g.Source), ExpiresAt: g.ExpiresAt, RevokedAt: g.RevokedAt}
}

// Code é um código de resgate (sem o texto: só o hash).
type Code struct {
	ID         int64
	Hash       string
	Hint       string
	Tier       plan.Tier
	Days       *int // nulo = permanente
	CreatedBy  *int64
	RedeemedBy *int64
	RedeemedAt *time.Time
	ExpiresAt  *time.Time
	CreatedAt  time.Time
}

// Account é a pessoa alvo de uma concessão.
type Account struct {
	ID          int64
	Username    string
	DisplayName string
}

// GrantRow é uma linha da lista do administrador.
type GrantRow struct {
	Grant
	Username          string
	DisplayName       string
	GrantedByUsername string
	Active            bool
}

// CodeRow é um código na lista do administrador.
type CodeRow struct {
	Code
	CreatedByUsername  string
	RedeemedByUsername string
}

// GrantFilter filtra a lista de concessões.
type GrantFilter struct {
	State string // active (padrão), inactive ou all
	Tier  string
	Q     string
	Page  int
}

// CodeFilter filtra a lista de códigos.
type CodeFilter struct {
	State string // unused (padrão), used, expired ou all
	Tier  string
	Page  int
}

// ---- payloads da API ----

// PlanPayload é o plano de uma pessoa visto por ela mesma (GET /api/me/plan e dado do ENTITLEMENT_UPDATE).
type PlanPayload struct {
	Tier      string      `json:"tier" enum:"free,nitro,nitro_plus" doc:"Plano efetivo agora"`
	ExpiresAt *time.Time  `json:"expires_at" doc:"Quando o plano vence. Nulo = permanente (ou plano grátis)"`
	Source    *string     `json:"source" enum:"admin,code,payment" doc:"De onde veio a concessão que define o plano (nulo no plano grátis)"`
	Limits    plan.Limits `json:"limits" doc:"O que o plano libera"`
}

// UpdatePayload é o dado do evento ENTITLEMENT_UPDATE (tópico user:<id>): o plano da pessoa mudou.
type UpdatePayload struct {
	PlanPayload
	Reason string `json:"reason" enum:"granted,revoked,redeemed,expired" doc:"Por que mudou (o app avisa quando é expired)"`
}

// GrantPayload é uma concessão na lista do administrador.
type GrantPayload struct {
	ID          string     `json:"id" doc:"ID Snowflake (string)"`
	UserID      string     `json:"user_id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name,omitempty"`
	Tier        string     `json:"tier" enum:"nitro,nitro_plus"`
	Source      string     `json:"source" enum:"admin,code,payment"`
	ExpiresAt   *time.Time `json:"expires_at" doc:"Nulo = permanente"`
	GrantedBy   string     `json:"granted_by,omitempty" doc:"Username de quem concedeu (vazio se foi resgate ou a conta saiu)"`
	RevokedAt   *time.Time `json:"revoked_at"`
	CreatedAt   time.Time  `json:"created_at"`
	Active      bool       `json:"active" doc:"Não revogada e não vencida"`
}

// GrantsPage é uma página da lista de concessões.
type GrantsPage struct {
	Items    []GrantPayload `json:"items"`
	Total    int64          `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"page_size"`
}

// RevokeResult é a resposta de revogar o plano de uma pessoa.
type RevokeResult struct {
	Revoked int         `json:"revoked" doc:"Quantas concessões ativas foram revogadas"`
	Plan    PlanPayload `json:"plan" doc:"O plano da pessoa depois da revogação"`
}

// NewCodePayload é um código recém-gerado: o texto só aparece aqui, uma única vez.
type NewCodePayload struct {
	ID        string     `json:"id"`
	Code      string     `json:"code" doc:"Texto do código (SPOOK-XXXX-XXXX-XXXX-XXXX). Mostrado só nesta resposta; o servidor guarda apenas o hash"`
	Tier      string     `json:"tier" enum:"nitro,nitro_plus"`
	Days      *int       `json:"days" doc:"Dias de plano que o código dá. Nulo = permanente"`
	ExpiresAt *time.Time `json:"expires_at" doc:"Até quando o código pode ser resgatado. Nulo = não vence"`
}

// NewCodesPayload é o lote gerado.
type NewCodesPayload struct {
	Items []NewCodePayload `json:"items"`
}

// CodePayload é um código na lista do administrador (sem o texto).
type CodePayload struct {
	ID         string     `json:"id"`
	Hint       string     `json:"hint" doc:"Últimos 4 caracteres do código, para reconhecê-lo"`
	Tier       string     `json:"tier" enum:"nitro,nitro_plus"`
	Days       *int       `json:"days" doc:"Nulo = permanente"`
	State      string     `json:"state" enum:"unused,used,expired"`
	CreatedAt  time.Time  `json:"created_at"`
	CreatedBy  string     `json:"created_by,omitempty" doc:"Username de quem gerou"`
	RedeemedBy string     `json:"redeemed_by,omitempty" doc:"Username de quem resgatou"`
	RedeemedAt *time.Time `json:"redeemed_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
}

// CodesPage é uma página da lista de códigos.
type CodesPage struct {
	Items    []CodePayload `json:"items"`
	Total    int64         `json:"total"`
	Page     int           `json:"page"`
	PageSize int           `json:"page_size"`
}

func grantPayload(r GrantRow) GrantPayload {
	return GrantPayload{
		ID: httpx.ID(r.ID), UserID: httpx.ID(r.UserID), Username: r.Username, DisplayName: r.DisplayName,
		Tier: string(r.Tier), Source: string(r.Source), ExpiresAt: r.ExpiresAt, GrantedBy: r.GrantedByUsername,
		RevokedAt: r.RevokedAt, CreatedAt: r.CreatedAt, Active: r.Active,
	}
}

func codePayload(r CodeRow, now time.Time) CodePayload {
	state := "unused"
	switch {
	case r.RedeemedAt != nil:
		state = "used"
	case r.ExpiresAt != nil && !r.ExpiresAt.After(now):
		state = "expired"
	}
	return CodePayload{
		ID: httpx.ID(r.ID), Hint: r.Hint, Tier: string(r.Tier), Days: r.Days, State: state, CreatedAt: r.CreatedAt,
		CreatedBy: r.CreatedByUsername, RedeemedBy: r.RedeemedByUsername, RedeemedAt: r.RedeemedAt, ExpiresAt: r.ExpiresAt,
	}
}
