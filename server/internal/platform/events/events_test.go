package events

import (
	"sync"
	"testing"
	"time"
)

func TestBusDeliversToAllSubscribersInOrder(t *testing.T) {
	b := NewBus(16)
	var mu sync.Mutex
	got := map[string][]string{}
	var wg sync.WaitGroup
	wg.Add(6)
	for _, name := range []string{"a", "b"} {
		cancel := b.Subscribe(func(e Event) {
			mu.Lock()
			got[name] = append(got[name], e.Type)
			mu.Unlock()
			wg.Done()
		})
		defer cancel()
	}
	for _, typ := range []string{"X", "Y", "Z"} {
		b.Publish(Event{Type: typ})
	}
	wg.Wait()
	for _, name := range []string{"a", "b"} {
		if len(got[name]) != 3 || got[name][0] != "X" || got[name][2] != "Z" {
			t.Fatalf("%s recebeu %v", name, got[name])
		}
	}
}

func TestPublishDoesNotBlockOnSlowSubscriber(t *testing.T) {
	b := NewBus(2)
	release := make(chan struct{})
	cancel := b.Subscribe(func(Event) { <-release })

	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			b.Publish(Event{Type: "X"})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish bloqueou com assinante lento")
	}
	close(release)
	cancel()
}

func TestCancelStopsDelivery(t *testing.T) {
	b := NewBus(4)
	var n int
	var mu sync.Mutex
	cancel := b.Subscribe(func(Event) { mu.Lock(); n++; mu.Unlock() })
	cancel()
	cancel() // idempotente
	b.Publish(Event{Type: "X"})
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if n != 0 {
		t.Fatalf("recebeu %d eventos após cancelar", n)
	}
}

func TestBusStampsPublishTime(t *testing.T) {
	b := NewBus(4)
	got := make(chan Event, 2)
	cancel := b.Subscribe(func(e Event) { got <- e })
	defer cancel()
	before := time.Now()
	b.Publish(Event{Type: "X"})
	fixed := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	b.Publish(Event{Type: "Y", At: fixed})
	if e := <-got; e.At.Before(before) {
		t.Fatalf("At = %v, esperado >= %v", e.At, before)
	}
	if e := <-got; !e.At.Equal(fixed) {
		t.Fatalf("At preenchido pelo publicador deve ser mantido: %v", e.At)
	}
}
