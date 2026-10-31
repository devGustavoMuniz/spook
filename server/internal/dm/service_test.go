package dm

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

// fakeStore guarda tudo em memória e imita as garantias do banco (par único, limite sob lock).
type fakeStore struct {
	mu       sync.Mutex
	shares   map[[2]int64]bool // (a<b) compartilham servidor
	chans    map[int64]channel.Channel
	pairs    map[[2]int64]int64
	members  map[int64][]int64
	openCall int
}

func newFakeStore() *fakeStore {
	return &fakeStore{shares: map[[2]int64]bool{}, chans: map[int64]channel.Channel{}, pairs: map[[2]int64]int64{}, members: map[int64][]int64{}}
}

func key(a, b int64) [2]int64 {
	if a > b {
		a, b = b, a
	}
	return [2]int64{a, b}
}

func (f *fakeStore) share(a, b int64) { f.shares[key(a, b)] = true }

func (f *fakeStore) SharingGuild(_ context.Context, u int64, cands []int64) ([]int64, error) {
	var out []int64
	for _, c := range cands {
		if f.shares[key(u, c)] {
			out = append(out, c)
		}
	}
	return out, nil
}

func (f *fakeStore) OpenPair(_ context.Context, a, b, id int64) (channel.Channel, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.openCall++
	if cid, ok := f.pairs[[2]int64{a, b}]; ok {
		return f.chans[cid], false, nil
	}
	c := channel.Channel{ID: id, Type: channel.TypeDM}
	f.chans[id], f.pairs[[2]int64{a, b}], f.members[id] = c, id, []int64{a, b}
	return c, true, nil
}

func (f *fakeStore) CreateGroup(_ context.Context, id, owner int64, rs []int64) (channel.Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := channel.Channel{ID: id, Type: channel.TypeGroupDM, OwnerID: &owner}
	f.chans[id], f.members[id] = c, slices.Clone(rs)
	return c, nil
}

func (f *fakeStore) Get(_ context.Context, id int64) (channel.Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.chans[id]
	if !ok {
		return channel.Channel{}, channel.ErrNotFound
	}
	return c, nil
}

func (f *fakeStore) Recipients(_ context.Context, ids []int64) (map[int64][]channel.Recipient, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[int64][]channel.Recipient{}
	for _, id := range ids {
		for _, u := range f.members[id] {
			out[id] = append(out[id], channel.Recipient{ID: u, Username: "u"})
		}
	}
	return out, nil
}

func (f *fakeStore) ListByUser(_ context.Context, u int64) ([]channel.Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []channel.Channel
	for id, m := range f.members {
		if slices.Contains(m, u) {
			out = append(out, f.chans[id])
		}
	}
	slices.SortFunc(out, func(a, b channel.Channel) int { return int(b.ID - a.ID) })
	return out, nil
}

func (f *fakeStore) AddRecipient(_ context.Context, id, u int64, max int) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if slices.Contains(f.members[id], u) {
		return false, nil
	}
	if len(f.members[id]) >= max {
		return false, ErrGroupFull
	}
	f.members[id] = append(f.members[id], u)
	return true, nil
}

func (f *fakeStore) RemoveRecipient(_ context.Context, id, u int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := slices.Index(f.members[id], u)
	if i < 0 {
		return false, nil
	}
	f.members[id] = slices.Delete(f.members[id], i, i+1)
	return true, nil
}

func (f *fakeStore) Rename(_ context.Context, id int64, name string) (channel.Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.chans[id]
	c.Name = name
	f.chans[id] = c
	return c, nil
}

func (f *fakeStore) IsRecipient(_ context.Context, id, u int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Contains(f.members[id], u), nil
}

type seq struct{ n int64 }

func (s *seq) Next() int64 { s.n++; return 1000 + s.n }

type noAvatars struct{}

func (noAvatars) AvatarURLForKey(context.Context, *string) string { return "" }

type allowLimiter struct {
	ok   bool
	keys []string
}

func (l *allowLimiter) Take(k string) (bool, time.Duration) {
	l.keys = append(l.keys, k)
	return l.ok, 7 * time.Second
}

type rec struct {
	mu  sync.Mutex
	evs []events.Event
}

func (r *rec) Publish(ev events.Event) { r.mu.Lock(); r.evs = append(r.evs, ev); r.mu.Unlock() }

func (r *rec) take() []events.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.evs
	r.evs = nil
	return out
}

func setup() (*Service, *fakeStore, *allowLimiter, *rec) {
	st, lim, r := newFakeStore(), &allowLimiter{ok: true}, &rec{}
	return NewService(st, &seq{}, r, noAvatars{}, lim), st, lim, r
}

func kind(t *testing.T, err error, k apperr.Kind) {
	t.Helper()
	if !apperr.IsKind(err, k) {
		t.Fatalf("erro = %v, esperado tipo %v", err, k)
	}
}

func topics(ev events.Event) []string {
	t := slices.Clone(ev.Topics)
	slices.Sort(t)
	return t
}

var ctx = context.Background()

// ---- DM 1:1 ----

func TestOpenRequiresSharedGuild(t *testing.T) {
	s, st, _, r := setup()
	_, _, err := s.Open(ctx, 1, 2)
	kind(t, err, apperr.KindForbidden)
	if len(r.take()) != 0 {
		t.Fatal("não deve publicar nada")
	}
	st.share(1, 2)
	ch, created, err := s.Open(ctx, 1, 2)
	if err != nil || !created || ch.Type != channel.TypeDM || len(ch.Recipients) != 2 {
		t.Fatalf("ch=%+v created=%v err=%v", ch, created, err)
	}
}

func TestOpenSelfIsInvalid(t *testing.T) {
	s, st, _, _ := setup()
	st.share(1, 1)
	_, _, err := s.Open(ctx, 1, 1)
	kind(t, err, apperr.KindInvalid)
}

func TestOpenIsUniquePerPairRegardlessOfWhoOpens(t *testing.T) {
	s, st, _, r := setup()
	st.share(1, 2)
	a, created, _ := s.Open(ctx, 1, 2)
	if !created {
		t.Fatal("a primeira abertura cria")
	}
	b, created, err := s.Open(ctx, 2, 1) // o outro lado reabre
	if err != nil || created || b.ID != a.ID {
		t.Fatalf("reabrir deve devolver a existente: %+v created=%v err=%v", b, created, err)
	}
	evs := r.take()
	if len(evs) != 1 || evs[0].Type != events.ChannelCreate {
		t.Fatalf("só a criação publica: %+v", evs)
	}
	if got := topics(evs[0]); !slices.Equal(got, []string{"user:1", "user:2"}) {
		t.Fatalf("CHANNEL_CREATE deve ir a user:<id> dos dois participantes: %v", got)
	}
}

func TestConcurrentOpensYieldOneChannel(t *testing.T) {
	s, st, _, _ := setup()
	st.share(1, 2)
	var wg sync.WaitGroup
	var mu sync.Mutex
	ids, created := map[int64]bool{}, 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(a, b int64) {
			defer wg.Done()
			ch, c, err := s.Open(ctx, a, b)
			if err != nil {
				t.Error(err)
				return
			}
			mu.Lock()
			ids[ch.ID] = true
			if c {
				created++
			}
			mu.Unlock()
		}(int64(1+i%2), int64(2-i%2))
	}
	wg.Wait()
	if len(ids) != 1 || created != 1 {
		t.Fatalf("canais=%v criações=%d", ids, created)
	}
}

func TestCreationIsRateLimited(t *testing.T) {
	s, st, lim, _ := setup()
	st.share(1, 2)
	lim.ok = false
	_, _, err := s.Open(ctx, 1, 2)
	kind(t, err, apperr.KindRateLimited)
	if e, _ := apperr.As(err); e.RetryAfter != 7*time.Second {
		t.Fatalf("retry-after = %v", e.RetryAfter)
	}
	if st.openCall != 0 {
		t.Fatal("limitado antes de tocar o banco")
	}
	_, err = s.CreateGroup(ctx, 1, []int64{2})
	kind(t, err, apperr.KindRateLimited)
	if lim.keys[0] != "dm:1" {
		t.Fatalf("chave = %v", lim.keys)
	}
}

// ---- DM em grupo ----

func group(t *testing.T, s *Service, st *fakeStore, owner int64, guests ...int64) channel.Channel {
	t.Helper()
	for _, g := range guests {
		st.share(owner, g)
	}
	ch, err := s.CreateGroup(ctx, owner, guests)
	if err != nil {
		t.Fatal(err)
	}
	return ch
}

func TestCreateGroupMakesCreatorTheOwner(t *testing.T) {
	s, st, _, r := setup()
	ch := group(t, s, st, 1, 2, 3)
	if ch.Type != channel.TypeGroupDM || ch.OwnerID == nil || *ch.OwnerID != 1 || len(ch.Recipients) != 3 {
		t.Fatalf("ch = %+v", ch)
	}
	evs := r.take()
	if len(evs) != 1 || evs[0].Type != events.ChannelCreate || !slices.Equal(topics(evs[0]), []string{"user:1", "user:2", "user:3"}) {
		t.Fatalf("eventos = %+v", evs)
	}
}

func TestCreateGroupRules(t *testing.T) {
	s, st, _, _ := setup()
	st.share(1, 2)
	_, err := s.CreateGroup(ctx, 1, nil)
	kind(t, err, apperr.KindInvalid)
	_, err = s.CreateGroup(ctx, 1, []int64{1, 2}) // o dono na lista
	kind(t, err, apperr.KindInvalid)
	_, err = s.CreateGroup(ctx, 1, []int64{2, 3}) // 3 não compartilha servidor com o dono
	kind(t, err, apperr.KindForbidden)

	many := make([]int64, 10) // 10 convidados + dono = 11 > 10
	for i := range many {
		many[i] = int64(10 + i)
		st.share(1, many[i])
	}
	_, err = s.CreateGroup(ctx, 1, many)
	kind(t, err, apperr.KindInvalid)
	if ch, err := s.CreateGroup(ctx, 1, many[:9]); err != nil || len(ch.Recipients) != 10 {
		t.Fatalf("10 participantes (dono + 9) é o máximo permitido: %v", err)
	}
	// duplicados contam uma vez
	if ch, err := s.CreateGroup(ctx, 1, []int64{2, 2}); err != nil || len(ch.Recipients) != 2 {
		t.Fatalf("ch=%+v err=%v", ch, err)
	}
}

func TestGroupInviteeMustShareAGuildWithTheOwner(t *testing.T) {
	s, st, _, _ := setup()
	ch := group(t, s, st, 1, 2)
	st.share(2, 5) // 5 conhece o convidado, mas não o dono
	_, err := s.AddRecipient(ctx, 1, ch.ID, 5)
	kind(t, err, apperr.KindForbidden)
}

func TestOnlyOwnerAdds(t *testing.T) {
	s, st, _, r := setup()
	ch := group(t, s, st, 1, 2)
	st.share(1, 3)
	st.share(2, 3)
	r.take()
	_, err := s.AddRecipient(ctx, 2, ch.ID, 3) // participante não-dono
	kind(t, err, apperr.KindForbidden)
	_, err = s.AddRecipient(ctx, 9, ch.ID, 3) // quem não participa vê "inexistente"
	kind(t, err, apperr.KindNotFound)

	got, err := s.AddRecipient(ctx, 1, ch.ID, 3)
	if err != nil || len(got.Recipients) != 3 {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	evs := r.take()
	if len(evs) != 2 {
		t.Fatalf("eventos = %+v", evs)
	}
	// o novo participante recebe CHANNEL_CREATE; os demais, CHANNEL_UPDATE com a lista nova
	if evs[0].Type != events.ChannelCreate || !slices.Equal(topics(evs[0]), []string{"user:3"}) {
		t.Fatalf("evs[0] = %+v", evs[0])
	}
	if evs[1].Type != events.ChannelUpdate || !slices.Equal(topics(evs[1]), []string{"user:1", "user:2"}) {
		t.Fatalf("evs[1] = %+v", evs[1])
	}
	if p := evs[1].Data.(channel.ChannelPayload); len(p.Recipients) != 3 {
		t.Fatalf("o update deve levar a lista nova: %+v", p)
	}
	// adicionar quem já está é um no-op sem eventos
	if _, err := s.AddRecipient(ctx, 1, ch.ID, 3); err != nil || len(r.take()) != 0 {
		t.Fatal("idempotente e sem eventos")
	}
}

func TestGroupLimitOfTenParticipants(t *testing.T) {
	s, st, _, _ := setup()
	ch := group(t, s, st, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10) // 10 no total
	st.share(1, 11)
	_, err := s.AddRecipient(ctx, 1, ch.ID, 11)
	kind(t, err, apperr.KindConflict)
}

func TestAddToOneToOneDMIsInvalid(t *testing.T) {
	s, st, _, _ := setup()
	st.share(1, 2)
	st.share(1, 3)
	ch, _, _ := s.Open(ctx, 1, 2)
	_, err := s.AddRecipient(ctx, 1, ch.ID, 3)
	kind(t, err, apperr.KindInvalid)
	kind(t, s.RemoveRecipient(ctx, 1, ch.ID, 2), apperr.KindInvalid)
}

func TestOwnerRemovesAndOthersCannot(t *testing.T) {
	s, st, _, r := setup()
	ch := group(t, s, st, 1, 2, 3)
	r.take()
	kind(t, s.RemoveRecipient(ctx, 2, ch.ID, 3), apperr.KindForbidden) // não-dono remove outro
	if err := s.RemoveRecipient(ctx, 1, ch.ID, 3); err != nil {
		t.Fatal(err)
	}
	evs := r.take()
	if len(evs) != 2 || evs[0].Type != events.ChannelDelete || !slices.Equal(topics(evs[0]), []string{"user:3"}) {
		t.Fatalf("o removido recebe CHANNEL_DELETE: %+v", evs)
	}
	if evs[1].Type != events.ChannelUpdate || !slices.Equal(topics(evs[1]), []string{"user:1", "user:2"}) {
		t.Fatalf("os demais recebem CHANNEL_UPDATE: %+v", evs[1])
	}
	if p := evs[1].Data.(channel.ChannelPayload); len(p.Recipients) != 2 {
		t.Fatalf("lista nova: %+v", p)
	}
	kind(t, s.RemoveRecipient(ctx, 1, ch.ID, 3), apperr.KindNotFound) // já saiu
}

func TestOwnerCannotLeaveNorBeRemoved(t *testing.T) {
	s, st, _, _ := setup()
	ch := group(t, s, st, 1, 2)
	kind(t, s.RemoveRecipient(ctx, 1, ch.ID, 1), apperr.KindConflict) // dono sai
	kind(t, s.RemoveRecipient(ctx, 2, ch.ID, 1), apperr.KindConflict) // tentam remover o dono
}

func TestParticipantCanLeave(t *testing.T) {
	s, st, _, r := setup()
	ch := group(t, s, st, 1, 2, 3)
	r.take()
	if err := s.RemoveRecipient(ctx, 2, ch.ID, 2); err != nil {
		t.Fatal(err)
	}
	if ok, _ := st.IsRecipient(ctx, ch.ID, 2); ok {
		t.Fatal("quem saiu não participa mais")
	}
	evs := r.take()
	if len(evs) != 2 || evs[0].Type != events.ChannelDelete || !slices.Equal(topics(evs[0]), []string{"user:2"}) {
		t.Fatalf("eventos = %+v", evs)
	}
	kind(t, s.RemoveRecipient(ctx, 2, ch.ID, 2), apperr.KindNotFound) // quem saiu já não vê o canal
}

func TestRenameIsOwnerOnlyAndGroupOnly(t *testing.T) {
	s, st, _, r := setup()
	ch := group(t, s, st, 1, 2)
	r.take()
	_, err := s.Rename(ctx, 2, ch.ID, "Estudos")
	kind(t, err, apperr.KindForbidden)
	_, err = s.Rename(ctx, 9, ch.ID, "Estudos")
	kind(t, err, apperr.KindNotFound)
	_, err = s.Rename(ctx, 1, ch.ID, "   ")
	kind(t, err, apperr.KindInvalid)
	got, err := s.Rename(ctx, 1, ch.ID, "  Estudos de Go ")
	if err != nil || got.Name != "Estudos de Go" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	evs := r.take()
	if len(evs) != 1 || evs[0].Type != events.ChannelUpdate || !slices.Equal(topics(evs[0]), []string{"user:1", "user:2"}) {
		t.Fatalf("eventos = %+v", evs)
	}
	st.share(1, 3)
	one, _, _ := s.Open(ctx, 1, 3)
	_, err = s.Rename(ctx, 1, one.ID, "x")
	kind(t, err, apperr.KindInvalid)
}

func TestListIncludesRecipients(t *testing.T) {
	s, st, _, _ := setup()
	st.share(1, 2)
	one, _, _ := s.Open(ctx, 1, 2)
	g := group(t, s, st, 1, 3)
	other := group(t, s, st, 4, 5) // DM de outras pessoas
	list, err := s.List(ctx, 1)
	if err != nil || len(list) != 2 {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	ids := []int64{list[0].ID, list[1].ID}
	if !slices.Contains(ids, one.ID) || !slices.Contains(ids, g.ID) || slices.Contains(ids, other.ID) {
		t.Fatalf("ids = %v", ids)
	}
	for _, c := range list {
		if len(c.Recipients) != 2 {
			t.Fatalf("a lista traz os participantes: %+v", c)
		}
	}
}

func TestNonDMChannelIsNotFound(t *testing.T) {
	s, st, _, _ := setup()
	st.chans[77] = channel.Channel{ID: 77, Type: channel.TypeText}
	_, err := s.AddRecipient(ctx, 1, 77, 2)
	kind(t, err, apperr.KindNotFound)
	kind(t, s.RemoveRecipient(ctx, 1, 77, 1), apperr.KindNotFound)
}
