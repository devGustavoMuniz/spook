package app

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

// Limites nomeados por ação (SPEC 7.x, "Inventário de rate limits"). Cada limitador tem um nome estável (a métrica
// spook.ratelimit.blocked{name} usa o mesmo) e, para as ações abaixo, é aplicado por um middleware depois da
// autenticação, por usuário. A resposta ao estouro é sempre 429 com Retry-After.

// actionRule liga uma ação (operationId do OpenAPI) a um limitador nomeado.
type actionRule struct {
	Name   string
	PerMin float64 // taxa sustentada
	Burst  int
	Ops    []string
}

// actionRules são os limites aplicados pelo middleware. Os limitadores criados dentro dos services (mensagens,
// DMs, moderação, amizades, upload...) estão na tabela do SPEC e usam o mesmo mecanismo de nome e substituição.
var actionRules = []actionRule{
	{"servers.create", 2, 5, []string{"createGuild"}},
	{"channels.create", 30, 30, []string{"createChannel"}},
	{"invites.create", 20, 20, []string{"createInvite"}},
	{"roles.manage", 30, 30, []string{"createGuildRole", "updateGuildRole", "deleteGuildRole", "addGuildMemberRole", "removeGuildMemberRole"}},
	{"voice.token", 30, 10, []string{"createVoiceToken"}},
	{"voice.watch", 180, 60, []string{"putScreenWatch", "deleteScreenWatch"}},
	{"profile.update", 20, 10, []string{"updateMe"}},
	{"messages.pin", 30, 15, []string{"pinMessage", "unpinMessage"}},
	// Banir, expulsar, mutar, apelido alheio, overwrites e desconectar da voz já são limitados dentro dos services,
	// no limitador "moderation" (chave "mod:<usuário>"): não entram aqui para não contar duas vezes.
}

// namedLimiters cria limitadores nomeados aplicando as substituições RATELIMIT_<NOME>_PER_MIN.
type namedLimiters struct {
	overrides map[string]int
}

func envKey(name string) string { return strings.ReplaceAll(name, ".", "_") }

// get devolve o limitador `name`: o injetado (testes) ou um novo com a taxa em perMin e a rajada burst. Uma
// substituição por ambiente troca a taxa sustentada e limita a rajada a ela (rajada nunca passa da taxa por minuto).
func (n *namedLimiters) get(name string, given *ratelimit.Limiter, perMin float64, burst int) *ratelimit.Limiter {
	if given != nil {
		return given.Named(name)
	}
	if v, ok := n.overrides[envKey(name)]; ok {
		perMin = float64(v)
		if burst > v {
			burst = v
		}
	}
	return ratelimit.New(perMin/60, burst).Named(name)
}

// actionLimiters monta um limitador por regra e o mapa operationId → limitador. given troca limitadores por nome (testes).
func (n *namedLimiters) actionLimiters(given map[string]*ratelimit.Limiter) (byOp map[string]*ratelimit.Limiter, all []*ratelimit.Limiter) {
	byOp = map[string]*ratelimit.Limiter{}
	for _, r := range actionRules {
		l := n.get(r.Name, given[r.Name], r.PerMin, r.Burst)
		all = append(all, l)
		for _, op := range r.Ops {
			byOp[op] = l
		}
	}
	return byOp, all
}

// warnUnknown avisa no boot de RATELIMIT_*_PER_MIN que não casa com nenhum limitador (erro de digitação).
func (n *namedLimiters) warnUnknown(known []string) {
	set := map[string]bool{}
	for _, k := range known {
		set[envKey(k)] = true
	}
	var bad []string
	for k := range n.overrides {
		if !set[k] {
			bad = append(bad, k)
		}
	}
	if len(bad) > 0 {
		sort.Strings(bad)
		slog.Warn("RATELIMIT_*_PER_MIN sem limitador correspondente (ignorado)", "nomes", bad)
	}
}

// knownLimiterNames lista todos os nomes que aceitam substituição por ambiente.
var knownLimiterNames = []string{
	"messages.send", "dms.open", "moderation", "friends.request", "social.actions", "call.ring", "uploads.request",
	"messages.everyone", "push", "account.password", "account.email", "account.delete", "auth.forgot", "auth.resend",
	"mail.recipient",
}

func allLimiterNames() []string {
	out := append([]string(nil), knownLimiterNames...)
	for _, r := range actionRules {
		out = append(out, r.Name)
	}
	return out
}

// actionLimits é o middleware dos limites por ação: roda DEPOIS da autenticação (o usuário já está no contexto).
func actionLimits(api huma.API, byOp map[string]*ratelimit.Limiter, userID func(context.Context) int64) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		op := ctx.Operation()
		var l *ratelimit.Limiter
		if op != nil {
			l = byOp[op.OperationID]
		}
		uid := userID(ctx.Context())
		if l == nil || uid == 0 {
			next(ctx)
			return
		}
		if ok, wait := l.Take(httpx.ID(uid)); !ok {
			secs := int(math.Ceil(wait.Seconds()))
			if secs < 1 {
				secs = 1
			}
			ctx.SetHeader("Retry-After", strconv.Itoa(secs))
			_ = huma.WriteErr(api, ctx, http.StatusTooManyRequests, "muitas ações seguidas; aguarde um pouco e tente de novo")
			return
		}
		next(ctx)
	}
}

// document429 acrescenta a resposta 429 ao OpenAPI das operações limitadas, copiando o formato do 401.
func document429(api huma.API, byOp map[string]*ratelimit.Limiter) {
	for _, item := range api.OpenAPI().Paths {
		for _, op := range []*huma.Operation{item.Get, item.Put, item.Post, item.Delete, item.Patch} {
			if op == nil || byOp[op.OperationID] == nil || op.Responses == nil || op.Responses["429"] != nil {
				continue
			}
			base := op.Responses["401"]
			if base == nil {
				continue
			}
			c := *base
			c.Description = "Too Many Requests"
			c.Headers = map[string]*huma.Param{"Retry-After": {Description: "Segundos até poder tentar de novo", Schema: &huma.Schema{Type: "integer"}}}
			op.Responses["429"] = &c
		}
	}
}
