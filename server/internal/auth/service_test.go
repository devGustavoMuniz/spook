package auth

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/user"
)

type fakeUsers struct {
	mu     sync.Mutex
	byMail map[string]user.User
	hashes map[string]string
}

func newFakeUsers() *fakeUsers {
	return &fakeUsers{byMail: map[string]user.User{}, hashes: map[string]string{}}
}

func (f *fakeUsers) Create(_ context.Context, email, username, hash string) (user.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.byMail[email]; ok {
		return user.User{}, user.ErrEmailTaken
	}
	u := user.User{ID: int64(len(f.byMail) + 1), Email: email, Username: username}
	f.byMail[email], f.hashes[email] = u, hash
	return u, nil
}

func (f *fakeUsers) Credentials(_ context.Context, email string) (user.User, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	u, ok := f.byMail[email]
	if !ok {
		return user.User{}, "", user.ErrNotFound
	}
	return u, f.hashes[email], nil
}

func (f *fakeUsers) Get(_ context.Context, id int64) (user.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.byMail {
		if u.ID == id {
			return u, nil
		}
	}
	return user.User{}, user.ErrNotFound
}

func (f *fakeUsers) PasswordHash(_ context.Context, id int64) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for mail, u := range f.byMail {
		if u.ID == id {
			return f.hashes[mail], nil
		}
	}
	return "", user.ErrNotFound
}

func (f *fakeUsers) SetPasswordHash(_ context.Context, id int64, hash string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for mail, u := range f.byMail {
		if u.ID == id {
			f.hashes[mail] = hash
		}
	}
	return nil
}

type fakeSession struct {
	id        int64
	userID    int64
	expires   time.Time
	confirmed *time.Time
	remember  bool
	lastSeen  time.Time
	created   time.Time
	ua        *string
	slides    int
}

type fakeStore struct {
	mu       sync.Mutex
	sessions map[string]*fakeSession
	codes    map[string]*fakeCode
}

func (f *fakeStore) CreateSession(_ context.Context, id, userID int64, hash []byte, ua *string, remember bool, now, exp time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sessions == nil {
		f.sessions = map[string]*fakeSession{}
	}
	f.sessions[string(hash)] = &fakeSession{id: id, userID: userID, expires: exp, remember: remember, lastSeen: now, created: now, ua: ua}
	return nil
}

func (f *fakeStore) Session(_ context.Context, hash []byte) (SessionInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.sessions[string(hash)]
	if !ok {
		return SessionInfo{}, ErrUnauthorized
	}
	return SessionInfo{ID: s.id, UserID: s.userID, Expires: s.expires, ConfirmedAt: s.confirmed, Remember: s.remember, LastSeen: s.lastSeen, CreatedAt: s.created}, nil
}

func (f *fakeStore) SlideSession(_ context.Context, hash []byte, seen, exp, stale time.Time) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.sessions[string(hash)]
	if !ok || s.lastSeen.After(stale) {
		return false, nil
	}
	s.lastSeen, s.expires = seen, exp
	s.slides++
	return true, nil
}

func (f *fakeStore) ListSessions(_ context.Context, userID int64) ([]SessionRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []SessionRow
	for k, s := range f.sessions {
		if s.userID == userID {
			out = append(out, SessionRow{ID: s.id, TokenHash: []byte(k), UserAgent: s.ua, Remember: s.remember, CreatedAt: s.created, LastSeen: s.lastSeen, Expires: s.expires})
		}
	}
	return out, nil
}

func (f *fakeStore) DeleteSessionByID(_ context.Context, userID, id int64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for k, s := range f.sessions {
		if s.id == id && s.userID == userID {
			delete(f.sessions, k)
			return []byte(k), nil
		}
	}
	return nil, ErrSessionNotFound
}

func (f *fakeStore) ConfirmSession(_ context.Context, hash []byte, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s, ok := f.sessions[string(hash)]; ok {
		s.confirmed = &at
	}
	return nil
}

func (f *fakeStore) DeleteOtherSessions(_ context.Context, userID int64, keep []byte) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var n int64
	for k, s := range f.sessions {
		if s.userID == userID && k != string(keep) {
			delete(f.sessions, k)
			n++
		}
	}
	return n, nil
}

func (f *fakeStore) DeleteSession(_ context.Context, hash []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.sessions, string(hash))
	return nil
}

func (f *fakeStore) DeleteAllSessions(_ context.Context, userID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for k, s := range f.sessions {
		if s.userID == userID {
			delete(f.sessions, k)
		}
	}
	return nil
}

func (f *fakeStore) InsertDesktopCode(_ context.Context, hash []byte, userID int64, challenge string, exp time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.codes == nil {
		f.codes = map[string]*fakeCode{}
	}
	f.codes[string(hash)] = &fakeCode{userID: userID, challenge: challenge, expires: exp}
	return nil
}

func (f *fakeStore) ConsumeDesktopCode(_ context.Context, hash []byte) (int64, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.codes[string(hash)]
	if !ok || c.used || !c.expires.After(time.Now()) {
		return 0, "", ErrInvalidCode
	}
	c.used = true
	return c.userID, c.challenge, nil
}

type fakeCode struct {
	userID    int64
	challenge string
	expires   time.Time
	used      bool
}

func (f *fakeStore) DeleteExpired(context.Context) (int64, error) { return 0, nil }

type seq struct{ n int64 }

func (s *seq) Next() int64 { s.n++; return s.n }

func newSvc(t *testing.T) (*Service, *fakeStore) {
	t.Helper()
	st := &fakeStore{}
	svc, err := NewService(context.Background(), newFakeUsers(), st, NewHasher(2), &seq{})
	if err != nil {
		t.Fatal(err)
	}
	return svc, st
}

func TestRegisterLoginLogoutFlow(t *testing.T) {
	ctx := context.Background()
	svc, st := newSvc(t)

	u, tok, err := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if uid, err := svc.Authenticate(ctx, tok); err != nil || uid != u.ID {
		t.Fatalf("Authenticate após cadastro: uid=%d err=%v", uid, err)
	}
	for k := range st.sessions {
		if bytes.Contains([]byte(k), []byte(tok)) {
			t.Fatal("o token puro não pode ser salvo")
		}
	}

	if _, _, err := svc.Login(ctx, "a@b.com", "errada", nil, true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("senha errada: %v", err)
	}
	if _, _, err := svc.Login(ctx, "naoexiste@b.com", "qualquer", nil, true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("e-mail inexistente deve dar o mesmo erro: %v", err)
	}
	_, tok2, err := svc.Login(ctx, "a@b.com", "senha-forte-1", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if tok2 == tok {
		t.Fatal("cada login deve gerar um token novo")
	}

	if err := svc.Logout(ctx, tok2); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, tok2); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("token após logout deveria ser inválido: %v", err)
	}
	if _, err := svc.Authenticate(ctx, tok); err != nil {
		t.Fatalf("logout de uma sessão não pode derrubar as outras: %v", err)
	}
}

func TestRegisterDuplicateEmail(t *testing.T) {
	svc, _ := newSvc(t)
	if _, _, err := svc.Register(context.Background(), "a@b.com", "ana", "senha-forte-1", nil, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Register(context.Background(), "a@b.com", "ana2", "senha-forte-1", nil, true); !errors.Is(err, user.ErrEmailTaken) {
		t.Fatalf("esperava ErrEmailTaken, veio %v", err)
	}
}

func TestAuthenticateRejectsExpiredAndEmpty(t *testing.T) {
	ctx := context.Background()
	svc, _ := newSvc(t)
	_, tok, _ := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil, true)

	svc.now = func() time.Time { return time.Now().Add(SessionTTL + time.Minute) }
	if _, err := svc.Authenticate(ctx, tok); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("sessão expirada deveria ser recusada: %v", err)
	}
	if _, err := svc.Authenticate(ctx, ""); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("token vazio deveria ser recusado: %v", err)
	}
}

func TestChangePasswordKeepsCurrentSessionAndDropsOthers(t *testing.T) {
	ctx := context.Background()
	svc, _ := newSvc(t)
	u, tok, err := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	_, other, _ := svc.Login(ctx, "a@b.com", "senha-forte-1", nil, true)
	var gotUser int64
	var gotKeep string
	svc.OnRevoke(func(uid int64, keep string) { gotUser, gotKeep = uid, keep })

	if err := svc.ChangePassword(ctx, u.ID, tok, "errada", "outra-senha-2"); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("senha atual errada: %v", err)
	}
	if err := svc.ChangePassword(ctx, u.ID, tok, "senha-forte-1", "curta"); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("senha fraca: %v", err)
	}
	if err := svc.ChangePassword(ctx, u.ID, tok, "senha-forte-1", "senha-forte-1"); !errors.Is(err, ErrSamePassword) {
		t.Fatalf("mesma senha: %v", err)
	}
	if err := svc.ChangePassword(ctx, u.ID, tok, "senha-forte-1", "outra-senha-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, tok); err != nil {
		t.Fatalf("a sessão atual deve continuar: %v", err)
	}
	if _, err := svc.Authenticate(ctx, other); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("as outras sessões devem cair: %v", err)
	}
	if gotUser != u.ID || gotKeep != TokenKey(tok) {
		t.Fatalf("gateway deveria ser avisado mantendo só a sessão atual: %d %q", gotUser, gotKeep)
	}
	if _, _, err := svc.Login(ctx, "a@b.com", "outra-senha-2", nil, true); err != nil {
		t.Fatalf("login com a senha nova: %v", err)
	}
	if _, _, err := svc.Login(ctx, "a@b.com", "senha-forte-1", nil, true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("a senha antiga não pode mais valer: %v", err)
	}
}

func TestConfirmPasswordWindow(t *testing.T) {
	ctx := context.Background()
	svc, _ := newSvc(t)
	u, tok, _ := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil, true)
	if ok, _ := svc.RecentlyConfirmed(ctx, tok); ok {
		t.Fatal("sessão nova não está confirmada")
	}
	if _, err := svc.ConfirmPassword(ctx, u.ID, tok, "errada"); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("senha errada: %v", err)
	}
	until, err := svc.ConfirmPassword(ctx, u.ID, tok, "senha-forte-1")
	if err != nil || !until.After(time.Now()) {
		t.Fatalf("confirmar: %v %v", until, err)
	}
	if ok, _ := svc.RecentlyConfirmed(ctx, tok); !ok {
		t.Fatal("deveria estar confirmada")
	}
	svc.now = func() time.Time { return time.Now().Add(ConfirmTTL + time.Second) }
	if ok, _ := svc.RecentlyConfirmed(ctx, tok); ok {
		t.Fatal("a confirmação deve expirar em 10 min")
	}
}

func TestRegisterRejectsReservedUsernameAndShortPassword(t *testing.T) {
	svc, _ := newSvc(t)
	for _, name := range []string{"admin", "ADMIN", "Spook", "everyone", "removido_5"} {
		if _, _, err := svc.Register(context.Background(), name+"@b.com", name, "senha-forte-1", nil, true); !errors.Is(err, user.ErrReservedUsername) {
			t.Fatalf("%q deveria ser reservado: %v", name, err)
		}
	}
	if _, _, err := svc.Register(context.Background(), "a@b.com", "ana", "curta", nil, true); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("senha curta: %v", err)
	}
}

func TestRegisterCallsAccountCreatedHookBeforeSessionAndLoginDoesNot(t *testing.T) {
	svc, _ := newSvc(t)
	var created []int64
	svc.OnAccountCreated(func(_ context.Context, id int64) { created = append(created, id) })
	u, _, err := svc.Register(context.Background(), "novo@x.com", "novo", "senha-longa-123", nil, true)
	if err != nil || len(created) != 1 || created[0] != u.ID {
		t.Fatalf("cadastro deve chamar o gancho uma vez: %v %v", created, err)
	}
	if _, _, err := svc.Login(context.Background(), "novo@x.com", "senha-longa-123", nil, true); err != nil || len(created) != 1 {
		t.Fatalf("login em conta existente não chama o gancho: %v %v", created, err)
	}
}
