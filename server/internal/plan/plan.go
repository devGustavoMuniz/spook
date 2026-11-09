// Package plan é a fonte única da matriz de planos (Grátis, Nitro e Nitro+): quais recursos cada plano libera e
// como se calcula o plano efetivo de uma pessoa a partir das concessões dela. É puro (sem banco, sem HTTP): o
// backend (upload, voz, API) e o cliente (que espelha a matriz em packages/shared/fixtures/plans.json, gerada
// por um teste daqui) leem os mesmos números.
package plan

import "time"

// Tier é o plano de uma pessoa.
type Tier string

const (
	Free      Tier = "free"
	Nitro     Tier = "nitro"
	NitroPlus Tier = "nitro_plus"
)

// Tiers lista os planos do menor para o maior.
var Tiers = []Tier{Free, Nitro, NitroPlus}

// Parse converte o texto no plano; ok=false para valor desconhecido.
func Parse(s string) (Tier, bool) {
	t := Tier(s)
	return t, t.Valid()
}

// Valid diz se o plano existe.
func (t Tier) Valid() bool { return t == Free || t == Nitro || t == NitroPlus }

// Paid diz se o plano é pago (Nitro ou Nitro+).
func (t Tier) Paid() bool { return t == Nitro || t == NitroPlus }

// Rank ordena os planos (grátis 0, Nitro 1, Nitro+ 2); desconhecido vale 0.
func (t Tier) Rank() int {
	switch t {
	case Nitro:
		return 1
	case NitroPlus:
		return 2
	}
	return 0
}

// AtLeast diz se t é igual ou maior que min.
func (t Tier) AtLeast(min Tier) bool { return t.Rank() >= min.Rank() }

// Higher devolve o maior dos dois planos.
func Higher(a, b Tier) Tier {
	if b.Rank() > a.Rank() {
		return b
	}
	return a
}

// Limits é o que um plano libera.
type Limits struct {
	ScreenMaxHeight int  `json:"screen_max_height" doc:"Maior altura da tela compartilhada, em pixels (720, 1080 ou 1440)"`
	ScreenMaxFPS    int  `json:"screen_max_fps" doc:"Maior taxa de quadros da tela compartilhada (30 ou 60)"`
	AnimatedAvatar  bool `json:"animated_avatar" doc:"Avatar animado (GIF, WebP ou APNG animado)"`
	AnimatedBanner  bool `json:"animated_banner" doc:"Banner animado (GIF, WebP ou APNG animado)"`
}

// For devolve os limites do plano; plano desconhecido vale como grátis.
func For(t Tier) Limits {
	switch t {
	case Nitro:
		return Limits{ScreenMaxHeight: 1080, ScreenMaxFPS: 60, AnimatedAvatar: true, AnimatedBanner: true}
	case NitroPlus:
		return Limits{ScreenMaxHeight: 1440, ScreenMaxFPS: 60, AnimatedAvatar: true, AnimatedBanner: true}
	}
	return Limits{ScreenMaxHeight: 720, ScreenMaxFPS: 30}
}

// Matrix é a matriz inteira, no formato do golden packages/shared/fixtures/plans.json.
type Matrix struct {
	Tiers  []Tier          `json:"tiers"`
	Limits map[Tier]Limits `json:"limits"`
}

// Table monta a matriz de todos os planos.
func Table() Matrix {
	m := Matrix{Tiers: append([]Tier(nil), Tiers...), Limits: map[Tier]Limits{}}
	for _, t := range Tiers {
		m.Limits[t] = For(t)
	}
	return m
}

// Entitlement é uma concessão de plano pago (a linha da tabela entitlements, sem o que o cálculo não usa).
type Entitlement struct {
	Tier      Tier
	Source    string     // admin, code ou payment
	ExpiresAt *time.Time // nulo = permanente
	RevokedAt *time.Time
}

// Active diz se a concessão vale em now: não revogada e não vencida.
func (e Entitlement) Active(now time.Time) bool {
	if e.RevokedAt != nil {
		return false
	}
	return e.ExpiresAt == nil || e.ExpiresAt.After(now)
}

// Current devolve a concessão que define o plano em now: a de maior plano entre as ativas; no empate, a
// permanente, e depois a que vence mais tarde. ok=false quando não há concessão ativa (plano grátis).
func Current(es []Entitlement, now time.Time) (best Entitlement, ok bool) {
	for _, e := range es {
		if !e.Active(now) || !e.Tier.Paid() {
			continue
		}
		if !ok || beats(e, best) {
			best, ok = e, true
		}
	}
	return best, ok
}

func beats(a, b Entitlement) bool {
	if a.Tier.Rank() != b.Tier.Rank() {
		return a.Tier.Rank() > b.Tier.Rank()
	}
	switch {
	case b.ExpiresAt == nil:
		return false
	case a.ExpiresAt == nil:
		return true
	}
	return a.ExpiresAt.After(*b.ExpiresAt)
}

// Effective é o plano efetivo: o maior entre as concessões não revogadas e não vencidas (grátis se não houver).
func Effective(es []Entitlement, now time.Time) Tier {
	if e, ok := Current(es, now); ok {
		return e.Tier
	}
	return Free
}

// Omit devolve "" para o plano grátis e o próprio texto para os demais. Os payloads públicos usam `plan` com
// omitempty (ausente = free), então o grátis, que é o comum, não ocupa bytes.
func Omit(tier string) string {
	if tier == string(Free) {
		return ""
	}
	return tier
}
