package gateway

import (
	"encoding/json"
	"time"
)

// event é um dispatch já numerado, guardado no buffer da sessão. D é compartilhado entre todas
// as sessões que recebem o mesmo evento (só o cabeçalho é por sessão).
type event struct {
	Seq int64
	T   string
	D   json.RawMessage
	At  time.Time // instante da publicação no barramento (para a métrica de latência)
}

// ring é o buffer circular de eventos de uma sessão, limitado por contagem e por idade.
// Não é seguro para uso concorrente (a sessão o protege com o próprio lock).
type ring struct {
	buf    []event // buf[head:] são os eventos válidos, em ordem de Seq
	head   int
	max    int
	maxAge time.Duration
}

func newRing(max int, maxAge time.Duration) *ring { return &ring{max: max, maxAge: maxAge} }

func (r *ring) len() int { return len(r.buf) - r.head }

// push guarda o evento e descarta o que passou do limite de contagem ou de idade.
func (r *ring) push(e event, now time.Time) {
	r.buf = append(r.buf, e)
	r.trim(now)
}

func (r *ring) trim(now time.Time) {
	for r.len() > r.max {
		r.drop()
	}
	for r.len() > 0 && now.Sub(r.buf[r.head].At) > r.maxAge {
		r.drop()
	}
	// compacta quando o espaço morto passa da metade, para a memória não crescer sem limite
	if r.head > 32 && r.head > len(r.buf)/2 {
		n := copy(r.buf, r.buf[r.head:])
		clear(r.buf[n:])
		r.buf = r.buf[:n]
		r.head = 0
	}
}

func (r *ring) drop() {
	r.buf[r.head] = event{} // libera o payload para o GC
	r.head++
}

// since devolve os eventos com Seq > after. ok é false quando o buffer não cobre o pedido
// (algum evento depois de `after` já foi descartado) ou quando after está à frente de last.
// last é o último Seq emitido pela sessão (mesmo que já tenha saído do buffer).
func (r *ring) since(after, last int64) (out []event, ok bool) {
	if after > last || after < 0 {
		return nil, false
	}
	if after == last {
		return nil, true
	}
	if r.len() == 0 || r.buf[r.head].Seq > after+1 {
		return nil, false
	}
	// Seq é contíguo: o índice sai por aritmética.
	i := r.head + int(after+1-r.buf[r.head].Seq)
	return append([]event(nil), r.buf[i:]...), true
}
