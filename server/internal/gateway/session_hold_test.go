package gateway

import (
	"encoding/json"
	"testing"
	"time"
)

// Eventos que chegam antes do READY ficam retidos e saem depois dele, na ordem; o READY é sempre s=1.
func TestPushReadyReleasesHeldEventsAfterReady(t *testing.T) {
	h := &Hub{cfg: Config{BufferSize: 16, ResumeWindow: time.Minute, SendQueue: 16}}
	s := newSession("sid", 1, h)

	s.push("MESSAGE_CREATE", json.RawMessage(`"a"`), time.Now())
	s.push("MESSAGE_CREATE", json.RawMessage(`"b"`), time.Now())
	if s.seq != 0 {
		t.Fatalf("nada pode ser numerado antes do READY (seq=%d)", s.seq)
	}

	s.pushReady(json.RawMessage(`{"session_id":"sid"}`), time.Now())
	s.push("MESSAGE_CREATE", json.RawMessage(`"c"`), time.Now()) // depois do READY, segue o fluxo normal

	evs, ok := s.buf.since(0, s.seq)
	if !ok || s.seq != 4 || len(evs) != 4 {
		t.Fatalf("esperava 4 eventos numerados 1..4, veio %d (seq %d, ok=%v)", len(evs), s.seq, ok)
	}
	wantT := []string{EventReady, "MESSAGE_CREATE", "MESSAGE_CREATE", "MESSAGE_CREATE"}
	wantD := []string{`{"session_id":"sid"}`, `"a"`, `"b"`, `"c"`}
	for i, e := range evs {
		if e.Seq != int64(i+1) || e.T != wantT[i] || string(e.D) != wantD[i] {
			t.Fatalf("evento %d = {%d %s %s}, esperado {%d %s %s}", i, e.Seq, e.T, e.D, i+1, wantT[i], wantD[i])
		}
	}
}
