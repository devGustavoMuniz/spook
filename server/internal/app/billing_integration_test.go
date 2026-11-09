//go:build integration

package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/billing"
	"github.com/devGustavoMuniz/spook/server/internal/platform/config"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

const billingSecret = "segredo-do-teste"

// fakeMPServer é um Mercado Pago falso: aceita preferências e devolve os pagamentos que o teste cadastra.
type fakeMPServer struct {
	srv      *httptest.Server
	mu       sync.Mutex
	payments map[int64]map[string]any
	lastRef  string
}

func newFakeMPServer(t *testing.T) *fakeMPServer {
	f := &fakeMPServer{payments: map[int64]map[string]any{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/checkout/preferences", func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.mu.Lock()
		f.lastRef = b["external_reference"].(string)
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "pref-" + f.lastRef, "init_point": "https://mp.test/pay/" + f.lastRef})
	})
	mux.HandleFunc("/v1/payments/", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/v1/payments/"), 10, 64)
		f.mu.Lock()
		p, ok := f.payments[id]
		f.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(p)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMPServer) pay(id int64, status, ref string, amount float64) {
	f.mu.Lock()
	f.payments[id] = map[string]any{"id": id, "status": status, "external_reference": ref, "transaction_amount": amount, "currency_id": "BRL"}
	f.mu.Unlock()
}

func (f *fakeMPServer) ref() string { f.mu.Lock(); defer f.mu.Unlock(); return f.lastRef }

func (e *testEnv) webhook(t *testing.T, id int64, signed bool, want int) {
	t.Helper()
	sid := strconv.FormatInt(id, 10)
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/api/billing/webhook?data.id="+sid+"&type=payment", strings.NewReader(`{"type":"payment","data":{"id":"`+sid+`"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-request-id", "req-"+sid)
	if signed {
		m := hmac.New(sha256.New, []byte(billingSecret))
		m.Write([]byte("id:" + sid + ";request-id:req-" + sid + ";ts:1700000000;"))
		req.Header.Set("x-signature", "ts=1700000000,v1="+hex.EncodeToString(m.Sum(nil)))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != want {
		t.Fatalf("webhook %d = %d, esperado %d", id, resp.StatusCode, want)
	}
}

func billingEnv(t *testing.T, mp *fakeMPServer) *testEnv {
	return newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.AuthLimiter = ratelimit.New(100000, 100000)
		d.Cfg.PublicURL = "https://spook.test"
		d.Cfg.Billing = config.Billing{AccessToken: "TEST-token", WebhookSecret: billingSecret, NitroCents: 1490, NitroPlusCents: 2990}
		d.BillingGateway = billing.NewMercadoPago("TEST-token", mp.srv.URL)
	})
}

func TestBillingDisabledIsInvisible(t *testing.T) {
	e := nitroEnv(t) // sem credenciais
	u := e.newActor(t, "semmp")
	resp, b := e.do(t, "GET", "/api/billing/config", nil, nil)
	status(t, resp, b, 200)
	if c := obj(t, b); c["enabled"] != false {
		t.Fatalf("config = %v", c)
	}
	resp, b = e.do(t, "POST", "/api/billing/checkout", J{"tier": "nitro"}, nil)
	status(t, resp, b, 401)
	u.call(t, "POST", "/api/billing/checkout", J{"tier": "nitro"}, 503)
	resp, b = e.do(t, "POST", "/api/billing/webhook?data.id=1&type=payment", nil, nil)
	if resp.StatusCode != 404 && resp.StatusCode != 405 {
		t.Fatalf("webhook exposto sem credenciais: %d %s", resp.StatusCode, b)
	}
}

func TestBillingFlow(t *testing.T) {
	mp := newFakeMPServer(t)
	e := billingEnv(t, mp)
	// IDs de pagamento únicos por execução: o banco de teste é compartilhado entre execuções.
	base := time.Now().UnixNano() / 1000
	u, other := e.newActor(t, "pagador"), e.newActor(t, "outro")

	resp, b := e.do(t, "GET", "/api/billing/config", nil, nil)
	status(t, resp, b, 200)
	if c := obj(t, b); c["enabled"] != true || len(list(c, "plans")) != 2 {
		t.Fatalf("config = %v", c)
	}
	u.call(t, "POST", "/api/billing/checkout", J{"tier": "free"}, 422)

	checkout := func(tier string) string {
		out := obj(t, u.call(t, "POST", "/api/billing/checkout", J{"tier": tier}, 200))
		if !strings.HasPrefix(str(out, "init_point"), "https://mp.test/pay/") {
			t.Fatalf("checkout = %v", out)
		}
		return mp.ref()
	}

	// Sem assinatura: 401 e nada muda.
	ref1 := checkout("nitro")
	mp.pay(base+1001, "approved", ref1, 14.90)
	e.webhook(t, base+1001, false, 401)
	if str(u.myPlan(t), "tier") != "free" {
		t.Fatal("concedeu sem assinatura")
	}
	// Pendente e valor errado não concedem.
	mp.pay(base+1002, "pending", ref1, 14.90)
	e.webhook(t, base+1002, true, 200)
	mp.pay(base+1003, "approved", ref1, 1.00)
	e.webhook(t, base+1003, true, 200)
	if str(u.myPlan(t), "tier") != "free" {
		t.Fatal("concedeu pendente ou valor divergente")
	}
	// Aprovado concede (e a reentrega é idempotente).
	e.webhook(t, base+1001, true, 200)
	e.webhook(t, base+1001, true, 200)
	p := u.myPlan(t)
	if str(p, "tier") != "nitro" || str(p, "source") != "payment" {
		t.Fatalf("plano = %v", p)
	}
	first, _ := time.Parse(time.RFC3339, str(p, "expires_at"))
	if d := time.Until(first); d < 29*24*time.Hour || d > 30*24*time.Hour+time.Minute {
		t.Fatalf("validade = %v", first)
	}
	if str(other.myPlan(t), "tier") != "free" {
		t.Fatal("outro usuário ganhou plano")
	}
	// Renovação soma 30 dias.
	ref2 := checkout("nitro")
	mp.pay(base+1004, "approved", ref2, 14.90)
	e.webhook(t, base+1004, true, 200)
	second, _ := time.Parse(time.RFC3339, str(u.myPlan(t), "expires_at"))
	if d := second.Sub(first); d < 29*24*time.Hour || d > 31*24*time.Hour {
		t.Fatalf("renovação somou %v", d)
	}
	// Estorno revoga só aquela concessão; estornar tudo volta ao Grátis.
	mp.pay(base+1004, "refunded", ref2, 14.90)
	e.webhook(t, base+1004, true, 200)
	e.webhook(t, base+1004, true, 200)
	if p := u.myPlan(t); str(p, "tier") != "nitro" {
		t.Fatalf("plano após o 1º estorno = %v", p)
	}
	mp.pay(base+1001, "charged_back", ref1, 14.90)
	e.webhook(t, base+1001, true, 200)
	if str(u.myPlan(t), "tier") != "free" {
		t.Fatal("estorno não revogou")
	}
	// Referência a pedido inexistente e pagamento desconhecido: 200 sem efeito.
	mp.pay(base+1005, "approved", "999999999999", 14.90)
	e.webhook(t, base+1005, true, 200)
	e.webhook(t, base+4242, true, 200)
	if str(other.myPlan(t), "tier") != "free" {
		t.Fatal("pedido inexistente concedeu")
	}
}
