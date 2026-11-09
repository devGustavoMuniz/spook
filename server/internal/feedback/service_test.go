package feedback

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

// fakeStore guarda chamados em memória com as mesmas regras do PGStore.
type fakeStore struct {
	tickets map[int64]*Ticket
	msgs    map[int64][]Message
	names   map[int64]string
	clock   time.Time
	atts    map[int64]*Attachment
}

func newFake() *fakeStore {
	return &fakeStore{
		tickets: map[int64]*Ticket{}, msgs: map[int64][]Message{},
		atts: map[int64]*Attachment{}, names: map[int64]string{1: "ana", 2: "beto", 9: "admin"}, clock: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
}

func (f *fakeStore) tick() time.Time { f.clock = f.clock.Add(time.Minute); return f.clock }

func (f *fakeStore) Create(_ context.Context, n NewTicket) (Ticket, error) {
	now := f.tick()
	t := &Ticket{ID: n.ID, AuthorID: n.AuthorID, Kind: n.Kind, Status: StatusOpen, Title: n.Title, Context: n.Context, MessageCount: 1, CreatedAt: now, UpdatedAt: now, LastActivityAt: now}
	f.tickets[n.ID] = t
	a := n.AuthorID
	f.msgs[n.ID] = []Message{{ID: n.MessageID, TicketID: n.ID, AuthorID: &a, Kind: MsgUser, Body: n.Body, CreatedAt: now}}
	if err := f.claim(n.Claim, n.ID, n.MessageID); err != nil {
		delete(f.tickets, n.ID)
		delete(f.msgs, n.ID)
		return Ticket{}, err
	}
	return *t, nil
}

func (f *fakeStore) ActiveCount(_ context.Context, author int64) (int64, error) {
	var n int64
	for _, t := range f.tickets {
		if t.AuthorID == author && t.Status.active() {
			n++
		}
	}
	return n, nil
}

func (f *fakeStore) ListByAuthor(_ context.Context, author int64, st *Status, after *Cursor, limit int) ([]Ticket, error) {
	var out []Ticket
	for _, t := range f.tickets {
		if t.AuthorID == author && (st == nil || t.Status == *st) {
			out = append(out, *t)
		}
	}
	slices.SortFunc(out, func(a, b Ticket) int {
		if c := b.LastActivityAt.Compare(a.LastActivityAt); c != 0 {
			return c
		}
		return int(b.ID - a.ID)
	})
	if after != nil {
		i := slices.IndexFunc(out, func(t Ticket) bool {
			return t.LastActivityAt.Before(after.At) || (t.LastActivityAt.Equal(after.At) && t.ID < after.ID)
		})
		if i < 0 {
			return nil, nil
		}
		out = out[i:]
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeStore) Get(_ context.Context, id int64) (AdminTicket, error) {
	t, ok := f.tickets[id]
	if !ok {
		return AdminTicket{}, ErrNotFound
	}
	return AdminTicket{Ticket: *t, Author: Author{ID: t.AuthorID, Username: f.names[t.AuthorID], Email: f.names[t.AuthorID] + "@x.test"}}, nil
}

func (f *fakeStore) Messages(_ context.Context, id int64, internal bool) ([]Message, error) {
	var out []Message
	for _, m := range f.msgs[id] {
		if internal || m.Kind != MsgInternal {
			out = append(out, m)
		}
	}
	return out, nil
}

func (f *fakeStore) AddMessage(_ context.Context, m NewMessage) (Message, Ticket, error) {
	t, ok := f.tickets[m.TicketID]
	if !ok {
		return Message{}, Ticket{}, ErrNotFound
	}
	if m.Kind != MsgInternal && t.MessageCount >= MaxPublicMessages {
		return Message{}, Ticket{}, ErrTooManyMessages
	}
	dec, err := m.Decide(*t)
	if err != nil {
		return Message{}, Ticket{}, err
	}
	if err := f.claim(m.Claim, m.TicketID, m.ID); err != nil {
		return Message{}, Ticket{}, err
	}
	a := m.AuthorID
	msg := Message{ID: m.ID, TicketID: m.TicketID, AuthorID: &a, Kind: m.Kind, Body: m.Body, CreatedAt: f.tick()}
	f.msgs[m.TicketID] = append(f.msgs[m.TicketID], msg)
	if dec.Touch {
		t.Status, t.UserUnread, t.MessageCount, t.LastActivityAt = dec.Status, dec.Unread, t.MessageCount+1, msg.CreatedAt
	}
	return msg, *t, nil
}

func (f *fakeStore) SetStatus(_ context.Context, id int64, decide func(Ticket) (Status, bool, error)) (Ticket, error) {
	t, ok := f.tickets[id]
	if !ok {
		return Ticket{}, ErrNotFound
	}
	st, unread, err := decide(*t)
	if err != nil {
		return Ticket{}, err
	}
	t.Status, t.UserUnread, t.LastActivityAt = st, unread, f.tick()
	return *t, nil
}

func (f *fakeStore) MarkRead(_ context.Context, id int64) error {
	f.tickets[id].UserUnread = false
	return nil
}

func (f *fakeStore) AdminList(_ context.Context, fl AdminFilter, _ *Cursor, limit int) ([]AdminTicket, error) {
	var out []AdminTicket
	for id := range f.tickets {
		a, _ := f.Get(context.Background(), id)
		if (fl.Status == nil || a.Status == *fl.Status) && (fl.Kind == nil || a.Kind == *fl.Kind) {
			out = append(out, a)
		}
	}
	slices.SortFunc(out, func(a, b AdminTicket) int { return int(a.ID - b.ID) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeStore) Counts(context.Context) (TicketSummary, error) {
	var s TicketSummary
	for _, t := range f.tickets {
		s.Total++
		if t.Status == StatusOpen {
			s.Open++
		}
	}
	return s, nil
}

type recorder struct {
	mu  sync.Mutex
	evs []events.Event
}

func (r *recorder) Publish(e events.Event) { r.mu.Lock(); r.evs = append(r.evs, e); r.mu.Unlock() }

type seq struct{ n int64 }

func (s *seq) Next() int64 { s.n++; return s.n + 100 }

type admins map[int64]bool

func (a admins) IsAdmin(_ context.Context, id int64) (bool, error) { return a[id], nil }

func setup() (*Service, *fakeStore, *recorder) {
	f, r := newFake(), &recorder{}
	return NewService(f, &seq{}, r, admins{9: true}, nil), f, r
}

func wantKind(t *testing.T, err error, k apperr.Kind) {
	t.Helper()
	if !apperr.IsKind(err, k) {
		t.Fatalf("erro = %v, esperado o tipo %d", err, k)
	}
}

func TestCreateValidatesAndTrims(t *testing.T) {
	s, _, _ := setup()
	ctx := context.Background()
	if _, err := s.Create(ctx, 1, "xx", "Título ok", "corpo", nil, Attach{}); !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("tipo inválido: %v", err)
	}
	if _, err := s.Create(ctx, 1, KindBug, "ab", "corpo", nil, Attach{}); !errors.Is(err, ErrInvalidTitle) {
		t.Fatalf("título curto: %v", err)
	}
	if _, err := s.Create(ctx, 1, KindBug, strings.Repeat("a", 121), "corpo", nil, Attach{}); !errors.Is(err, ErrInvalidTitle) {
		t.Fatalf("título longo: %v", err)
	}
	if _, err := s.Create(ctx, 1, KindBug, "Título", "   ", nil, Attach{}); !errors.Is(err, ErrInvalidBody) {
		t.Fatalf("corpo vazio: %v", err)
	}
	if _, err := s.Create(ctx, 1, KindBug, "Título", strings.Repeat("é", BodyMax+1), nil, Attach{}); !errors.Is(err, ErrInvalidBody) {
		t.Fatalf("corpo longo (conta runas): %v", err)
	}
	d, err := s.Create(ctx, 1, KindBug, "  Título  ", " corpo ", &TicketContext{AppVersion: strings.Repeat("9", 80), Route: "/app"}, Attach{})
	if err != nil {
		t.Fatal(err)
	}
	if d.Title != "Título" || d.Status != "open" || len(d.Messages) != 1 || d.Messages[0].Body != "corpo" || d.Messages[0].Kind != "user" {
		t.Fatalf("detalhe = %+v", d)
	}
	if len(d.Context.AppVersion) != 32 {
		t.Fatalf("o contexto deveria ser truncado: %d", len(d.Context.AppVersion))
	}
	if d2, _ := s.Create(ctx, 1, KindBug, "Outro título", "x", &TicketContext{}, Attach{}); d2.Context != nil {
		t.Fatal("contexto vazio não deve ser gravado")
	}
}

func TestCreateLimitsActiveTickets(t *testing.T) {
	s, _, _ := setup()
	ctx := context.Background()
	for i := 0; i < MaxActivePerUser; i++ {
		if _, err := s.Create(ctx, 1, KindFeedback, "Chamado", "x", nil, Attach{}); err != nil {
			t.Fatal(err)
		}
	}
	_, err := s.Create(ctx, 1, KindFeedback, "Chamado", "x", nil, Attach{})
	if !errors.Is(err, ErrTooManyActive) {
		t.Fatalf("esperava o limite, veio %v", err)
	}
	if _, err := s.Create(ctx, 2, KindFeedback, "Chamado", "x", nil, Attach{}); err != nil {
		t.Fatalf("o limite é por pessoa: %v", err)
	}
}

func TestOnlyAuthorSeesAndTouchesTicket(t *testing.T) {
	s, _, _ := setup()
	ctx := context.Background()
	d, _ := s.Create(ctx, 1, KindBug, "Bug", "descrição", nil, Attach{})
	id := mustID(t, d.ID)
	if _, err := s.Get(ctx, 2, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outro usuário vê o chamado: %v", err)
	}
	if _, err := s.Reply(ctx, 2, id, "oi", Attach{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outro usuário responde: %v", err)
	}
	if _, err := s.SetOwnStatus(ctx, 2, id, StatusClosed); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outro usuário fecha: %v", err)
	}
	if p, _ := s.List(ctx, 2, "", "", 10); len(p.Items) != 0 {
		t.Fatalf("lista de outro usuário: %+v", p)
	}
}

func TestInternalNotesNeverReachTheAuthor(t *testing.T) {
	s, f, r := setup()
	ctx := context.Background()
	d, _ := s.Create(ctx, 1, KindBug, "Bug", "descrição", nil, Attach{})
	id := mustID(t, d.ID)
	before := len(r.evs)
	if _, err := s.AdminReply(ctx, 9, id, "segredo interno", true, Attach{}); err != nil {
		t.Fatal(err)
	}
	if len(r.evs) != before {
		t.Fatal("nota interna não deve avisar o autor")
	}
	if f.tickets[id].Status != StatusOpen || f.tickets[id].UserUnread || f.tickets[id].MessageCount != 1 {
		t.Fatalf("nota interna mudou o chamado: %+v", f.tickets[id])
	}
	got, _ := s.Get(ctx, 1, id)
	for _, m := range got.Messages {
		if strings.Contains(m.Body, "segredo") || m.Kind == "internal" {
			t.Fatalf("nota vazou: %+v", m)
		}
	}
	adm, _ := s.AdminGet(ctx, id)
	if len(adm.Messages) != 2 || adm.Messages[1].Kind != "internal" || adm.Author.Email == "" {
		t.Fatalf("o admin deveria ver a nota e o autor: %+v", adm)
	}
}

func TestAdminReplyFlowAndNotification(t *testing.T) {
	s, f, r := setup()
	ctx := context.Background()
	d, _ := s.Create(ctx, 1, KindSuggestion, "Ideia", "descrição", nil, Attach{})
	id := mustID(t, d.ID)
	if _, err := s.AdminReply(ctx, 9, id, "obrigado!", false, Attach{}); err != nil {
		t.Fatal(err)
	}
	if tk := f.tickets[id]; tk.Status != StatusAnswered || !tk.UserUnread || tk.MessageCount != 2 {
		t.Fatalf("depois da resposta: %+v", tk)
	}
	ev := r.evs[len(r.evs)-1]
	up, ok := ev.Data.(TicketUpdatePayload)
	if ev.Type != events.TicketUpdate || !ok || !up.ByAdmin || !up.Unread || ev.Topics[0] != "user:1" {
		t.Fatalf("evento = %+v", ev)
	}
	// O autor abre: marca como lido; a resposta aparece sem identificar o admin.
	got, _ := s.Get(ctx, 1, id)
	if got.Unread || got.Messages[1].Kind != "admin" || f.tickets[id].UserUnread {
		t.Fatalf("depois de abrir: %+v", got)
	}
	// O autor responde: volta a aberto.
	if _, err := s.Reply(ctx, 1, id, "mais um detalhe", Attach{}); err != nil {
		t.Fatal(err)
	}
	if f.tickets[id].Status != StatusOpen {
		t.Fatalf("resposta do autor deveria reabrir: %s", f.tickets[id].Status)
	}
}

func TestClosedTicketRules(t *testing.T) {
	s, _, _ := setup()
	ctx := context.Background()
	d, _ := s.Create(ctx, 1, KindBug, "Bug", "x", nil, Attach{})
	id := mustID(t, d.ID)
	if _, err := s.SetOwnStatus(ctx, 1, id, StatusResolved); err == nil {
		t.Fatal("o autor não pode marcar como resolvido")
	} else {
		wantKind(t, err, apperr.KindInvalid)
	}
	if _, err := s.SetOwnStatus(ctx, 1, id, StatusOpen); !errors.Is(err, ErrBadTransition) {
		t.Fatalf("reabrir o que está aberto: %v", err)
	}
	if _, err := s.SetOwnStatus(ctx, 1, id, StatusClosed); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reply(ctx, 1, id, "ainda?", Attach{}); !errors.Is(err, ErrClosed) {
		t.Fatalf("responder fechado: %v", err)
	}
	if _, err := s.AdminReply(ctx, 9, id, "oi", false, Attach{}); !errors.Is(err, ErrClosed) {
		t.Fatalf("admin responder fechado: %v", err)
	}
	if _, err := s.AdminReply(ctx, 9, id, "nota", true, Attach{}); err != nil {
		t.Fatalf("nota em chamado fechado é permitida: %v", err)
	}
	if _, err := s.SetOwnStatus(ctx, 1, id, StatusClosed); !errors.Is(err, ErrBadTransition) {
		t.Fatalf("fechar duas vezes: %v", err)
	}
	if tk, err := s.SetOwnStatus(ctx, 1, id, StatusOpen); err != nil || tk.Status != "open" {
		t.Fatalf("reabrir: %+v %v", tk, err)
	}
}

func TestAdminStatusChangeNotifiesOnResolve(t *testing.T) {
	s, f, r := setup()
	ctx := context.Background()
	d, _ := s.Create(ctx, 1, KindBug, "Bug", "x", nil, Attach{})
	id := mustID(t, d.ID)
	if _, err := s.AdminSetStatus(ctx, 9, id, "lixo"); !errors.Is(err, ErrInvalidStatus) {
		t.Fatalf("estado inválido: %v", err)
	}
	if _, err := s.AdminSetStatus(ctx, 9, id, StatusInReview); err != nil {
		t.Fatal(err)
	}
	if f.tickets[id].UserUnread {
		t.Fatal("em análise não deve marcar como não lido")
	}
	if _, err := s.AdminSetStatus(ctx, 9, id, StatusResolved); err != nil {
		t.Fatal(err)
	}
	if !f.tickets[id].UserUnread {
		t.Fatal("resolver deve marcar como não lido")
	}
	if up := r.evs[len(r.evs)-1].Data.(TicketUpdatePayload); up.Status != "resolved" || !up.ByAdmin {
		t.Fatalf("evento = %+v", up)
	}
	if _, err := s.AdminSetStatus(ctx, 9, 999, StatusClosed); !errors.Is(err, ErrNotFound) {
		t.Fatalf("chamado inexistente: %v", err)
	}
}

func TestMessageLimit(t *testing.T) {
	s, f, _ := setup()
	ctx := context.Background()
	d, _ := s.Create(ctx, 1, KindBug, "Bug", "x", nil, Attach{})
	id := mustID(t, d.ID)
	f.tickets[id].MessageCount = MaxPublicMessages
	if _, err := s.Reply(ctx, 1, id, "x", Attach{}); !errors.Is(err, ErrTooManyMessages) {
		t.Fatalf("limite de mensagens: %v", err)
	}
}

func TestPaginationCursor(t *testing.T) {
	s, _, _ := setup()
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if _, err := s.Create(ctx, 1, KindFeedback, "Chamado", "x", nil, Attach{}); err != nil {
			t.Fatal(err)
		}
	}
	var seen []string
	cursor := ""
	for pages := 0; pages < 10; pages++ {
		p, err := s.List(ctx, 1, "", cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, it := range p.Items {
			seen = append(seen, it.ID)
		}
		if p.NextCursor == nil {
			break
		}
		cursor = *p.NextCursor
	}
	if len(seen) != 5 {
		t.Fatalf("paginação devolveu %d itens: %v", len(seen), seen)
	}
	for _, bad := range []string{"abc", "1.x", ".5", "1.-3"} {
		if _, err := s.List(ctx, 1, "", bad, 2); !errors.Is(err, ErrInvalidCursor) {
			t.Fatalf("cursor %q: %v", bad, err)
		}
	}
	if _, err := s.List(ctx, 1, "lixo", "", 2); !errors.Is(err, ErrInvalidStatus) {
		t.Fatalf("status inválido: %v", err)
	}
	if _, err := s.AdminList(ctx, "", "", "", "newest", "", 2); !errors.Is(err, ErrInvalidSort) {
		t.Fatalf("ordenação inválida: %v", err)
	}
	if _, err := s.AdminList(ctx, "", "x", "", "", "", 2); !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("tipo inválido: %v", err)
	}
}

func TestCursorRoundTrip(t *testing.T) {
	at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	c, err := parseCursor(encodeCursor(Ticket{ID: 42, LastActivityAt: at}, SortActivity), SortActivity)
	if err != nil || c.ID != 42 || !c.At.Equal(at) {
		t.Fatalf("cursor = %+v %v", c, err)
	}
	o, err := parseCursor(encodeCursor(Ticket{ID: 42}, SortOldest), SortOldest)
	if err != nil || o.ID != 42 {
		t.Fatalf("cursor oldest = %+v %v", o, err)
	}
}

func TestLikeEscape(t *testing.T) {
	if got := likeEscape(`50%_a\b`); got != `50\%\_a\\b` {
		t.Fatalf("likeEscape = %q", got)
	}
}

func mustID(t *testing.T, s string) int64 {
	t.Helper()
	var n int64
	for _, c := range s {
		n = n*10 + int64(c-'0')
	}
	if n == 0 {
		t.Fatal("id zero")
	}
	return n
}
