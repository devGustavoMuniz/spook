package snowflake

import (
	"sync"
	"testing"
	"time"
)

func TestUniqueAndIncreasing(t *testing.T) {
	g, err := New(1)
	if err != nil {
		t.Fatal(err)
	}
	var last int64
	for range 20000 {
		id := g.Next()
		if id <= last {
			t.Fatalf("id %d não é maior que o anterior %d", id, last)
		}
		last = id
	}
}

func TestConcurrentUnique(t *testing.T) {
	g, _ := New(0)
	var mu sync.Mutex
	seen := map[int64]bool{}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 5000 {
				id := g.Next()
				mu.Lock()
				if seen[id] {
					t.Errorf("id duplicado %d", id)
				}
				seen[id] = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
}

func TestTimeRoundTrip(t *testing.T) {
	g, _ := New(3)
	before := time.Now().Add(-time.Second)
	got := Time(g.Next())
	if got.Before(before) || got.After(time.Now().Add(time.Second)) {
		t.Fatalf("Time() = %v, fora do esperado", got)
	}
}

func TestInvalidNode(t *testing.T) {
	if _, err := New(1024); err == nil {
		t.Fatal("esperava erro para nó 1024")
	}
}
