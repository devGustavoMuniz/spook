package user

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

type memStore struct{ u User }

func (m *memStore) Create(context.Context, int64, string, string, string) (User, error) {
	return m.u, nil
}
func (m *memStore) ByID(context.Context, int64) (User, error)             { return m.u, nil }
func (m *memStore) ByEmail(context.Context, string) (User, string, error) { return m.u, "", nil }
func (m *memStore) UpdateProfile(_ context.Context, _ int64, p ProfileFields) (User, error) {
	m.u.DisplayName, m.u.AvatarKey, m.u.Bio, m.u.Pronouns, m.u.BannerKey, m.u.BannerColor =
		p.DisplayName, p.AvatarKey, p.Bio, p.Pronouns, p.BannerKey, p.BannerColor
	return m.u, nil
}
func (m *memStore) UpdateEmail(_ context.Context, _ int64, email string) (User, error) {
	m.u.Email = email
	return m.u, nil
}
func (m *memStore) PasswordHash(context.Context, int64) (string, error)  { return "", nil }
func (m *memStore) SetPasswordHash(context.Context, int64, string) error { return nil }

type fakeStorage struct{ lastSize int64 }

func (f *fakeStorage) PresignPut(_ context.Context, key, _ string, size int64, _ time.Duration) (string, error) {
	f.lastSize = size
	return "https://s3/put/" + key, nil
}
func (f *fakeStorage) PresignGet(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://s3/get/" + key, nil
}

func (f *fakeStorage) Get(context.Context, string, int64) ([]byte, error) { return nil, ErrNotFound }
func (f *fakeStorage) Put(context.Context, string, string, []byte) error  { return nil }
func (f *fakeStorage) Delete(context.Context, string) error               { return nil }

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
	}{{"image/svg+xml", 10}, {"text/html", 10}, {"image/png", 0}, {"image/png", MaxAvatarBytes + 1}} {
		if _, err := svc.RequestAvatarUpload(ctx, 7, c.ct, c.size); !errors.Is(err, ErrInvalidAvatar) {
			t.Fatalf("%+v deveria ser recusado, veio %v", c, err)
		}
	}
}

func TestAnimatedImagesAreAccepted(t *testing.T) {
	svc := NewService(&memStore{u: User{ID: 7}}, &fakeStorage{}, &seq{})
	for _, ct := range []string{"image/gif", "image/webp"} {
		if up, err := svc.RequestAvatarUpload(context.Background(), 7, ct, 1000); err != nil || up.Key == "" {
			t.Fatalf("avatar %s: %v", ct, err)
		}
		if up, err := svc.RequestBannerUpload(context.Background(), 7, ct, 1000); err != nil || !strings.HasPrefix(up.Key, "banners/7/") {
			t.Fatalf("banner %s: %+v %v", ct, up, err)
		}
	}
	if _, err := svc.RequestBannerUpload(context.Background(), 7, "image/png", MaxAvatarBytes+1); !errors.Is(err, ErrInvalidBanner) {
		t.Fatalf("banner grande demais: %v", err)
	}
}

func TestProfileBioPronounsAndBanner(t *testing.T) {
	svc := NewService(&memStore{u: User{ID: 7}}, &fakeStorage{}, &seq{})
	ctx := context.Background()

	u, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{Bio: ptr("  oi\x00 mundo\nlinha 2  "), Pronouns: ptr("ela/dela")})
	if err != nil || u.Bio == nil || *u.Bio != "oi mundo\nlinha 2" || *u.Pronouns != "ela/dela" {
		t.Fatalf("bio/pronomes: %+v %v", u, err)
	}
	if _, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{Bio: ptr(strings.Repeat("a", MaxBioRunes+1))}); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("bio longa: %v", err)
	}
	if _, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{Pronouns: ptr(strings.Repeat("é", MaxPronounsRunes+1))}); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("pronomes longos: %v", err)
	}
	if _, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{Bio: ptr(strings.Repeat("é", MaxBioRunes))}); err != nil {
		t.Fatalf("190 runes devem caber: %v", err)
	}
	u, _ = svc.UpdateProfile(ctx, 7, ProfileUpdate{Bio: ptr("  ")})
	if u.Bio != nil {
		t.Fatal("bio em branco remove")
	}

	color := int32(0xFF8800)
	u, err = svc.UpdateProfile(ctx, 7, ProfileUpdate{BannerColor: &color})
	if err != nil || u.BannerColor == nil || u.BannerKey != nil {
		t.Fatalf("cor: %+v %v", u, err)
	}
	u, err = svc.UpdateProfile(ctx, 7, ProfileUpdate{BannerKey: ptr("banners/7/1.png")})
	if err != nil || u.BannerKey == nil || u.BannerColor != nil {
		t.Fatalf("imagem deve limpar a cor: %+v %v", u, err)
	}
	if _, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{BannerKey: ptr("banners/8/1.png")}); !errors.Is(err, ErrInvalidBanner) {
		t.Fatalf("chave de outro usuário: %v", err)
	}
	if _, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{BannerKey: ptr("banners/7/1.png"), BannerColor: &color}); !errors.Is(err, ErrInvalidBanner) {
		t.Fatalf("imagem E cor: %v", err)
	}
	bad := int32(1 << 25)
	if _, err := svc.UpdateProfile(ctx, 7, ProfileUpdate{BannerColor: &bad}); !errors.Is(err, ErrInvalidBanner) {
		t.Fatalf("cor fora da faixa: %v", err)
	}
	u, _ = svc.UpdateProfile(ctx, 7, ProfileUpdate{RemoveBanner: true})
	if u.BannerKey != nil || u.BannerColor != nil {
		t.Fatal("RemoveBanner limpa imagem e cor")
	}
}

func TestChangeEmail(t *testing.T) {
	svc := NewService(&memStore{u: User{ID: 7, Email: "a@b.com"}}, nil, &seq{})
	ctx := context.Background()
	for _, bad := range []string{"", "sem-arroba", "a@b", "Nome <a@b.com>", strings.Repeat("a", 250) + "@b.com"} {
		if _, err := svc.ChangeEmail(ctx, 7, bad); !errors.Is(err, ErrInvalidEmail) {
			t.Fatalf("%q deveria ser inválido: %v", bad, err)
		}
	}
	u, err := svc.ChangeEmail(ctx, 7, " novo@b.com ")
	if err != nil || u.Email != "novo@b.com" {
		t.Fatalf("troca: %+v %v", u, err)
	}
	svc.SetEmailChangeVerifier(pending{})
	if _, err := svc.ChangeEmail(ctx, 7, "outro@b.com"); !errors.Is(err, ErrEmailVerificationPending) {
		t.Fatalf("com verificador pendente: %v", err)
	}
}

type pending struct{}

func (pending) Begin(context.Context, int64, string) (bool, error) { return false, nil }

func TestReservedUsernames(t *testing.T) {
	for _, n := range []string{"admin", "ROOT", "Spook", "suporte", "support", "system", "everyone", "here", "moderator", "mod", "staff", "null", "undefined", "api", "www", "removido_123"} {
		if !IsReservedUsername(n) {
			t.Errorf("%q deveria ser reservado", n)
		}
	}
	for _, n := range []string{"ana", "admin2", "spook_fan", "gustavo"} {
		if IsReservedUsername(n) {
			t.Errorf("%q não deveria ser reservado", n)
		}
	}
}

type fakeAudience struct{ guilds, peers []int64 }

func (f fakeAudience) Audience(context.Context, int64) ([]int64, []int64, error) {
	return f.guilds, f.peers, nil
}

type capturePub struct{ evs []events.Event }

func (c *capturePub) Publish(e events.Event) { c.evs = append(c.evs, e) }

func TestUpdateProfilePublishesUserUpdate(t *testing.T) {
	pub := &capturePub{}
	svc := NewService(&memStore{u: User{ID: 7, Username: "ana"}}, &fakeStorage{}, &seq{}).
		WithEvents(pub, fakeAudience{guilds: []int64{100, 101}, peers: []int64{55}})

	if _, err := svc.UpdateProfile(context.Background(), 7, ProfileUpdate{
		DisplayName: ptr("Ana Nova"), AvatarKey: ptr("avatars/7/9.gif"),
	}); err != nil {
		t.Fatal(err)
	}
	if len(pub.evs) != 1 || pub.evs[0].Type != events.UserUpdate {
		t.Fatalf("esperava 1 USER_UPDATE, veio %+v", pub.evs)
	}
	ev := pub.evs[0]
	want := []string{"user:7", "guild:100", "guild:101", "user:55"}
	if len(ev.Topics) != len(want) {
		t.Fatalf("tópicos = %v, quero %v", ev.Topics, want)
	}
	for i := range want {
		if ev.Topics[i] != want[i] {
			t.Fatalf("tópicos = %v, quero %v", ev.Topics, want)
		}
	}
	p, ok := ev.Data.(UpdatePayload)
	if !ok || p.ID != "7" || p.Username != "ana" || p.DisplayName != "Ana Nova" || p.AvatarURL != "https://s3/get/avatars/7/9.gif" {
		t.Fatalf("payload inesperado: %+v", ev.Data)
	}
}

func TestUpdateProfileInvalidDoesNotPublish(t *testing.T) {
	pub := &capturePub{}
	svc := NewService(&memStore{u: User{ID: 7}}, &fakeStorage{}, &seq{}).WithEvents(pub, fakeAudience{})
	if _, err := svc.UpdateProfile(context.Background(), 7, ProfileUpdate{AvatarKey: ptr("avatars/999/x.png")}); err == nil {
		t.Fatal("chave de outro usuário deveria falhar")
	}
	if len(pub.evs) != 0 {
		t.Fatalf("falha não publica: %+v", pub.evs)
	}
}
