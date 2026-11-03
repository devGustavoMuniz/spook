package guild

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

// Dublês de moderação sobre o fakeStore dos testes de regra.
type modStore struct {
	*fakeStore
	bans    map[int64]bool
	nicks   map[int64]*string
	muted   map[int64]bool
	exists  map[int64]bool
	banners []int64
}

func newModStore() *modStore {
	f := newFake()
	// dono=1; 2 mod (cargo 5, BAN+MUTE+NICK); 3 baixo (cargo 2, BAN); 4 comum; 5 par do mod; 6 admin (cargo 5)
	f.members = map[int64]Access{
		1: {}, 2: {Perms: perm.BanMembers | perm.MuteMembers | perm.ManageNicknames | perm.DisconnectMembers | perm.DefaultEveryone, Highest: 5},
		3: {Perms: perm.BanMembers | perm.DefaultEveryone, Highest: 2}, 4: {Perms: perm.DefaultEveryone},
		5: {Perms: perm.BanMembers | perm.MuteMembers | perm.ManageNicknames | perm.DefaultEveryone, Highest: 5}, 6: {Perms: perm.Administrator, Highest: 5},
		7: {Perms: perm.ViewChannel}, // sem CHANGE_NICKNAME
	}
	return &modStore{fakeStore: f, bans: map[int64]bool{}, nicks: map[int64]*string{}, muted: map[int64]bool{}, exists: map[int64]bool{50: true}}
}

func (m *modStore) Ban(_ context.Context, _, u, _ int64, _ *string) (bool, error) {
	m.bans[u] = true
	_, was := m.members[u]
	delete(m.members, u)
	m.banners = append(m.banners, u)
	return was, nil
}
func (m *modStore) Unban(_ context.Context, _, u int64) error {
	if !m.bans[u] {
		return ErrBanNotFound
	}
	delete(m.bans, u)
	return nil
}
func (m *modStore) UserExists(_ context.Context, u int64) (bool, error) { return m.exists[u], nil }
func (m *modStore) Bans(context.Context, int64, int64, int) ([]Ban, error) {
	return nil, nil
}
func (m *modStore) SetNickname(_ context.Context, _, u int64, n *string) error {
	m.nicks[u] = n
	return nil
}
func (m *modStore) SetVoiceMuted(_ context.Context, _, u int64, v bool) error {
	m.muted[u] = v
	return nil
}
func (m *modStore) Member(ctx context.Context, g, u int64) (Member, error) {
	mem, err := m.fakeStore.Member(ctx, g, u)
	if err != nil {
		return mem, err
	}
	mem.Nickname, mem.VoiceMuted = m.nicks[u], m.muted[u]
	return mem, nil
}

type auditRec struct{ entries []audit.Entry }

func (a *auditRec) Record(_ context.Context, e audit.Entry) { a.entries = append(a.entries, e) }

func modSvc() (*Service, *modStore, *recorder, *auditRec) {
	st := newModStore()
	rec := &recorder{}
	svc := NewService(st, fakeChannels{}, nil, noAvatars{}, &seq{}, rec)
	a := &auditRec{}
	svc.SetAudit(a)
	return svc, st, rec, a
}

func TestBanHierarchyAndRules(t *testing.T) {
	tests := []struct {
		name          string
		actor, target int64
		kind          apperr.Kind // 0 = sucesso
	}{
		{"dono bane membro", 1, 4, 0},
		{"mod bane mais baixo", 2, 3, 0},
		{"mod bane comum", 2, 4, 0},
		{"mod bane quem nunca entrou", 2, 50, 0},
		{"baixo não bane mod", 3, 2, apperr.KindForbidden},
		{"par não bane par", 2, 5, apperr.KindForbidden},
		{"ninguém bane o dono", 2, 1, apperr.KindForbidden},
		{"administrador não bane o dono", 6, 1, apperr.KindForbidden},
		{"administrador não bane par de cargo", 6, 2, apperr.KindForbidden},
		{"sem BAN_MEMBERS", 4, 3, apperr.KindForbidden},
		{"a si mesmo", 2, 2, apperr.KindInvalid},
		{"usuário inexistente", 2, 99, apperr.KindNotFound},
		{"ator não-membro", 99, 2, apperr.KindNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, st, rec, aud := modSvc()
			err := svc.Ban(context.Background(), tt.actor, 1, tt.target, "motivo")
			if tt.kind != 0 {
				if !apperr.IsKind(err, tt.kind) && !errors.Is(err, ErrSelfModeration) {
					t.Fatalf("esperava erro %d, veio %v", tt.kind, err)
				}
				if len(st.banners) != 0 || len(rec.evs) != 0 || len(aud.entries) != 0 {
					t.Fatal("recusa não pode banir, publicar nem auditar")
				}
				return
			}
			if err != nil || len(st.banners) != 1 || st.banners[0] != tt.target {
				t.Fatalf("esperava banir %d: %v", tt.target, err)
			}
			if len(aud.entries) != 1 || aud.entries[0].Action != audit.MemberBan || aud.entries[0].Reason != "motivo" {
				t.Fatalf("auditoria: %+v", aud.entries)
			}
		})
	}
}

func TestBanReasonTooLong(t *testing.T) {
	svc, _, _, _ := modSvc()
	long := make([]rune, 513)
	for i := range long {
		long[i] = 'a'
	}
	if err := svc.Ban(context.Background(), 1, 1, 4, string(long)); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("motivo longo: %v", err)
	}
}

func TestBanPublishesRemovalForMembersOnly(t *testing.T) {
	svc, _, rec, _ := modSvc()
	if err := svc.Ban(context.Background(), 1, 1, 4, ""); err != nil {
		t.Fatal(err)
	}
	if got := rec.types(); len(got) != 2 || got[0] != events.GuildMemberRemove || got[1] != events.GuildDelete {
		t.Fatalf("eventos do ban de membro: %v", got)
	}
	svc2, _, rec2b, _ := modSvc()
	if err := svc2.Ban(context.Background(), 1, 1, 50, ""); err != nil {
		t.Fatal(err)
	}
	if len(rec2b.evs) != 0 {
		t.Fatalf("banir quem não é membro não publica nada: %v", rec2b.types())
	}
}

func TestUnban(t *testing.T) {
	svc, st, _, aud := modSvc()
	st.bans[4] = true
	if err := svc.Unban(context.Background(), 4, 1, 4); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("sem permissão: %v", err)
	}
	if err := svc.Unban(context.Background(), 2, 1, 4); err != nil {
		t.Fatal(err)
	}
	if err := svc.Unban(context.Background(), 2, 1, 4); !errors.Is(err, ErrBanNotFound) {
		t.Fatalf("segundo unban: %v", err)
	}
	if len(aud.entries) != 1 || aud.entries[0].Action != audit.MemberUnban {
		t.Fatalf("auditoria: %+v", aud.entries)
	}
}

func TestSetNickname(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name          string
		actor, target int64
		nick          string
		kind          apperr.Kind
		audited       bool
	}{
		{"o próprio muda", 4, 4, "Novo", 0, false},
		{"o próprio sem CHANGE_NICKNAME", 7, 7, "x", apperr.KindForbidden, false},
		{"limite de 32", 4, 4, "123456789012345678901234567890123", apperr.KindInvalid, false},
		{"caractere de controle", 4, 4, "a\x00b", apperr.KindInvalid, false},
		{"vazio remove", 4, 4, "   ", 0, false},
		{"mod muda o de comum", 2, 4, "Fulano", 0, true},
		{"comum não muda o de outro", 4, 3, "x", apperr.KindForbidden, false},
		{"mod não muda o do dono", 2, 1, "x", apperr.KindForbidden, false},
		{"mod não muda o de par", 2, 5, "x", apperr.KindForbidden, false},
		{"alvo inexistente", 2, 99, "x", apperr.KindNotFound, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, st, rec, aud := modSvc()
			_, err := svc.SetNickname(ctx, tt.actor, 1, tt.target, tt.nick)
			if tt.kind != 0 {
				if !apperr.IsKind(err, tt.kind) && (tt.kind != apperr.KindNotFound || !errors.Is(err, ErrMemberNotFound)) {
					t.Fatalf("esperava %d, veio %v", tt.kind, err)
				}
				if _, set := st.nicks[tt.target]; set || len(rec.evs) != 0 {
					t.Fatal("recusa não pode alterar nem publicar")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := rec.types(); len(got) != 1 || got[0] != events.GuildMemberUpdate {
				t.Fatalf("eventos: %v", got)
			}
			if (len(aud.entries) == 1) != tt.audited {
				t.Fatalf("auditoria = %+v, quer auditado=%v", aud.entries, tt.audited)
			}
		})
	}
}

func TestSetVoiceMuted(t *testing.T) {
	ctx := context.Background()
	svc, st, rec, aud := modSvc()
	if _, err := svc.SetVoiceMuted(ctx, 4, 1, 3, true); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("sem permissão: %v", err)
	}
	for _, target := range []int64{1, 5} {
		if _, err := svc.SetVoiceMuted(ctx, 2, 1, target, true); !apperr.IsKind(err, apperr.KindForbidden) {
			t.Fatalf("alvo %d (dono/par): %v", target, err)
		}
	}
	if _, err := svc.SetVoiceMuted(ctx, 2, 1, 2, true); !errors.Is(err, ErrSelfModeration) {
		t.Fatalf("a si mesmo: %v", err)
	}
	m, err := svc.SetVoiceMuted(ctx, 2, 1, 4, true)
	if err != nil || !m.VoiceMuted || !st.muted[4] {
		t.Fatalf("mutar: %+v %v", m, err)
	}
	if got := rec.types(); len(got) != 1 || got[0] != events.GuildMemberUpdate {
		t.Fatalf("eventos: %v", got)
	}
	if m, err := svc.SetVoiceMuted(ctx, 2, 1, 4, false); err != nil || m.VoiceMuted {
		t.Fatalf("desmutar: %+v %v", m, err)
	}
	if len(aud.entries) != 2 || aud.entries[0].Action != audit.VoiceMute || aud.entries[1].Action != audit.VoiceUnmute {
		t.Fatalf("auditoria: %+v", aud.entries)
	}
}

func TestModerationRateLimit(t *testing.T) {
	svc, _, _, _ := modSvc()
	svc.SetLimiter(denyAll{})
	if err := svc.Ban(context.Background(), 1, 1, 4, ""); !apperr.IsKind(err, apperr.KindRateLimited) {
		t.Fatalf("ban com limite estourado: %v", err)
	}
	if _, err := svc.SetNickname(context.Background(), 2, 1, 4, "x"); !apperr.IsKind(err, apperr.KindRateLimited) {
		t.Fatalf("apelido com limite estourado: %v", err)
	}
}

type denyAll struct{}

func (denyAll) Take(string) (bool, time.Duration) { return false, time.Second }

func TestCanModerateVoice(t *testing.T) {
	svc, _, _, _ := modSvc()
	ctx := context.Background()
	if err := svc.CanModerateVoice(ctx, 2, 1, 4, perm.DisconnectMembers); err != nil {
		t.Fatal(err)
	}
	if err := svc.CanModerateVoice(ctx, 2, 1, 5, perm.DisconnectMembers); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("par: %v", err)
	}
	if err := svc.CanModerateVoice(ctx, 3, 1, 4, perm.DisconnectMembers); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("sem permissão: %v", err)
	}
}
