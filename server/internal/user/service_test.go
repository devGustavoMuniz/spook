package user

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type memStore struct{ u User }

func (m *memStore) Create(context.Context, int64, string, string, string) (User, error) {
	return m.u, nil
}
func (m *memStore) ByID(context.Context, int64) (User, error)             { return m.u, nil }
func (m *memStore) ByEmail(context.Context, string) (User, string, error) { return m.u, "", nil }
func (m *memStore) UpdateProfile(_ context.Context, _ int64, dn, ak *string) (User, error) {
	m.u.DisplayName, m.u.AvatarKey = dn, ak
	return m.u, nil
}

type fakeStorage struct{ lastSize int64 }

func (f *fakeStorage) PresignPut(_ context.Context, key, _ string, size int64, _ time.Duration) (string, error) {
	f.lastSize = size
	return "https://s3/put/" + key, nil
}
func (f *fakeStorage) PresignGet(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://s3/get/" + key, nil
}

type seq struct{ n int64 }

func (s *seq) Next() int64 { s.n++; return s.n }

func ptr(s string) *string { return &s }

func TestUpdateProfileDisplayName(t *testing.T) {
	svc := NewService(&memStore{u: User{ID: 7, DisplayName: ptr("Antigo")}}, nil, &seq{})
	ctx := context.Background()

	u, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{DisplayName: ptr("  Novo Nome  ")})
	if err != nil || u.DisplayName == nil || *u.DisplayName != "Novo Nome" {
		t.Fatalf("deveria aparar espaços: %+v err=%v", u.DisplayName, err)
	}
	u, _ = svc.UpdateProfile(ctx, 7, ProfileUpdate{DisplayName: ptr("   ")})
	if u.DisplayName != nil {
		t.Fatal("nome em branco deveria remover o display_name")
	}
	u, _ = svc.UpdateProfile(ctx, 7, ProfileUpdate{})
	if u.DisplayName != nil {
		t.Fatal("sem campos não deveria alterar nada")
	}
}

func TestAvatarKeyMustBelongToUser(t *testing.T) {
	svc := NewService(&memStore{u: User{ID: 7}}, &fakeStorage{}, &seq{})
	ctx := context.Background()

	if _, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{AvatarKey: ptr("avatars/8/1.png")}); !errors.Is(err, ErrInvalidAvatar) {
		t.Fatalf("chave de outro usuário deveria ser recusada: %v", err)
	}
	if _, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{AvatarKey: ptr("../etc/passwd")}); !errors.Is(err, ErrInvalidAvatar) {
		t.Fatalf("chave arbitrária deveria ser recusada: %v", err)
	}
	u, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{AvatarKey: ptr("avatars/7/1.png")})
	if err != nil || u.AvatarKey == nil {
		t.Fatalf("chave própria deveria ser aceita: %v", err)
	}
	u, _ = svc.UpdateProfile(ctx, 7, ProfileUpdate{RemoveAvatar: true})
	if u.AvatarKey != nil {
		t.Fatal("RemoveAvatar deveria limpar a chave")
	}
}

func TestRequestAvatarUploadValidation(t *testing.T) {
	st := &fakeStorage{}
	svc := NewService(&memStore{u: User{ID: 7}}, st, &seq{})
	ctx := context.Background()

	up, err := svc.RequestAvatarUpload(ctx, 7, "image/png", 1234)
	if err != nil || !strings.HasPrefix(up.Key, "avatars/7/") || !strings.HasSuffix(up.Key, ".png") || st.lastSize != 1234 {
		t.Fatalf("upload válido falhou: %+v err=%v", up, err)
	}
	for _, c := range []struct {
		ct   string
		size int64
	}{{"image/gif", 10}, {"text/html", 10}, {"image/png", 0}, {"image/png", MaxAvatarBytes + 1}} {
		if _, err := svc.RequestAvatarUpload(ctx, 7, c.ct, c.size); !errors.Is(err, ErrInvalidAvatar) {
			t.Fatalf("%+v deveria ser recusado, veio %v", c, err)
		}
	}
}
