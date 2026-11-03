package invite

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

type fakeStore struct {
	invites   map[string]Invite
	collide   int // quantas criações devolvem ErrCodeTaken antes de passar
	redeemRes RedeemResult
	redeemErr error
	deleted   []string
	count     int
}

func newStore() *fakeStore { return &fakeStore{invites: map[string]Invite{}} }

func (f *fakeStore) Create(_ context.Context, i Invite) (Invite, error) {
	if f.collide > 0 {
		f.collide--
		return Invite{}, ErrCodeTaken
	}
	i.CreatedAt = time.Now()
	f.invites[i.Code] = i
	return i, nil
}
func (f *fakeStore) Get(_ context.Context, code string) (Invite, error) {
	i, ok := f.invites[code]
	if !ok {
		return Invite{}, ErrNotFound
	}
	return i, nil
}
func (f *fakeStore) List(context.Context, int64) ([]Invite, error) { return nil, nil }
func (f *fakeStore) Count(context.Context, int64) (int, error)     { return f.count, nil }
func (f *fakeStore) Delete(_ context.Context, code string) error {
	f.deleted = append(f.deleted, code)
	delete(f.invites, code)
	return nil
}
func (f *fakeStore) Preview(_ context.Context, code string) (Preview, error) {
	i, ok := f.invites[code]
	if !ok {
		return Preview{}, ErrNotFound
	}
	return Preview{Invite: i, GuildName: "G", MemberCount: 3}, nil
}
func (f *fakeStore) Redeem(context.Context, string, int64) (RedeemResult, error) {
	return f.redeemRes, f.redeemErr
}

type fakeAccess map[int64]perm.Member

func (f fakeAccess) Member(_ context.Context, _, userID int64) (perm.Member, error) {
	m, ok := f[userID]
	if !ok {
		return perm.Member{}, perm.ErrNotMember
	}
	return m, nil
}

type fakeGuilds struct{ joined, got int }

func (f *fakeGuilds) PublishJoined(context.Context, int64, int64) (guild.Detail, error) {
	f.joined++
	return guild.Detail{}, nil
}
func (f *fakeGuilds) Get(context.Context, int64, int64) (guild.Detail, error) {
	f.got++
	return guild.Detail{}, nil
}

type noIcons struct{}

func (noIcons) IconURL(context.Context, *string) string { return "" }

const (
	owner, member, noInvitePerm, stranger = 1, 2, 3, 4
)

func setup() (*Service, *fakeStore, *fakeGuilds) {
	st, g := newStore(), &fakeGuilds{}
	acc := fakeAccess{
		owner:        perm.NewMember(owner, true, 0, 0),
		member:       perm.NewMember(member, false, perm.DefaultEveryone, 0),
		noInvitePerm: perm.NewMember(noInvitePerm, false, perm.ViewChannel, 0),
	}
	return NewService(st, acc, g, noIcons{}), st, g
}

func TestCodeFormat(t *testing.T) {
	seen := map[string]bool{}
	for range 2000 {
		c, err := newCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(c) != CodeLength || strings.Trim(c, codeAlphabet) != "" {
			t.Fatalf("código fora do formato: %q", c)
		}
		seen[c] = true
	}
	if len(seen) < 1990 {
		t.Fatalf("códigos se repetem demais: %d únicos de 2000", len(seen))
	}
}

func TestCreate(t *testing.T) {
	svc, st, _ := setup()
	ctx := context.Background()
	inv, err := svc.Create(ctx, member, 1, CreateParams{})
	if err != nil || len(inv.Code) != 8 || inv.MaxUses != nil || inv.ExpiresAt != nil || inv.CreatorID != member {
		t.Fatalf("convite padrão: %+v %v", inv, err)
	}
	two, hour := int32(2), time.Hour
	inv, err = svc.Create(ctx, owner, 1, CreateParams{MaxUses: &two, ExpiresIn: &hour})
	if err != nil || *inv.MaxUses != 2 || inv.ExpiresAt == nil || time.Until(*inv.ExpiresAt) < 59*time.Minute {
		t.Fatalf("convite com limites: %+v %v", inv, err)
	}
	if _, err := svc.Create(ctx, noInvitePerm, 1, CreateParams{}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("sem CREATE_INVITE: %v", err)
	}
	if _, err := svc.Create(ctx, stranger, 1, CreateParams{}); !errors.Is(err, guild.ErrNotFound) {
		t.Fatalf("não-membro: %v", err)
	}
	zero, tooLong, tiny := int32(0), 31*24*time.Hour, time.Millisecond
	for _, p := range []CreateParams{{MaxUses: &zero}, {ExpiresIn: &tooLong}, {ExpiresIn: &tiny}} {
		if _, err := svc.Create(ctx, owner, 1, p); !apperr.IsKind(err, apperr.KindInvalid) {
			t.Fatalf("parâmetros inválidos %+v: %v", p, err)
		}
	}
	// colisão de código: tenta de novo
	st.collide = 3
	if _, err := svc.Create(ctx, owner, 1, CreateParams{}); err != nil {
		t.Fatalf("deveria tentar outro código: %v", err)
	}
	st.collide = 100
	if _, err := svc.Create(ctx, owner, 1, CreateParams{}); err == nil {
		t.Fatal("esgotadas as tentativas deveria falhar")
	}
}

func TestInviteValid(t *testing.T) {
	now := time.Now()
	past, future := now.Add(-time.Second), now.Add(time.Hour)
	one := int32(1)
	tests := []struct {
		name string
		inv  Invite
		want bool
	}{
		{"sem limites", Invite{}, true},
		{"expira no futuro", Invite{ExpiresAt: &future}, true},
		{"expirado", Invite{ExpiresAt: &past}, false},
		{"expira agora", Invite{ExpiresAt: &now}, false},
		{"usos sobrando", Invite{MaxUses: &one}, true},
		{"esgotado", Invite{MaxUses: &one, Uses: 1}, false},
	}
	for _, tt := range tests {
		if got := tt.inv.Valid(now); got != tt.want {
			t.Errorf("%s: Valid = %v, quer %v", tt.name, got, tt.want)
		}
	}
}

func TestPeekAndJoin(t *testing.T) {
	svc, st, g := setup()
	ctx := context.Background()
	past := time.Now().Add(-time.Minute)
	st.invites["valido123"[:8]] = Invite{Code: "valido12", GuildID: 1}
	st.invites["expirado"] = Invite{Code: "expirado", GuildID: 1, ExpiresAt: &past}

	p, _, err := svc.Peek(ctx, "valido12")
	if err != nil || p.GuildName != "G" || p.MemberCount != 3 {
		t.Fatalf("Peek: %+v %v", p, err)
	}
	if _, _, err := svc.Peek(ctx, "expirado"); !errors.Is(err, ErrGone) {
		t.Fatalf("expirado: %v", err)
	}
	if _, _, err := svc.Peek(ctx, "naoexiste"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("inexistente: %v", err)
	}

	// entrou de fato: publica eventos; já era membro: só devolve o servidor, sem eventos
	st.redeemRes = RedeemResult{GuildID: 1, Joined: true}
	if _, err := svc.Join(ctx, stranger, "valido12"); err != nil || g.joined != 1 || g.got != 0 {
		t.Fatalf("entrada nova: joined=%d got=%d %v", g.joined, g.got, err)
	}
	st.redeemRes = RedeemResult{GuildID: 1}
	if _, err := svc.Join(ctx, member, "valido12"); err != nil || g.joined != 1 || g.got != 1 {
		t.Fatalf("já membro: joined=%d got=%d %v", g.joined, g.got, err)
	}
	for _, want := range []error{ErrGone, ErrNotFound, guild.ErrTooManyGuilds} {
		st.redeemErr = want
		if _, err := svc.Join(ctx, stranger, "valido12"); !errors.Is(err, want) {
			t.Fatalf("esperava %v, veio %v", want, err)
		}
	}
	if g.joined != 1 {
		t.Fatal("falha na entrada não pode publicar")
	}
}

func TestRevoke(t *testing.T) {
	svc, st, _ := setup()
	ctx := context.Background()
	mine := Invite{Code: "doMember", GuildID: 1, CreatorID: member}
	st.invites["doMember"] = mine
	st.invites["doOwner1"] = Invite{Code: "doOwner1", GuildID: 1, CreatorID: owner}

	if err := svc.Revoke(ctx, noInvitePerm, "doOwner1"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("membro comum revogando convite alheio: %v", err)
	}
	if err := svc.Revoke(ctx, member, "doOwner1"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("membro revogando convite do dono: %v", err)
	}
	if err := svc.Revoke(ctx, stranger, "doOwner1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("não-membro: %v", err)
	}
	if err := svc.Revoke(ctx, member, "doMember"); err != nil {
		t.Fatalf("criador revoga o seu: %v", err)
	}
	if err := svc.Revoke(ctx, owner, "doOwner1"); err != nil { // MANAGE_GUILD (dono)
		t.Fatalf("dono revoga: %v", err)
	}
	if err := svc.Revoke(ctx, owner, "doOwner1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revogar de novo: %v", err)
	}
	if len(st.deleted) != 2 {
		t.Fatalf("apagados: %v", st.deleted)
	}
}

func TestListRequiresManageGuild(t *testing.T) {
	svc, _, _ := setup()
	ctx := context.Background()
	if _, err := svc.List(ctx, member, 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("membro comum: %v", err)
	}
	if _, err := svc.List(ctx, stranger, 1); !errors.Is(err, guild.ErrNotFound) {
		t.Fatalf("não-membro: %v", err)
	}
	if _, err := svc.List(ctx, owner, 1); err != nil {
		t.Fatal(err)
	}
}
