package gateway

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func ev(seq int64, at time.Time) event {
	return event{Seq: seq, T: "X", D: json.RawMessage(`{}`), At: at}
}

func seqs(es []event) []int64 {
	out := make([]int64, len(es))
	for i, e := range es {
		out[i] = e.Seq
	}
	return out
}

func eq(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestRingLimitByCount(t *testing.T) {
	now := time.Now()
	r := newRing(3, time.Minute)
	for i := int64(1); i <= 5; i++ {
		r.push(ev(i, now), now)
	}
	if r.len() != 3 {
		t.Fatalf("len = %d, esperado 3", r.len())
	}
	got, ok := r.since(2, 5)
	if !ok || !eq(seqs(got), []int64{3, 4, 5}) {
		t.Fatalf("since(2) = %v ok=%v", seqs(got), ok)
	}
	if _, ok := r.since(1, 5); ok {
		t.Fatal("since(1) não pode ser coberto: o evento 2 foi descartado")
	}
}

func TestRingLimitByAge(t *testing.T) {
	t0 := time.Now()
	r := newRing(100, 60*time.Second)
	r.push(ev(1, t0), t0)
	r.push(ev(2, t0.Add(30*time.Second)), t0.Add(30*time.Second))
	r.push(ev(3, t0.Add(70*time.Second)), t0.Add(70*time.Second))
	if r.len() != 2 {
		t.Fatalf("len = %d, esperado 2 (o evento 1 passou de 60 s)", r.len())
	}
	if _, ok := r.since(0, 3); ok {
		t.Fatal("since(0) não pode ser coberto")
	}
	if got, ok := r.since(1, 3); !ok || !eq(seqs(got), []int64{2, 3}) {
		t.Fatalf("since(1) = %v ok=%v", seqs(got), ok)
	}
	r.trim(t0.Add(200 * time.Second)) // tudo velho
	if r.len() != 0 {
		t.Fatalf("len = %d, esperado 0", r.len())
	}
	if got, ok := r.since(3, 3); !ok || len(got) != 0 {
		t.Fatal("cliente em dia deve ser coberto mesmo com buffer vazio")
	}
	if _, ok := r.since(2, 3); ok {
		t.Fatal("buffer vazio não cobre um cliente atrasado")
	}
}

func TestRingSinceEdges(t *testing.T) {
	now := time.Now()
	r := newRing(10, time.Minute)
	if got, ok := r.since(0, 0); !ok || len(got) != 0 {
		t.Fatal("sessão sem eventos: since(0,0) deve ser vazio e ok")
	}
	for i := int64(1); i <= 3; i++ {
		r.push(ev(i, now), now)
	}
	if got, ok := r.since(0, 3); !ok || !eq(seqs(got), []int64{1, 2, 3}) {
		t.Fatalf("since(0) = %v ok=%v", seqs(got), ok)
	}
	if got, ok := r.since(3, 3); !ok || len(got) != 0 {
		t.Fatal("since(3) = nada, ok")
	}
	if _, ok := r.since(4, 3); ok {
		t.Fatal("seq à frente do servidor é inválido")
	}
	if _, ok := r.since(-1, 3); ok {
		t.Fatal("seq negativo é inválido")
	}
}

func TestRingCompactsMemory(t *testing.T) {
	now := time.Now()
	r := newRing(4, time.Minute)
	for i := int64(1); i <= 10_000; i++ {
		r.push(ev(i, now), now)
	}
	if cap(r.buf) > 200 {
		t.Fatalf("cap = %d: o buffer deveria ser compactado", cap(r.buf))
	}
	got, ok := r.since(9_996, 10_000)
	if !ok || !eq(seqs(got), []int64{9_997, 9_998, 9_999, 10_000}) {
		t.Fatalf("since = %v ok=%v", seqs(got), ok)
	}
}

func TestAppendDispatchIsValidJSON(t *testing.T) {
	b := appendDispatch(nil, event{Seq: 7, T: "MESSAGE_CREATE", D: json.RawMessage(`{"id":"1","content":"olá \"mundo\""}`)})
	var f Frame
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatalf("frame inválido: %v: %s", err, b)
	}
	if f.Op != OpDispatch || f.T == nil || *f.T != "MESSAGE_CREATE" || f.S == nil || *f.S != 7 {
		t.Fatalf("frame = %s", b)
	}
	if !strings.Contains(string(f.D), "mundo") {
		t.Fatalf("d = %s", f.D)
	}
}

func TestTicketsSingleUseAndExpiry(t *testing.T) {
	now := time.Now()
	tk := newTickets(30 * time.Second)
	tk.now = func() time.Time { return now }

	a, ok := tk.issue(42)
	if !ok || a == "" {
		t.Fatal("issue falhou")
	}
	b, _ := tk.issue(43)
	if a == b {
		t.Fatal("tickets repetidos")
	}
	if id, ok := tk.consume(a); !ok || id != 42 {
		t.Fatalf("consume = %d %v", id, ok)
	}
	if _, ok := tk.consume(a); ok {
		t.Fatal("o ticket é de uso único")
	}
	now = now.Add(31 * time.Second)
	if _, ok := tk.consume(b); ok {
		t.Fatal("ticket expirado não vale")
	}
	if _, ok := tk.consume("inexistente"); ok {
		t.Fatal("ticket inexistente não vale")
	}

	c, _ := tk.issue(1)
	now = now.Add(time.Minute)
	tk.purge()
	if tk.size() != 0 {
		t.Fatalf("purge deixou %d tickets", tk.size())
	}
	_ = c
}

func TestConfigDefaults(t *testing.T) {
	c := Config{}.withDefaults()
	if c.HeartbeatInterval != 41*time.Second || c.heartbeatTimeout() != 61500*time.Millisecond {
		t.Fatalf("heartbeat = %v / %v", c.HeartbeatInterval, c.heartbeatTimeout())
	}
	if c.ResumeWindow != 60*time.Second || c.OpsPerMinute != 120 || c.SendQueue > c.BufferSize {
		t.Fatalf("defaults = %+v", c)
	}
}
