package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

// Estourar qualquer limite responde 429 com Retry-After. Nunca 503: um 503 sem Server-Timing não vem do backend.
func TestEveryRateLimiterAnswers429NotServiceUnavailable(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := limitByPath("", ratelimit.New(0.001, 1), ratelimit.New(0.001, 1), ratelimit.New(0.001, 1))(ok)

	for i, path := range []string{"/api/auth/login", "/api/guilds", "/api/gateway", "/api/channels/1/typing"} {
		do := func() *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, path, nil)
			req.RemoteAddr = fmt.Sprintf("203.0.113.%d:1234", i+1) // um IP por caminho: /api/* compartilha o limitador
			h.ServeHTTP(rec, req)
			return rec
		}
		if first := do(); first.Code != http.StatusNoContent {
			t.Fatalf("%s: a primeira requisição deveria passar, veio %d", path, first.Code)
		}
		over := do()
		if over.Code != http.StatusTooManyRequests {
			t.Fatalf("%s: excesso deveria dar 429, deu %d", path, over.Code)
		}
		if over.Header().Get("Retry-After") == "" {
			t.Fatalf("%s: 429 sem Retry-After", path)
		}
	}
}

type testUserKey struct{}

// Cada limite por ação (actionRules) responde 429 com Retry-After ao estourar, por usuário, e a métrica/OpenAPI
// conhecem o nome. Um usuário esgotado não afeta outro.
func TestActionRateLimitersAnswer429WithRetryAfter(t *testing.T) {
	r := chi.NewRouter()
	api := humachi.New(r, huma.DefaultConfig("t", "0"))
	byOp, _ := (&namedLimiters{}).actionLimiters(nil)
	asUser := func(ctx huma.Context, next func(huma.Context)) {
		id, _ := strconv.ParseInt(ctx.Header("X-Test-User"), 10, 64)
		next(huma.WithValue(ctx, testUserKey{}, id))
	}
	mw := huma.Middlewares{asUser, actionLimits(api, byOp, func(ctx context.Context) int64 { id, _ := ctx.Value(testUserKey{}).(int64); return id })}
	for _, rule := range actionRules {
		for _, op := range rule.Ops {
			huma.Register(api, huma.Operation{OperationID: op, Method: http.MethodPost, Path: "/t/" + op, Middlewares: mw, DefaultStatus: http.StatusNoContent},
				func(context.Context, *struct{}) (*struct{}, error) { return nil, nil })
		}
	}
	do := func(op string, user int) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/t/"+op, nil)
		req.Header.Set("X-Test-User", strconv.Itoa(user))
		r.ServeHTTP(rec, req)
		return rec
	}
	for _, rule := range actionRules {
		op := rule.Ops[0]
		for i := 0; i < rule.Burst; i++ {
			if rec := do(op, 1); rec.Code != http.StatusNoContent {
				t.Fatalf("%s (%s): a requisição %d deveria passar, veio %d", rule.Name, op, i+1, rec.Code)
			}
		}
		over := do(op, 1)
		if over.Code != http.StatusTooManyRequests {
			t.Fatalf("%s: o excesso deveria dar 429, deu %d", rule.Name, over.Code)
		}
		if ra, err := strconv.Atoi(over.Header().Get("Retry-After")); err != nil || ra < 1 {
			t.Fatalf("%s: 429 sem Retry-After válido (%q)", rule.Name, over.Header().Get("Retry-After"))
		}
		if rec := do(op, 2); rec.Code != http.StatusNoContent {
			t.Fatalf("%s: outro usuário não pode ser afetado (veio %d)", rule.Name, rec.Code)
		}
		if byOp[op].Name() != rule.Name {
			t.Fatalf("%s: o limitador deveria se chamar %q, é %q", op, rule.Name, byOp[op].Name())
		}
	}
}

// Toda operação citada numa regra existe no contrato (erro de digitação deixaria a ação sem limite) e o
// contrato anuncia o 429 dela.
func TestActionRulesMatchOpenAPI(t *testing.T) {
	ops := map[string]*huma.Operation{}
	for _, item := range buildOpenAPI().Paths {
		for _, op := range []*huma.Operation{item.Get, item.Put, item.Post, item.Delete, item.Patch} {
			if op != nil {
				ops[op.OperationID] = op
			}
		}
	}
	seen := map[string]bool{}
	for _, rule := range actionRules {
		if seen[rule.Name] {
			t.Fatalf("nome de limite repetido: %s", rule.Name)
		}
		seen[rule.Name] = true
		for _, id := range rule.Ops {
			op := ops[id]
			if op == nil {
				t.Fatalf("regra %s cita a operação %q, que não existe no OpenAPI", rule.Name, id)
			}
			if op.Responses["429"] == nil {
				t.Errorf("operação %s (%s) não documenta o 429", id, rule.Name)
			}
		}
	}
}

func TestNamedLimiterOverrideFromEnv(t *testing.T) {
	n := namedLimiters{overrides: map[string]int{"servers_create": 1}}
	l := n.get("servers.create", nil, 2, 5)
	if ok, _ := l.Take("u"); !ok {
		t.Fatal("a primeira passa")
	}
	if ok, _ := l.Take("u"); ok {
		t.Fatal("RATELIMIT_SERVERS_CREATE_PER_MIN=1 limita a rajada a 1")
	}
	if l.Name() != "servers.create" {
		t.Fatalf("nome = %q", l.Name())
	}
}
