package user

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
)

type fixedPlan struct{ tier plan.Tier }

func (f fixedPlan) Tier(context.Context, int64) (plan.Tier, error) { return f.tier, nil }

type objStorage struct {
	fakeStorage
	objs map[string][]byte
}

func (o *objStorage) Get(_ context.Context, key string, _ int64) ([]byte, error) {
	if b, ok := o.objs[key]; ok {
		return b, nil
	}
	return nil, ErrNotFound
}

func pngBytes(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func newNitroSvc(t *testing.T, tier plan.Tier, objs map[string][]byte) *Service {
	t.Helper()
	return NewService(&memStore{u: User{ID: 7, Username: "ana"}}, &objStorage{objs: objs}, &seq{}).WithPlans(fixedPlan{tier})
}

func TestGIFUploadRequiresNitro(t *testing.T) {
	ctx := context.Background()
	free := newNitroSvc(t, plan.Free, nil)
	if _, err := free.RequestAvatarUpload(ctx, 7, "image/gif", 100); !errors.Is(err, ErrNitroRequired) {
		t.Fatalf("avatar GIF sem Nitro = %v", err)
	}
	if _, err := free.RequestBannerUpload(ctx, 7, "image/gif", 100); !errors.Is(err, ErrNitroRequired) {
		t.Fatalf("banner GIF sem Nitro = %v", err)
	}
	// Estáticos continuam livres, inclusive WebP e PNG (a checagem por bytes vem no PATCH).
	for _, ct := range []string{"image/png", "image/jpeg", "image/webp"} {
		if _, err := free.RequestAvatarUpload(ctx, 7, ct, 100); err != nil {
			t.Fatalf("%s sem Nitro deveria passar: %v", ct, err)
		}
	}
	for _, tier := range []plan.Tier{plan.Nitro, plan.NitroPlus} {
		s := newNitroSvc(t, tier, nil)
		if _, err := s.RequestAvatarUpload(ctx, 7, "image/gif", 100); err != nil {
			t.Fatalf("%s deveria aceitar GIF: %v", tier, err)
		}
	}
}

func TestProfileKeyChecksBytesWithoutNitro(t *testing.T) {
	ctx := context.Background()
	gifB := gifBytes(t, 1)
	objs := map[string][]byte{
		"avatars/7/1.png":  pngBytes(t), // declarado PNG, mas...
		"avatars/7/2.png":  gifB,        // ...um GIF disfarçado de PNG
		"avatars/7/3.webp": webp(0x02, true),
		"banners/7/4.png":  gifB,
		"banners/7/5.png":  pngBytes(t),
	}
	free := newNitroSvc(t, plan.Free, objs)
	if _, err := free.UpdateProfile(ctx, 7, ProfileUpdate{AvatarKey: ptr("avatars/7/1.png")}); err != nil {
		t.Fatalf("PNG estático sem Nitro: %v", err)
	}
	if _, err := free.UpdateProfile(ctx, 7, ProfileUpdate{AvatarKey: ptr("avatars/7/2.png")}); !errors.Is(err, ErrNitroRequired) {
		t.Fatalf("GIF disfarçado de PNG sem Nitro = %v", err)
	}
	if _, err := free.UpdateProfile(ctx, 7, ProfileUpdate{AvatarKey: ptr("avatars/7/3.webp")}); !errors.Is(err, ErrNitroRequired) {
		t.Fatalf("WebP animado sem Nitro = %v", err)
	}
	if _, err := free.UpdateProfile(ctx, 7, ProfileUpdate{BannerKey: ptr("banners/7/4.png")}); !errors.Is(err, ErrNitroRequired) {
		t.Fatalf("banner GIF sem Nitro = %v", err)
	}
	if _, err := free.UpdateProfile(ctx, 7, ProfileUpdate{BannerKey: ptr("banners/7/5.png")}); err != nil {
		t.Fatalf("banner estático sem Nitro: %v", err)
	}
	if _, err := free.UpdateProfile(ctx, 7, ProfileUpdate{AvatarKey: ptr("avatars/7/9.png")}); !errors.Is(err, ErrInvalidAvatar) {
		t.Fatalf("objeto ausente sem Nitro = %v", err)
	}
	// Com Nitro, nada é inspecionado.
	paid := newNitroSvc(t, plan.Nitro, objs)
	if _, err := paid.UpdateProfile(ctx, 7, ProfileUpdate{AvatarKey: ptr("avatars/7/3.webp")}); err != nil {
		t.Fatalf("WebP animado com Nitro: %v", err)
	}
	// Sem mudar a chave (já guardada de quando tinha plano), o PATCH de outros campos passa mesmo no grátis.
	store := &memStore{u: User{ID: 7, AvatarKey: ptr("avatars/7/2.png")}}
	lapsed := NewService(store, &objStorage{objs: objs}, &seq{}).WithPlans(fixedPlan{plan.Free})
	if _, err := lapsed.UpdateProfile(ctx, 7, ProfileUpdate{Bio: ptr("oi"), AvatarKey: ptr("avatars/7/2.png")}); err != nil {
		t.Fatalf("manter a chave atual não deve exigir Nitro: %v", err)
	}
	// Sem planos ligados (testes e ferramentas), nenhuma regra.
	open := NewService(&memStore{u: User{ID: 7}}, &objStorage{objs: objs}, &seq{})
	if _, err := open.UpdateProfile(ctx, 7, ProfileUpdate{AvatarKey: ptr("avatars/7/2.png")}); err != nil {
		t.Fatalf("sem PlanSource: %v", err)
	}
}

func TestCropRequiresNitro(t *testing.T) {
	free := newNitroSvc(t, plan.Free, nil)
	if _, err := free.CropImage(context.Background(), 7, "avatars/7/1.gif", image.Rect(0, 0, 2, 2)); !errors.Is(err, ErrNitroRequired) {
		t.Fatalf("crop sem Nitro = %v", err)
	}
}

func TestPayloadAndViewCarryPlan(t *testing.T) {
	ctx := context.Background()
	for _, tier := range []plan.Tier{plan.Free, plan.Nitro, plan.NitroPlus} {
		s := newNitroSvc(t, tier, nil)
		if got := s.Payload(ctx, User{ID: 7}).Plan; got != string(tier) {
			t.Fatalf("Payload.Plan = %q, esperado %q", got, tier)
		}
	}
	none := NewService(&memStore{}, nil, &seq{})
	if got := none.Payload(ctx, User{ID: 7}).Plan; got != "free" {
		t.Fatalf("sem PlanSource = %q", got)
	}
}
