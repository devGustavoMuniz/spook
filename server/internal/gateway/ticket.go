package gateway

import (
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

// maxTickets limita o estoque de tickets em memória (cada um vive 30 s).
const maxTickets = 100_000

// tickets guarda tickets de uso único para o handshake de clientes que não conseguem mandar
// headers no WebSocket (o desktop/Tauri). O ticket só prova quem é o usuário; a sessão continua
// valendo pelo cookie/token normal.
type tickets struct {
	mu  sync.Mutex
	m   map[string]ticketEntry
	ttl time.Duration
	now func() time.Time
}

type ticketEntry struct {
	userID  int64
	authKey string // sessão de login que pediu o ticket (auth.TokenKey)
	expires time.Time
}

func newTickets(ttl time.Duration) *tickets {
	return &tickets{m: map[string]ticketEntry{}, ttl: ttl, now: time.Now}
}

// issue cria um ticket para o usuário. ok é false se o estoque está cheio.
func (t *tickets) issue(userID int64) (ticket string, ok bool) { return t.issueFor(userID, "") }

// issueFor é issue com a identificação da sessão de login, para o gateway derrubá-la se for encerrada.
func (t *tickets) issueFor(userID int64, authKey string) (ticket string, ok bool) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", false
	}
	ticket = base64.RawURLEncoding.EncodeToString(b[:])
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	if len(t.m) >= maxTickets/2 {
		t.purgeLocked(now)
	}
	if len(t.m) >= maxTickets {
		return "", false
	}
	t.m[ticket] = ticketEntry{userID: userID, authKey: authKey, expires: now.Add(t.ttl)}
	return ticket, true
}

// consume valida e queima o ticket (uso único).
func (t *tickets) consume(ticket string) (userID int64, ok bool) {
	userID, _, ok = t.consumeFull(ticket)
	return userID, ok
}

func (t *tickets) consumeFull(ticket string) (userID int64, authKey string, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, found := t.m[ticket]
	if !found {
		return 0, "", false
	}
	delete(t.m, ticket)
	if !e.expires.After(t.now()) {
		return 0, "", false
	}
	return e.userID, e.authKey, true
}

func (t *tickets) purge() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.purgeLocked(t.now())
}

func (t *tickets) purgeLocked(now time.Time) {
	for k, e := range t.m {
		if !e.expires.After(now) {
			delete(t.m, k)
		}
	}
}

func (t *tickets) size() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.m)
}
