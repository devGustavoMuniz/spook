package entitlement

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// Concessão em massa (lotes). Um lote dá N dias de um plano a todas as contas ativas de uma vez.
//
// Filtro de pessoas: contas com deleted_at nulo (excluídas/anonimizadas ficam de fora). O modelo de dados não
// tem banimento global (banimento é por servidor, não impede o login), então não há outro filtro.
// Soma de validade: a mesma de Grant/Redeem (stackBase); no lote ela roda em SQL (BulkGrantEntitlements).
// Quem já tem concessão PERMANENTE do mesmo plano ou de um maior é pulado (nada a somar; contado em skipped).
// Idempotência: o lote é a marca. Outro pedido com o mesmo plano e prazo, com lote não revogado criado há menos
// de BatchWindow, não grava nada e devolve o lote existente (already_applied). Revogar o lote libera repetir.
const (
	BatchWindow    = 24 * time.Hour
	batchPage      = 500 // pessoas por transação
	batchListLimit = 50
)

var (
	ErrBatchNotFound   = apperr.NotFound("lote não encontrado")
	ErrBatchRevoked    = apperr.Conflict("este lote já foi revogado")
	ErrConfirmRequired = apperr.Invalid("confirme a concessão em massa com confirm: true")
)

// Batch é um lote de concessões.
type Batch struct {
	ID        int64
	Tier      plan.Tier
	Days      int
	CreatedBy *int64
	CreatedAt time.Time
	Granted   int
	Skipped   int
	RevokedAt *time.Time
}

// BatchRow é um lote na lista do administrador.
type BatchRow struct {
	Batch
	CreatedByUsername string
}

// GrantAllBody é o corpo de POST /api/admin/entitlements/grant-all.
type GrantAllBody struct {
	Tier    string `json:"tier" enum:"nitro,nitro_plus" doc:"Plano a conceder a todas as contas ativas"`
	Days    int    `json:"days" minimum:"1" maximum:"3650" doc:"Dias de plano (obrigatório; não existe lote permanente). Somam-se à validade vigente do mesmo plano ou de um maior"`
	Confirm bool   `json:"confirm" doc:"Precisa ser true: ação ampla, sem confirmação explícita responde 422"`
}

// GrantAllResult é a resposta de POST /api/admin/entitlements/grant-all.
type GrantAllResult struct {
	BatchID        string `json:"batch_id" doc:"ID do lote (Snowflake, string)"`
	Granted        int    `json:"granted" doc:"Concessões criadas (uma por conta ativa)"`
	Skipped        int    `json:"skipped" doc:"Contas ativas puladas por já terem o mesmo plano ou um maior de forma permanente"`
	AlreadyApplied bool   `json:"already_applied" doc:"true = já havia um lote igual (mesmo plano e prazo, não revogado) nas últimas 24 h; nada foi gravado"`
}

// RevokeBatchResult é a resposta de DELETE /api/admin/entitlement-batches/{id}.
type RevokeBatchResult struct {
	BatchID string `json:"batch_id"`
	Revoked int    `json:"revoked" doc:"Concessões ativas do lote que foram revogadas"`
}

// BatchPayload é um lote na lista do administrador.
type BatchPayload struct {
	ID        string     `json:"id"`
	Tier      string     `json:"tier" enum:"nitro,nitro_plus"`
	Days      int        `json:"days"`
	CreatedBy string     `json:"created_by,omitempty" doc:"Username de quem criou (vazio se a conta saiu)"`
	CreatedAt time.Time  `json:"created_at"`
	Granted   int        `json:"granted"`
	Skipped   int        `json:"skipped"`
	RevokedAt *time.Time `json:"revoked_at" doc:"Preenchido se o lote foi revogado"`
}

// BatchList é a lista de lotes mais a contagem de contas que um novo lote atingiria (para o diálogo de confirmação).
type BatchList struct {
	Items         []BatchPayload `json:"items" doc:"Os 50 lotes mais recentes"`
	EligibleUsers int64          `json:"eligible_users" doc:"Contas ativas (não excluídas) que um novo lote atingiria"`
}

func batchPayload(r BatchRow) BatchPayload {
	return BatchPayload{
		ID: httpx.ID(r.ID), Tier: string(r.Tier), Days: r.Days, CreatedBy: r.CreatedByUsername, CreatedAt: r.CreatedAt,
		Granted: r.Granted, Skipped: r.Skipped, RevokedAt: r.RevokedAt,
	}
}
