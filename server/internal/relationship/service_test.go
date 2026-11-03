package relationship

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

// fakeStore guarda relacionamentos em memória com as mesmas regras do PGStore.
type fakeStore struct {
	users   map[string]int64
	names   map[int64]string
	friends map[[2]int64]struct {
		accepted bool
		by       int64
	}
	blocks map[[2]int64]bool // {bloqueador, bloqueado}
}

func newFake() *fakeStore {
	return &fakeStore{
		users: map[string]int64{"ana": 1, "beto": 2, "caio": 3}, names: map[int64]string{1: "ana", 2: "beto", 3: "caio"},
		friends: map[[2]int64]struct {
			accepted bool
			by       int64
		}{},
		blocks: map[[2]int64]bool{},
	}
}

func pair(a, b int64) [2]int64 {
	x, y := order(a, b)
	return [2]int64{x, y}
}

func (f *fakeStore) UserByUsername(_ context.Context, n string) (int64, error) {
	if id, ok := f.users[n]; ok {
		return id, nil
	}
	return 0, ErrUserNotFound
}

func (f *fakeStore) Brief(_ context.Context, id int64) (Row, error) {
	if n, ok := f.names[id]; ok {
		return Row{OtherID: id, Username: n}, nil
	}
	return Row{}, ErrUserNotFound
}

func (f *fakeStore) Request(_ context.Context, u, o int64) (Outcome, error) {
	if f.blocks[[2]int64{u, o}] {
		return OutcomeBlockedByMe, nil
	}
	if f.blocks[[2]int64{o, u}] {
		return OutcomeBlockedByThem, nil
	}
	fr, ok := f.friends[pair(u, o)]
	switch {
	case !ok:
		f.friends[pair(u, o)] = struct {
			accepted bool
			by       int64
		}{false, u}
		return OutcomeCreated, nil
	case fr.accepted:
		return OutcomeAlreadyFriend, nil
	case fr.by == u:
		return OutcomePending, nil
	}
	fr.accepted = true
	f.friends[pair(u, o)] = fr
	return OutcomeAccepted, nil
}

func (f *fakeStore) Accept(_ context.Context, u, o int64) error {
	fr, ok := f.friends[pair(u, o)]
	if !ok || fr.accepted || fr.by == u {
		return ErrRequestNotFound
	}
	fr.accepted = true
	f.friends[pair(u, o)] = fr
	return nil
}

func (f *fakeStore) Remove(_ context.Context, u, o int64) (RemoveResult, error) {
	fr, ok := f.friends[pair(u, o)]
	if !ok {
		return RemoveResult{}, nil
	}
	delete(f.friends, pair(u, o))
	return RemoveResult{Removed: true, WasAccepted: fr.accepted, RequestedBy: fr.by}, nil
}

func (f *fakeStore) Block(ctx context.Context, u, o int64) (bool, RemoveResult, error) {
	created := !f.blocks[[2]int64{u, o}]
	f.blocks[[2]int64{u, o}] = true
	res, _ := f.Remove(ctx, u, o)
	return created, res, nil
}

func (f *fakeStore) Unblock(_ context.Context, u, o int64) (bool, error) {
	ok := f.blocks[[2]int64{u, o}]
	delete(f.blocks, [2]int64{u, o})
	return ok, nil
}

func (f *fakeStore) List(context.Context, int64, Kind, int64, int) ([]Row, error) { return nil, nil }
func (f *fakeStore) Ready(context.Context, int64, int) ([]Row, []int64, Counts, error) {
	return nil, nil, Counts{}, nil
}
func (f *fakeStore) Get(context.Context, int64, int64) (Kind, time.Time, error) {
	return KindFriend, time.Now(), nil
}
func (f *fakeStore) FriendsAmong(context.Context, int64, []int64) ([]int64, error) { return nil, nil }
func (f *fakeStore) BlockedAmong(context.Context, int64, []int64) ([]int64, error) { return nil, nil }
func (f *fakeStore) BlockersAmong(context.Context, int64, []int64) ([]int64, error) {
	return nil, nil
}
func (f *fakeStore) DMPairBlocked(context.Context, int64) (bool, error) { return false, nil }

type rec struct {
	mu  sync.Mutex
	evs []events.Event
}

func (r *rec) Publish(e events.Event) { r.mu.Lock(); r.evs = append(r.evs, e); r.mu.Unlock() }

// users devolve, em ordem, "tipo->usuário" dos eventos publicados.
func (r *rec) log() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, e := range r.evs {
		out = append(out, e.Type+"->"+e.Topics[0])
	}
	return out
}

type noAvatars struct{}

func (noAvatars) AvatarURLForKey(context.Context, *string) string { return "" }

type deny struct{}

func (deny) Take(string) (bool, time.Duration) { return false, time.Second }

func setup() (*Service, *fakeStore, *rec) {
	st, r := newFake(), &rec{}
	return NewService(st, r, noAvatars{}, nil, nil), st, r
}

func kindOf(err error) apperr.Kind {
	if e, ok := apperr.As(err); ok {
		return e.Kind
	}
	return -1
}

var bg = context.Background()

func TestRequestAcceptFlowAndEvents(t *testing.T) {
	s, _, r := setup()
	p, err := s.Request(bg, 1, " @Beto ")
	if err != nil || p.Type != "outgoing" || p.User.ID != "2" {
		t.Fatalf("pedido = %+v %v", p, err)
	}
	if got := r.log(); !slices.Equal(got, []string{"RELATIONSHIP_ADD->user:1", "RELATIONSHIP_ADD->user:2"}) {
		t.Fatalf("eventos = %v", got)
	}
	// Repetir não gera evento novo.
	n := len(r.log())
	if _, err := s.Request(bg, 1, "beto"); err != nil || len(r.log()) != n {
		t.Fatal("repetir o pedido é idempotente e silencioso")
	}
	// Pedido inverso aceita.
	if p, err = s.Request(bg, 2, "ana"); err != nil || p.Type != "friend" {
		t.Fatalf("pedido inverso = %+v %v", p, err)
	}
	if got := r.log()[n:]; !slices.Equal(got, []string{"RELATIONSHIP_UPDATE->user:2", "RELATIONSHIP_UPDATE->user:1"}) {
		t.Fatalf("eventos do aceite = %v", got)
	}
}

func TestRequestValidation(t *testing.T) {
	s, _, _ := setup()
	for _, c := range []struct {
		name string
		want apperr.Kind
	}{{"ana", apperr.KindInvalid}, {"fantasma", apperr.KindNotFound}, {"  ", apperr.KindNotFound}} {
		if _, err := s.Request(bg, 1, c.name); kindOf(err) != c.want {
			t.Fatalf("Request(%q) = %v", c.name, err)
		}
	}
	s.requests = deny{}
	if _, err := s.Request(bg, 1, "beto"); kindOf(err) != apperr.KindRateLimited {
		t.Fatalf("limite: %v", err)
	}
}

func TestBlockedRequestLooksLikeSuccessAndIsSilent(t *testing.T) {
	s, st, r := setup()
	st.blocks[[2]int64{2, 1}] = true // beto bloqueou ana
	p, err := s.Request(bg, 1, "beto")
	if err != nil || p.Type != "outgoing" {
		t.Fatalf("resposta deve parecer um pedido enviado: %+v %v", p, err)
	}
	if len(r.log()) != 0 || len(st.friends) != 0 {
		t.Fatal("nada deve ser gravado nem avisado")
	}
	// Quem bloqueou recebe um erro claro.
	if _, err := s.Request(bg, 2, "ana"); kindOf(err) != apperr.KindConflict {
		t.Fatalf("quem bloqueou: %v", err)
	}
}

func TestRemoveEvents(t *testing.T) {
	s, st, r := setup()
	// Recusar (ana pediu, beto recusa): só beto é avisado.
	st.friends[pair(1, 2)] = struct {
		accepted bool
		by       int64
	}{false, 1}
	if err := s.Remove(bg, 2, 1); err != nil {
		t.Fatal(err)
	}
	if got := r.log(); !slices.Equal(got, []string{"RELATIONSHIP_REMOVE->user:2"}) {
		t.Fatalf("recusa avisou: %v", got)
	}
	// Cancelar (ana pediu e desiste) avisa os dois.
	r.evs = nil
	st.friends[pair(1, 2)] = struct {
		accepted bool
		by       int64
	}{false, 1}
	_ = s.Remove(bg, 1, 2)
	if got := r.log(); len(got) != 2 {
		t.Fatalf("cancelar: %v", got)
	}
	// Desfazer amizade avisa os dois; repetir é no-op; contra si mesmo é erro.
	r.evs = nil
	st.friends[pair(1, 2)] = struct {
		accepted bool
		by       int64
	}{true, 1}
	_ = s.Remove(bg, 2, 1)
	if got := r.log(); len(got) != 2 {
		t.Fatalf("desfazer: %v", got)
	}
	r.evs = nil
	if err := s.Remove(bg, 2, 1); err != nil || len(r.log()) != 0 {
		t.Fatal("remover de novo é idempotente")
	}
	if err := s.Remove(bg, 1, 1); kindOf(err) != apperr.KindInvalid {
		t.Fatalf("si mesmo: %v", err)
	}
}

func TestBlockUnblockEvents(t *testing.T) {
	s, st, r := setup()
	st.friends[pair(1, 2)] = struct {
		accepted bool
		by       int64
	}{true, 1}
	p, err := s.Block(bg, 1, 2)
	if err != nil || p.Type != "blocked" {
		t.Fatalf("block = %+v %v", p, err)
	}
	if got := r.log(); !slices.Equal(got, []string{"RELATIONSHIP_ADD->user:1", "RELATIONSHIP_REMOVE->user:2"}) {
		t.Fatalf("eventos do bloqueio = %v", got)
	}
	// Pedido do outro lado (beto pediu a ana, ana bloqueia): beto NÃO é avisado.
	r.evs = nil
	st.friends[pair(1, 3)] = struct {
		accepted bool
		by       int64
	}{false, 3}
	if _, err := s.Block(bg, 1, 3); err != nil {
		t.Fatal(err)
	}
	if got := r.log(); !slices.Equal(got, []string{"RELATIONSHIP_ADD->user:1"}) {
		t.Fatalf("bloquear quem pediu avisou o bloqueado: %v", got)
	}
	// Bloquear de novo: idempotente e silencioso.
	r.evs = nil
	if _, err := s.Block(bg, 1, 3); err != nil || len(r.log()) != 0 {
		t.Fatalf("bloqueio repetido: %v %v", err, r.log())
	}
	if _, err := s.Block(bg, 1, 1); kindOf(err) != apperr.KindInvalid {
		t.Fatal("si mesmo")
	}
	if _, err := s.Block(bg, 1, 99); kindOf(err) != apperr.KindNotFound {
		t.Fatal("inexistente")
	}
	if err := s.Unblock(bg, 1, 3); err != nil {
		t.Fatal(err)
	}
	if got := r.log(); !slices.Equal(got, []string{"RELATIONSHIP_REMOVE->user:1"}) {
		t.Fatalf("desbloqueio = %v", got)
	}
	r.evs = nil
	if err := s.Unblock(bg, 1, 3); err != nil || len(r.log()) != 0 {
		t.Fatal("desbloqueio repetido é no-op")
	}
}

func TestListKindValidation(t *testing.T) {
	s, _, _ := setup()
	if _, err := s.List(bg, 1, "lixo", 0, 10); kindOf(err) != apperr.KindInvalid {
		t.Fatalf("type inválido: %v", err)
	}
	if p, err := s.List(bg, 1, "friend", 0, 0); err != nil || p.Items == nil || p.NextAfter != nil {
		t.Fatalf("página vazia deve ter items [] e next_after nulo: %+v %v", p, err)
	}
}

func TestInviteFriendRules(t *testing.T) {
	s, st, _ := setup()
	if _, err := s.InviteFriend(bg, 1, 2, 10); kindOf(err) != apperr.KindUnavailable {
		t.Fatalf("sem configuração: %v", err)
	}
	g := &fakeGuilds{}
	inv := &fakeInvites{}
	dms := &fakeDMs{}
	msgs := &fakeMsgs{}
	s.SetInvites(g, inv, dms, msgs, "https://spook.exemplo.com/")
	// Não é amigo.
	s.store = &notFriendStore{fakeStore: st}
	if _, err := s.InviteFriend(bg, 1, 2, 10); kindOf(err) != apperr.KindForbidden {
		t.Fatalf("não amigo: %v", err)
	}
	s.store = st
	res, err := s.InviteFriend(bg, 1, 2, 10)
	if err != nil || res.Code != "CODE1234" || msgs.last != "Te convidei para um servidor: https://spook.exemplo.com/invite/CODE1234" {
		t.Fatalf("convite = %+v %v msg=%q", res, err, msgs.last)
	}
	g.member = true
	if _, err := s.InviteFriend(bg, 1, 2, 10); kindOf(err) != apperr.KindConflict {
		t.Fatalf("já é membro: %v", err)
	}
	g.member = false
	inv.err = apperr.Forbidden("sem permissão")
	if _, err := s.InviteFriend(bg, 1, 2, 10); kindOf(err) != apperr.KindForbidden || msgs.n != 1 {
		t.Fatalf("sem CREATE_INVITE: %v (mensagens %d)", err, msgs.n)
	}
	inv.err = nil
	dms.err = apperr.Forbidden("não foi possível abrir")
	if _, err := s.InviteFriend(bg, 1, 2, 10); kindOf(err) != apperr.KindForbidden || msgs.n != 1 {
		t.Fatalf("DM impossível: %v", err)
	}
}

type notFriendStore struct{ *fakeStore }

func (notFriendStore) Get(context.Context, int64, int64) (Kind, time.Time, error) {
	return KindNone, time.Time{}, nil
}

type fakeGuilds struct{ member bool }

func (f *fakeGuilds) IsMember(context.Context, int64, int64) (bool, error) { return f.member, nil }

type fakeInvites struct{ err error }

func (f *fakeInvites) Share(context.Context, int64, int64) (string, error) {
	return "CODE1234", f.err
}

type fakeDMs struct{ err error }

func (f *fakeDMs) OpenDM(context.Context, int64, int64) (int64, error) { return 500, f.err }

type fakeMsgs struct {
	last string
	n    int
}

func (f *fakeMsgs) SendText(_ context.Context, _, _ int64, c string) (int64, error) {
	f.last, f.n = c, f.n+1
	return 900, nil
}
