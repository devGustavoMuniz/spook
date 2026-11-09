package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
)

const secret = "segredo-de-teste"

// ---- MP falso (httptest) ----

type fakeMP struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	payments map[int64]MPPayment
	prefs    []map[string]any
	idem     []string
	auth     []string
}

func newFakeMP(t *testing.T) *fakeMP {
	f := &fakeMP{t: t, payments: map[int64]MPPayment{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/checkout/preferences", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.prefs = append(f.prefs, body)
		f.idem = append(f.idem, r.Header.Get("X-Idempotency-Key"))
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "pref-1", "init_point": "https://mp.test/pay/pref-1"})
	})
	mux.HandleFunc("/v1/payments/", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/v1/payments/"), 10, 64)
		f.mu.Lock()
		p, ok := f.payments[id]
		f.mu.Unlock()
		if !ok {
			http.Error(w, `{"message":"not found"}`, http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": p.ID, "status": p.Status, "external_reference": p.ExternalReference, "transaction_amount": p.Amount, "currency_id": p.Currency,
		})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMP) set(p MPPayment) { f.mu.Lock(); f.payments[p.ID] = p; f.mu.Unlock() }

// ---- armazenamento e planos falsos ----

type memStore struct {
	mu       sync.Mutex
	orders   map[int64]*Order
	payments map[int64]*memPay
}
type memPay struct {
	ent      int64
	refunded bool
	order    int64
}

func newMemStore() *memStore {
	return &memStore{orders: map[int64]*Order{}, payments: map[int64]*memPay{}}
}

func (m *memStore) CreateOrder(_ context.Context, o Order) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.orders[o.ID] = &o
	return nil
}
func (m *memStore) SetPreference(context.Context, int64, string) error { return nil }
func (m *memStore) Order(_ context.Context, id int64) (Order, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.orders[id]
	if !ok {
		return Order{}, ErrOrderNotFound
	}
	return *o, nil
}
func (m *memStore) Approve(_ context.Context, orderID, mp int64, _ string, _ time.Time, grant func(Order) (int64, error)) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.orders[orderID]
	if !ok {
		return false, ErrOrderNotFound
	}
	if _, dup := m.payments[mp]; dup || o.Status != "pending" {
		return false, nil
	}
	id, err := grant(*o)
	if err != nil {
		return false, err
	}
	m.payments[mp] = &memPay{ent: id, order: orderID}
	o.Status = "paid"
	return true, nil
}
func (m *memStore) Refund(_ context.Context, mp int64, _ string, revoke func(int64) error) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.payments[mp]
	if !ok || p.refunded {
		return false, nil
	}
	if err := revoke(p.ent); err != nil {
		return false, err
	}
	p.refunded = true
	m.orders[p.order].Status = "refunded"
	return true, nil
}

type fakePlans struct {
	grants  []Order
	revoked []int64
	fail    error
}

func (f *fakePlans) GrantPayment(_ context.Context, uid int64, tier plan.Tier, days int) (int64, error) {
	if f.fail != nil {
		return 0, f.fail
	}
	f.grants = append(f.grants, Order{UserID: uid, Tier: tier, Days: days})
	return int64(len(f.grants)) * 100, nil
}
func (f *fakePlans) RevokePayment(_ context.Context, id int64) error {
	f.revoked = append(f.revoked, id)
	return nil
}

type seq struct{ n int64 }

func (s *seq) Next() int64 { s.n++; return s.n }

type env struct {
	mp    *fakeMP
	store *memStore
	plans *fakePlans
	svc   *Service
}

func newEnv(t *testing.T, enabled bool) *env {
	mp := newFakeMP(t)
	e := &env{mp: mp, store: newMemStore(), plans: &fakePlans{}}
	cfg := Config{Enabled: enabled, PublicURL: "https://spook.test", WebhookSecret: secret, NitroCents: 1490, NitroPlusCents: 2990}
	e.svc = NewService(cfg, e.store, NewMercadoPago("TOKEN-SECRETO", mp.srv.URL), e.plans, &seq{})
	return e
}

func sign(secret, dataID, reqID, ts string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("id:" + strings.ToLower(dataID) + ";request-id:" + reqID + ";ts:" + ts + ";"))
	return "ts=" + ts + ",v1=" + hex.EncodeToString(m.Sum(nil))
}

func notif(dataID string) Notification {
	return Notification{Signature: sign(secret, dataID, "req-1", "1700000000"), RequestID: "req-1", DataID: dataID, Type: "payment"}
}

// checkout abre um checkout do usuário 7 e devolve o ID do pedido.
func (e *env) checkout(t *testing.T, tier plan.Tier) int64 {
	t.Helper()
	if _, err := e.svc.Checkout(context.Background(), 7, tier); err != nil {
		t.Fatal(err)
	}
	var id int64
	for k := range e.store.orders {
		if k > id {
			id = k
		}
	}
	return id
}

func approved(id, order int64, cents int) MPPayment {
	return MPPayment{ID: id, Status: "approved", ExternalReference: strconv.FormatInt(order, 10), Amount: float64(cents) / 100, Currency: "BRL"}
}

func TestDisabledHidesEverything(t *testing.T) {
	e := newEnv(t, false)
	c := e.svc.Config()
	if c.Enabled || len(c.Plans) != 0 {
		t.Fatalf("config desligada = %+v", c)
	}
	if _, err := e.svc.Checkout(context.Background(), 7, plan.Nitro); !errors.Is(err, ErrDisabled) {
		t.Fatalf("checkout desligado = %v", err)
	}
	if err := e.svc.HandleNotification(context.Background(), notif("1")); !errors.Is(err, ErrDisabled) {
		t.Fatalf("webhook desligado = %v", err)
	}
}

func TestConfigPrices(t *testing.T) {
	c := newEnv(t, true).svc.Config()
	if !c.Enabled || c.Currency != "BRL" || len(c.Plans) != 2 || c.Plans[0].PriceCents != 1490 || c.Plans[1].PriceCents != 2990 || c.Plans[0].Days != 30 {
		t.Fatalf("config = %+v", c)
	}
}

func TestCheckoutCreatesPreference(t *testing.T) {
	e := newEnv(t, true)
	out, err := e.svc.Checkout(context.Background(), 7, plan.NitroPlus)
	if err != nil || out.InitPoint != "https://mp.test/pay/pref-1" {
		t.Fatalf("checkout = %+v, %v", out, err)
	}
	p := e.mp.prefs[0]
	item := p["items"].([]any)[0].(map[string]any)
	if item["unit_price"].(float64) != 29.90 || item["currency_id"] != "BRL" || item["quantity"].(float64) != 1 {
		t.Fatalf("item = %v", item)
	}
	ref := p["external_reference"].(string)
	if _, ok := e.store.orders[mustID(t, ref)]; !ok {
		t.Fatalf("pedido %s não gravado", ref)
	}
	if p["notification_url"] != "https://spook.test/api/billing/webhook" || p["auto_return"] != "approved" {
		t.Fatalf("preferência = %v", p)
	}
	b := p["back_urls"].(map[string]any)
	if b["success"] != "https://spook.test/settings/nitro?payment=success" || b["failure"] != "https://spook.test/settings/nitro?payment=failure" || b["pending"] != "https://spook.test/settings/nitro?payment=pending" {
		t.Fatalf("back_urls = %v", b)
	}
	if e.mp.auth[0] != "Bearer TOKEN-SECRETO" || e.mp.idem[0] != "spook-order-"+ref {
		t.Fatalf("cabeçalhos = %v %v", e.mp.auth, e.mp.idem)
	}
	if _, err := e.svc.Checkout(context.Background(), 7, plan.Free); !errors.Is(err, ErrInvalidTier) {
		t.Fatalf("free = %v", err)
	}
}

func TestCheckoutGatewayFailureDoesNotLeakToken(t *testing.T) {
	e := newEnv(t, true)
	e.mp.srv.Close()
	_, err := e.svc.Checkout(context.Background(), 7, plan.Nitro)
	if !errors.Is(err, ErrGateway) || strings.Contains(err.Error(), "TOKEN-SECRETO") {
		t.Fatalf("erro = %v", err)
	}
}

func mustID(t *testing.T, s string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestApprovedGrantsOnceAndIsIdempotent(t *testing.T) {
	e := newEnv(t, true)
	o := e.checkout(t, plan.Nitro)
	e.mp.set(approved(555, o, 1490))
	for i := 0; i < 3; i++ { // reentregas
		if err := e.svc.HandleNotification(context.Background(), notif("555")); err != nil {
			t.Fatal(err)
		}
	}
	if len(e.plans.grants) != 1 || e.plans.grants[0].UserID != 7 || e.plans.grants[0].Tier != plan.Nitro || e.plans.grants[0].Days != 30 {
		t.Fatalf("concessões = %+v", e.plans.grants)
	}
}

func TestNotApprovedDoesNotGrant(t *testing.T) {
	for _, st := range []string{"pending", "in_process", "rejected", "cancelled", "authorized"} {
		e := newEnv(t, true)
		o := e.checkout(t, plan.Nitro)
		p := approved(1, o, 1490)
		p.Status = st
		e.mp.set(p)
		if err := e.svc.HandleNotification(context.Background(), notif("1")); err != nil || len(e.plans.grants) != 0 {
			t.Fatalf("%s: err=%v grants=%v", st, err, e.plans.grants)
		}
	}
}

func TestAmountOrCurrencyMismatchDoesNotGrant(t *testing.T) {
	e := newEnv(t, true)
	o := e.checkout(t, plan.NitroPlus)
	cheap := approved(1, o, 1490) // pagou o valor do Nitro num pedido de Nitro+
	e.mp.set(cheap)
	usd := approved(2, o, 2990)
	usd.Currency = "USD"
	e.mp.set(usd)
	for _, id := range []string{"1", "2"} {
		if err := e.svc.HandleNotification(context.Background(), notif(id)); err != nil {
			t.Fatal(err)
		}
	}
	if len(e.plans.grants) != 0 || e.store.orders[o].Status != "pending" {
		t.Fatalf("grants=%v status=%s", e.plans.grants, e.store.orders[o].Status)
	}
}

func TestInvalidOrMissingSignature(t *testing.T) {
	e := newEnv(t, true)
	o := e.checkout(t, plan.Nitro)
	e.mp.set(approved(9, o, 1490))
	good := notif("9")
	bad := []Notification{
		{DataID: "9", Type: "payment", RequestID: "req-1"}, // sem assinatura
		{Signature: sign("outra-chave", "9", "req-1", "1700000000"), RequestID: "req-1", DataID: "9", Type: "payment"},
		{Signature: good.Signature, RequestID: "req-2", DataID: "9", Type: "payment"},                  // request-id trocado
		{Signature: good.Signature, RequestID: "req-1", DataID: "10", Type: "payment"},                 // id trocado
		{Signature: "ts=1700000000,v1=zzzz", RequestID: "req-1", DataID: "9", Type: "payment"},         // hex inválido
		{Signature: "v1=" + strings.Repeat("a", 64), RequestID: "req-1", DataID: "9", Type: "payment"}, // sem ts
	}
	for i, n := range bad {
		if err := e.svc.HandleNotification(context.Background(), n); !errors.Is(err, ErrInvalidSignature) {
			t.Fatalf("caso %d = %v", i, err)
		}
	}
	if len(e.plans.grants) != 0 {
		t.Fatal("concedeu com assinatura inválida")
	}
	// A mesma entrega, assinada de verdade, passa (id em maiúsculas é normalizado).
	if err := e.svc.HandleNotification(context.Background(), good); err != nil || len(e.plans.grants) != 1 {
		t.Fatalf("válida: %v %v", err, e.plans.grants)
	}
}

func TestUnknownOrderAndOtherTopicsAreIgnored(t *testing.T) {
	e := newEnv(t, true)
	e.mp.set(approved(1, 424242, 1490)) // referência a um pedido que não existe
	e.mp.set(MPPayment{ID: 2, Status: "approved", ExternalReference: "lixo", Amount: 14.9, Currency: "BRL"})
	for _, id := range []string{"1", "2", "999"} { // 999: o MP devolve 404
		if err := e.svc.HandleNotification(context.Background(), notif(id)); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
	n := notif("1")
	n.Type = "merchant_order"
	if err := e.svc.HandleNotification(context.Background(), n); err != nil || len(e.plans.grants) != 0 {
		t.Fatalf("tópico: %v", err)
	}
}

func TestGrantFailureLetsMPRetry(t *testing.T) {
	e := newEnv(t, true)
	o := e.checkout(t, plan.Nitro)
	e.mp.set(approved(5, o, 1490))
	e.plans.fail = errors.New("banco fora")
	if err := e.svc.HandleNotification(context.Background(), notif("5")); err == nil {
		t.Fatal("deveria falhar (500 para o MP reenviar)")
	}
	e.plans.fail = nil
	if err := e.svc.HandleNotification(context.Background(), notif("5")); err != nil || len(e.plans.grants) != 1 {
		t.Fatalf("reenvio: %v %v", err, e.plans.grants)
	}
}

func TestRefundRevokesOnce(t *testing.T) {
	for _, st := range []string{"refunded", "charged_back"} {
		e := newEnv(t, true)
		o := e.checkout(t, plan.Nitro)
		e.mp.set(approved(5, o, 1490))
		if err := e.svc.HandleNotification(context.Background(), notif("5")); err != nil {
			t.Fatal(err)
		}
		p := approved(5, o, 1490)
		p.Status = st
		e.mp.set(p)
		for i := 0; i < 2; i++ {
			if err := e.svc.HandleNotification(context.Background(), notif("5")); err != nil {
				t.Fatal(err)
			}
		}
		if len(e.plans.revoked) != 1 || e.plans.revoked[0] != 100 || e.store.orders[o].Status != "refunded" {
			t.Fatalf("%s: revoked=%v status=%s", st, e.plans.revoked, e.store.orders[o].Status)
		}
	}
}

func TestRefundOfUnknownPaymentIsIgnored(t *testing.T) {
	e := newEnv(t, true)
	o := e.checkout(t, plan.Nitro)
	p := approved(8, o, 1490)
	p.Status = "refunded"
	e.mp.set(p)
	if err := e.svc.HandleNotification(context.Background(), notif("8")); err != nil || len(e.plans.revoked) != 0 {
		t.Fatalf("%v %v", err, e.plans.revoked)
	}
}

func TestGrantGoesToOrderOwnerOnly(t *testing.T) {
	e := newEnv(t, true)
	oA := e.checkout(t, plan.Nitro) // usuário 7
	if _, err := e.svc.Checkout(context.Background(), 8, plan.Nitro); err != nil {
		t.Fatal(err)
	}
	e.mp.set(approved(1, oA, 1490))
	if err := e.svc.HandleNotification(context.Background(), notif("1")); err != nil {
		t.Fatal(err)
	}
	if len(e.plans.grants) != 1 || e.plans.grants[0].UserID != 7 {
		t.Fatalf("concessões = %+v", e.plans.grants)
	}
}

func TestSignatureVerifyWithoutRequestID(t *testing.T) {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("id:abc;ts:5;"))
	sig := "ts=5, v1=" + hex.EncodeToString(m.Sum(nil))
	if !VerifySignature(secret, Notification{Signature: sig, DataID: "ABC"}) {
		t.Fatal("manifest sem request-id deveria validar")
	}
	if VerifySignature("", Notification{Signature: sig, DataID: "ABC"}) {
		t.Fatal("sem chave nunca valida")
	}
}

func TestWebhookHandlerStatusCodes(t *testing.T) {
	e := newEnv(t, true)
	o := e.checkout(t, plan.Nitro)
	e.mp.set(approved(77, o, 1490))
	h := NewHandler(e.svc, nil).WebhookHandler()
	call := func(sig, rid, query, body string) int {
		r := httptest.NewRequest(http.MethodPost, "/api/billing/webhook?"+query, strings.NewReader(body))
		if sig != "" {
			r.Header.Set("x-signature", sig)
		}
		r.Header.Set("x-request-id", rid)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if c := call("", "req-1", "data.id=77&type=payment", `{"type":"payment"}`); c != http.StatusUnauthorized {
		t.Fatalf("sem assinatura = %d", c)
	}
	if len(e.plans.grants) != 0 {
		t.Fatal("concedeu sem assinatura")
	}
	if c := call(sign(secret, "77", "req-1", "1"), "req-1", "data.id=77", `{"type":"payment","data":{"id":"77"}}`); c != http.StatusOK || len(e.plans.grants) != 1 {
		t.Fatalf("tipo vindo do corpo = %d %v", c, e.plans.grants)
	}
	if c := call(sign(secret, "77", "req-1", "1"), "req-1", "data.id=77&type=payment", strings.Repeat("x", MaxWebhookBody+1)); c != http.StatusRequestEntityTooLarge {
		t.Fatalf("corpo grande = %d", c)
	}
	e.mp.srv.Close() // o MP caiu: 500 para ele reenviar
	if c := call(sign(secret, "78", "req-1", "1"), "req-1", "data.id=78&type=payment", ""); c != http.StatusInternalServerError {
		t.Fatalf("MP fora = %d", c)
	}
}
