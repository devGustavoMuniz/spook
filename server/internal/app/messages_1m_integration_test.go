//go:build integration

package app

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"
)

const (
	bulkMessages = 1_000_000
	pageSize     = 100
	// Meta do SPEC (RNF01): listagem paginada < 30 ms no p95. Só é registrada no log; não falha o teste,
	// porque o tempo depende da máquina (o teste roda em CI e no Docker local).
	targetP95 = 30 * time.Millisecond
)

// TestPaginationWithOneMillionMessages prova que a paginação por cursor é consistente com 1M de mensagens
// no canal: sem duplicatas, sem buracos, ordem estrita, has_more correto, mesmo com mensagens novas
// chegando durante a paginação.
func TestPaginationWithOneMillionMessages(t *testing.T) {
	if testing.Short() {
		t.Skip("teste de 1M de mensagens ignorado com -short")
	}
	e := newEnvWith(t, bigLimits)
	owner := e.newActor(t, "milhao")
	g := owner.createGuild(t, "Um milhão")
	channelID, _ := strconv.ParseInt(g.textID, 10, 64)
	authorID, _ := strconv.ParseInt(owner.id, 10, 64)
	guildID, _ := strconv.ParseInt(g.id, 10, 64)

	t.Cleanup(func() { // apagar o servidor leva canal e mensagens junto (ON DELETE CASCADE)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		start := time.Now()
		if _, err := e.pool.Exec(ctx, `DELETE FROM messages WHERE channel_id = $1`, channelID); err != nil {
			t.Errorf("limpar mensagens: %v", err)
		}
		if _, err := e.pool.Exec(ctx, `DELETE FROM guilds WHERE id = $1`, guildID); err != nil {
			t.Errorf("limpar servidor: %v", err)
		}
		t.Logf("limpeza: %v", time.Since(start).Round(time.Millisecond))
	})

	// IDs crescentes e menores que qualquer ID gerado a partir de agora (o ID do canal é de alguns ms atrás
	// e 1 ms de Snowflake reserva 4.194.304 IDs).
	base := channelID
	start := time.Now()
	ctx := context.Background()
	if _, err := e.pool.Exec(ctx, `
		INSERT INTO messages (id, channel_id, author_id, content)
		SELECT $1::bigint + g, $2, $3, 'mensagem ' || g FROM generate_series(1, $4::int) AS g`,
		base, channelID, authorID, bulkMessages); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `UPDATE channels SET last_message_id = $2 WHERE id = $1`, channelID, base+bulkMessages); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `ANALYZE messages`); err != nil {
		t.Fatal(err)
	}
	t.Logf("inserção de %d mensagens: %v", bulkMessages, time.Since(start).Round(time.Millisecond))

	// Mensagens novas chegando durante a paginação (pela API, com IDs maiores que os do lote).
	stop := make(chan struct{})
	var wg sync.WaitGroup
	var injected []int64
	var injMu sync.Mutex
	wg.Add(1)
	go func() {
		defer wg.Done()
		tick := time.NewTicker(25 * time.Millisecond)
		defer tick.Stop()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			case <-tick.C:
				resp, b := owner.do(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": fmt.Sprintf("concorrente %d", i)})
				if resp.StatusCode != 201 {
					t.Errorf("envio concorrente = %d: %s", resp.StatusCode, b)
					return
				}
				id, _ := strconv.ParseInt(str(obj(t, b), "id"), 10, 64)
				injMu.Lock()
				injected = append(injected, id)
				injMu.Unlock()
			}
		}
	}()

	var (
		durations []time.Duration
		seen      = make(map[int64]struct{}, bulkMessages+1000)
		next      = int64(bulkMessages) // próximo ID sintético esperado (decrescente), sem buracos
		prev      = int64(1<<63 - 1)    // para ordem estrita
		before    string
		pages     int
		hasMore   = true
		total     int
	)
	pageStart := time.Now()
	for hasMore {
		path := "/api/channels/" + g.textID + "/messages?limit=" + strconv.Itoa(pageSize)
		if before != "" {
			path += "&before=" + before
		}
		t0 := time.Now()
		resp, b := owner.do(t, "GET", path, nil)
		durations = append(durations, time.Since(t0))
		status(t, resp, b, 200)
		page := obj(t, b)
		msgs := list(page, "messages")
		hasMore, _ = page["has_more"].(bool)
		pages++
		if len(msgs) == 0 {
			t.Fatalf("página %d vazia com has_more=%v", pages, hasMore)
		}
		if hasMore && len(msgs) != pageSize {
			t.Fatalf("página %d: has_more=true com %d itens", pages, len(msgs))
		}
		for _, m := range msgs {
			id, _ := strconv.ParseInt(str(m, "id"), 10, 64)
			if id >= prev {
				t.Fatalf("ordem não estritamente decrescente: %d depois de %d (página %d)", id, prev, pages)
			}
			prev = id
			if _, dup := seen[id]; dup {
				t.Fatalf("mensagem %d duplicada (página %d)", id, pages)
			}
			seen[id] = struct{}{}
			total++
			if id > base+bulkMessages {
				continue // mensagem concorrente: só precisa ser nova
			}
			if id != base+next {
				t.Fatalf("buraco: esperava %d, veio %d (página %d)", base+next, id, pages)
			}
			next--
		}
		before = str(msgs[len(msgs)-1], "id")
	}
	close(stop)
	wg.Wait()

	if next != 0 {
		t.Fatalf("faltaram mensagens: parou em %d de %d", bulkMessages-next, bulkMessages)
	}
	injMu.Lock()
	defer injMu.Unlock()
	for _, id := range injected {
		if id <= base+bulkMessages {
			t.Fatalf("mensagem concorrente com ID %d dentro do intervalo do lote", id)
		}
	}
	if total < bulkMessages {
		t.Fatalf("total %d < %d", total, bulkMessages)
	}

	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	p := func(q float64) time.Duration { return durations[int(float64(len(durations)-1)*q)] }
	t.Logf("paginação: %d páginas de %d (%d mensagens vistas, %d concorrentes enviadas durante a paginação) em %v",
		pages, pageSize, total, len(injected), time.Since(pageStart).Round(time.Millisecond))
	t.Logf("latência da listagem (HTTP local, limit=%d): p50=%v p95=%v p99=%v max=%v (meta SPEC: p95 < %v)",
		pageSize, p(0.50), p(0.95), p(0.99), durations[len(durations)-1], targetP95)
	if p(0.95) > targetP95 {
		t.Logf("AVISO: p95 acima da meta do SPEC (%v); o teste não falha por isso", targetP95)
	}
}
