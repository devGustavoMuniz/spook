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

func (f *fakeUsers) Get(context.Context, int64) (user.User, error) { return user.User{}, nil }

type fakeStore struct {
	mu       sync.Mutex
	sessions map[string]struct {
		userID  int64
		expires time.Time
	}
}

func (f *fakeStore) CreateSession(_ context.Context, _, userID int64, hash []byte, _ *string, exp time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sessions == nil {
		f.sessions = map[string]struct {
			userID  int64
			expires time.Time
		}{}
	}
	f.sessions[string(hash)] = struct {
		userID  int64
		expires time.Time
	}{userID, exp}
	return nil
}

func (f *fakeStore) Session(_ context.Context, hash []byte) (int64, time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.sessions[string(hash)]
	if !ok {
		return 0, time.Time{}, ErrUnauthorized
	}
	return s.userID, s.expires, nil
}

func (f *fakeStore) DeleteSession(_ context.Context, hash []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.sessions, string(hash))
	return nil
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

	u, tok, err := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil)
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

	if _, _, err := svc.Login(ctx, "a@b.com", "errada", nil); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("senha errada: %v", err)
	}
	if _, _, err := svc.Login(ctx, "naoexiste@b.com", "qualquer", nil); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("e-mail inexistente deve dar o mesmo erro: %v", err)
	}
	_, tok2, err := svc.Login(ctx, "a@b.com", "senha-forte-1", nil)
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
	if _, _, err := svc.Register(context.Background(), "a@b.com", "ana", "senha-forte-1", nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Register(context.Background(), "a@b.com", "ana2", "senha-forte-1", nil); !errors.Is(err, user.ErrEmailTaken) {
		t.Fatalf("esperava ErrEmailTaken, veio %v", err)
	}
}

func TestAuthenticateRejectsExpiredAndEmpty(t *testing.T) {
	ctx := context.Background()
	svc, _ := newSvc(t)
	_, tok, _ := svc.Register(ctx, "a@b.com", "ana", "senha-forte-1", nil)

	svc.now = func() time.Time { return time.Now().Add(SessionTTL + time.Minute) }
	if _, err := svc.Authenticate(ctx, tok); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("sessão expirada deveria ser recusada: %v", err)
	}
	if _, err := svc.Authenticate(ctx, ""); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("token vazio deveria ser recusado: %v", err)
	}
}
